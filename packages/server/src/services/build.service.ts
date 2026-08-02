import { Worker } from 'worker_threads';
import ts from 'typescript';
import { BUILD_WORKER_SOURCE } from './build.worker';
import type { ComfyWorkflow } from './build-script-api';
import type { RuntimeParam, FileMeta } from './param.types';

/** 构建脚本最大结果体积（字节） */
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

/** 构建结果 */
export interface BuildScriptResult {
  /** 是否成功 */
  ok: boolean;
  /** 构建后的工作流对象（ok=true 时） */
  workflow?: ComfyWorkflow;
  /** 脚本声明的参数配置（ok=true 时；脚本未返回时为 undefined，由调用方回退 DB 静态参数） */
  params?: RuntimeParam[];
  /** 错误信息（ok=false 时） */
  error?: string;
  /** 错误码 */
  code?: 'build_script_error' | 'build_script_timeout';
}

/**
 * 运行动态构建脚本。
 * 主线程转译 TS → JS 后交给 worker 线程执行（worker 内无法解析第三方包）。
 * 超时后 terminate() 硬杀 worker，不影响服务进程。
 * @param script 用户 TS 脚本源码
 * @param params 用户提交参数
 * @param workflow 原始工作流对象（将被深拷贝）
 * @param baseParams DB 静态参数配置副本（脚本可据此声明返回）
 * @param filesMeta 上传文件元数据（按别名分组，脚本据此判断文件数量）
 * @param timeoutMs 超时毫秒数，默认 5000
 * @returns 构建结果
 */
export function runBuildScript(
  script: string,
  params: Record<string, unknown>,
  workflow: ComfyWorkflow,
  baseParams: RuntimeParam[],
  filesMeta: Record<string, FileMeta[]>,
  timeoutMs = 5000,
): Promise<BuildScriptResult> {
  return new Promise<BuildScriptResult>((resolve) => {
    let settled = false;

    // 主线程转译（typescript 包在 worker 内不可解析）
    let jsCode: string;
    try {
      const transpileResult = ts.transpileModule(script, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
        // reportDiagnostics 是 TranspileOptions 的顶层选项（不是 compilerOptions），
        // 放在 compilerOptions 内时 TS 5.9 不会返回语法错误诊断
        reportDiagnostics: true,
      });
      // transpileModule 语法错误不抛异常，需显式读取 diagnostics
      if (transpileResult.diagnostics && transpileResult.diagnostics.length > 0) {
        const first = transpileResult.diagnostics[0];
        const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
        resolve({
          ok: false,
          code: 'build_script_error',
          error: `Transpile error: ${message}`,
        });
        return;
      }
      jsCode = transpileResult.outputText;
    } catch (err) {
      resolve({
        ok: false,
        code: 'build_script_error',
        error: err instanceof Error ? err.message : 'Transpile failed',
      });
      return;
    }

    // 创建 worker；workerData 不可结构化克隆时会同步抛错，需捕获并转为构建错误
    let worker: Worker;
    try {
      worker = new Worker(BUILD_WORKER_SOURCE, {
        eval: true,
        workerData: { jsCode, params, workflow, baseParams, filesMeta },
      });
    } catch (err) {
      resolve({
        ok: false,
        code: 'build_script_error',
        error: err instanceof Error ? err.message : 'Failed to start build worker',
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => undefined);
      resolve({ ok: false, code: 'build_script_timeout', error: 'Script execution timed out' });
    }, timeoutMs);

    worker.on('message', (msg: { ok: boolean; workflow?: ComfyWorkflow; params?: RuntimeParam[]; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!msg.ok) {
        resolve({ ok: false, code: 'build_script_error', error: msg.error ?? 'Unknown build error' });
        return;
      }
      // 结果体积限制
      try {
        if (JSON.stringify(msg.workflow).length > MAX_RESULT_BYTES) {
          resolve({ ok: false, code: 'build_script_error', error: 'Build result too large' });
          return;
        }
      } catch {
        resolve({ ok: false, code: 'build_script_error', error: 'Build result is not serializable' });
        return;
      }
      // params 可能为 undefined（脚本省略 params 时），由调用方回退 baseParams
      resolve({ ok: true, workflow: msg.workflow, params: msg.params });
    });

    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: 'build_script_error', error: err instanceof Error ? err.message : String(err) });
    });

    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: 'build_script_error', error: `Worker exited with code ${code}` });
    });
  });
}
