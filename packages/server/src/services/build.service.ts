import { Worker } from 'worker_threads';
import ts from 'typescript';
import { BUILD_WORKER_SOURCE } from './build.worker';
import type { BuildProviderInfo, BuildRequestInfo, ComfyWorkflow } from './build-script-api';
import type { RuntimeParam, FileMeta } from './param.types';
import type { ExecutionProvider } from './providers/types';

/** 不得进入脚本 ctx 的请求头（大小写不敏感） */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
]);

/**
 * 将 query / headers 中可结构化克隆的字符串值抽出。
 * 嵌套对象、数字、undefined 一律丢弃，避免 workerData 克隆失败或泄露非预期结构。
 * @param source Express query 或 headers 的原始映射
 * @param omitKeys 需要剔除的键（已小写）
 * @returns 仅含 string / string[] 的映射
 */
function pickStringMap(
  source: Record<string, unknown>,
  omitKeys?: Set<string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [rawKey, value] of Object.entries(source)) {
    const key = rawKey.toLowerCase();
    if (omitKeys?.has(key)) continue;
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    // 仅保留全是字符串的数组（如重复 query / 多值头）
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 从 Express 风格请求对象提取可进 worker 的 HTTP 快照。
 * Authorization / Cookie 等敏感头会被剥离。
 * @param req Express Request（按字段鸭子类型，避免服务层硬依赖 express 类型）
 * @returns 请求快照
 */
export function toBuildRequestInfo(req: {
  method: string;
  path: string;
  originalUrl: string;
  query: object;
  headers: object;
  ip?: string;
  protocol: string;
  hostname: string;
}): BuildRequestInfo {
  // Express IncomingHttpHeaders / ParsedQs 不是 Record<string, unknown>，此处收窄后再过滤
  const headers = pickStringMap(req.headers as Record<string, unknown>, SENSITIVE_HEADER_NAMES);
  const contentTypeRaw = headers['content-type'];
  const contentType = typeof contentTypeRaw === 'string'
    ? contentTypeRaw
    : Array.isArray(contentTypeRaw) ? (contentTypeRaw[0] ?? null) : null;
  // req.path 在挂载子路由上是相对路径；脚本需要完整请求路径，从 originalUrl 去掉 query
  const qIndex = req.originalUrl.indexOf('?');
  const fullPath = qIndex === -1 ? req.originalUrl : req.originalUrl.slice(0, qIndex);
  return {
    method: req.method,
    path: fullPath || req.path,
    originalUrl: req.originalUrl,
    // query 键同样小写，脚本按稳定约定读取
    query: pickStringMap(req.query as Record<string, unknown>),
    headers,
    ip: typeof req.ip === 'string' && req.ip !== '' ? req.ip : null,
    protocol: req.protocol,
    hostname: req.hostname,
    contentType,
  };
}

/**
 * 将执行提供商实例转为可进 worker 的快照。
 * config / baseUrl 含明文凭据，仅脚本可见。
 * @param provider 已解析的执行提供商
 * @returns 提供商快照
 */
export function toBuildProviderInfo(provider: ExecutionProvider): BuildProviderInfo {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    concurrency: provider.concurrency,
    trackingMode: provider.trackingMode,
    config: provider.getConfig(),
    baseUrl: provider.getBaseUrl(),
    displayBaseUrl: provider.getDisplayBaseUrl(),
  };
}

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
 * @param request HTTP 请求快照（敏感头已剥离）
 * @param provider 本次执行解析到的提供商快照
 * @param timeoutMs 超时毫秒数，默认 5000
 * @returns 构建结果
 */
export function runBuildScript(
  script: string,
  params: Record<string, unknown>,
  workflow: ComfyWorkflow,
  baseParams: RuntimeParam[],
  filesMeta: Record<string, FileMeta[]>,
  request: BuildRequestInfo,
  provider: BuildProviderInfo,
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
        workerData: { jsCode, params, workflow, baseParams, filesMeta, request, provider },
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
