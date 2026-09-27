import { Request, Response } from 'express';
import { Readable } from 'stream';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from '../services/task.service';
import { SettingsService } from '../services/settings.service';
import { ProviderService } from '../services/providers/provider.service';
import type { ExecutionProvider } from '../services/providers/types';
import { parseHistoryOutputs, toOutputFiles, drainProviderQueue, drainGroupQueues, getActiveDispatcher } from '../services/execution.service';

/**
 * completed 任务本地 outputFiles 为空时，向 ComfyUI /history 回源的重试配置。
 * 测试可覆盖 `retryDelayMs`，避免路由测试真实等待 2s。
 */
export const outputHistoryBackfillConfig = {
  /**
   * 首次回源为空后的重试间隔（毫秒）。
   * 生产默认 2000；覆盖 history 瞬时未就绪的竞态。
   */
  retryDelayMs: 2000,
};

/**
 * 延迟指定毫秒数。
 * @param ms 等待时长（毫秒）
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * 解析任务已持久化的输出文件列表。
 * @param outputFiles 任务的 output_files JSON（可能为 null 或内容损坏）
 * @returns 输出文件列表；无法解析时返回空数组
 */
function parseStoredOutputFiles(outputFiles: string | null): OutputFile[] {
  if (!outputFiles) return [];
  try {
    const parsed: unknown = JSON.parse(outputFiles);
    // 仅接受数组形态；元素结构由写入方（跟踪器）保证
    return Array.isArray(parsed) ? (parsed as OutputFile[]) : [];
  } catch {
    return [];
  }
}

/**
 * 在任务已持久化的输出文件列表里按文件名查找平台绝对下载地址。
 * 平台产出（RunningHub 结果查询 V2）落库时带 `url`，据此可跳过 `/view` 拼装直接回源。
 * @param outputFiles 任务的 output_files JSON
 * @param filename 目标文件名
 * @returns 平台绝对地址；未找到或该条目无地址时返回 null
 */
function findStoredOutputUrl(outputFiles: string | null, filename: string): string | null {
  const hit = parseStoredOutputFiles(outputFiles)
    .find(f => f.filename === filename && typeof f.url === 'string' && f.url !== '');
  return hit?.url ?? null;
}

/**
 * 从执行提供商拉取并解析输出文件列表。
 * 实现了平台状态查询能力的提供商（RunningHub）走平台结果接口，
 * 其余走执行端 history；两者与终态判定共用同一数据源，避免口径不一致。
 * 网络错误或非 2xx 时返回空数组（软失败，不抛错）。
 * @param provider 任务使用的执行提供商
 * @param promptId 执行端 prompt_id（RunningHub 同时是平台 taskId）
 * @returns 解析到的输出文件；失败或无输出时为 []
 */
async function fetchOutputsFromProvider(provider: ExecutionProvider, promptId: string): Promise<OutputFile[]> {
  try {
    // 平台状态接口优先：RunningHub 的产出解析与终态判定口径保持一致
    if (provider.queryTaskState) {
      const state = await provider.queryTaskState(promptId);
      return state.kind === 'completed' ? toOutputFiles(state.files) : [];
    }
    // 回源执行端 history，供 completed 任务本地尚未回填时补全
    const data = await provider.fetchHistory(promptId);
    return parseHistoryOutputs(data, promptId);
  } catch {
    return [];
  }
}

/** 任务日志控制器 */
export function createTaskController(db: BetterSQLite3Database<typeof schema>) {
  const taskService = new TaskService(db);
  const settingsService = new SettingsService(db);
  const providerService = new ProviderService(db);

  /**
   * 触发分组队列调度（fire-and-forget）。
   * 每次调用解析当前活跃的调度器实例，避免捕获陈旧引用；
   * 执行服务未启动时退回全局入口（其在无调度器时静默返回）。
   * @param reason 日志用的触发原因
   */
  function drainDispatcherSafely(reason: string): void {
    const dispatcher = getActiveDispatcher();
    const drain = dispatcher ? dispatcher.drainAll() : drainGroupQueues();
    void drain.catch(err => {
      console.error(`[TaskController] group drain after ${reason} error`, err);
    });
  }

  /**
   * 按任务解析「实际执行任务的」提供商实例：
   * 1. 分组任务：actualProviderId 指向真正执行任务的成员实例（中断、输出回源、下载均需它）；
   * 2. 普通任务：providerId 即实际执行实例；
   * 3. 都缺失时回退全局默认。
   * 注意不能直接用 providerId：分组任务的该字段是分组本身（无执行端点）。
   * @param task 任务行（含 providerId 与 actualProviderId）
   * @returns 实例化 provider 或 null
   */
  function resolveProviderForTask(task: { providerId: string | null; actualProviderId: string | null }): ExecutionProvider | null {
    // 实际执行实例优先（历史任务即使实例已停用也按原实例回源/下载）
    if (task.actualProviderId) {
      const p = providerService.getProviderById(task.actualProviderId);
      if (p) return p;
    }
    // 普通任务：providerId 指向的即为实际执行实例；分组任务在此场景下实例化的是分组，不能用于执行端交互
    if (task.providerId) {
      const p = providerService.getProviderById(task.providerId);
      if (p && p.type !== 'group') return p;
    }
    return providerService.getDefaultProvider();
  }

  return {
    /** 获取所有任务日志列表 */
    list(_req: Request, res: Response): void {
      res.json(taskService.list());
    },

    /** 按 ID 获取任务日志详情 */
    getById(req: Request, res: Response): void {
      const task = taskService.getById(req.params.taskId as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      res.json(task);
    },

    /** 清理所有已完成和失败的任务日志 */
    clearCompleted(_req: Request, res: Response): void {
      const count = taskService.clearCompleted();
      res.json({ deleted: count });
    },

    /**
     * 获取任务的输出文件列表。
     * 当任务已 completed 但本地 outputFiles 仍为空时，向执行端回源补全；
     * 首次为空则阻塞 2s 再重试一次，成功后回填 DB。
     */
    async listOutputFiles(req: Request, res: Response): Promise<void> {
      const task = taskService.getById(req.params.taskId as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      const provider = resolveProviderForTask(task);
      const mode = settingsService.get('output_download_mode') || 'proxy';
      // 优先使用本地已持久化的输出列表
      let files: OutputFile[] = parseStoredOutputFiles(task.outputFiles);

      // 读路径兜底：completed 且本地为空时，从执行端回源补全（最多 2 次）
      if (
        files.length === 0
        && task.status === 'completed'
        && task.promptId
        && provider
      ) {
        // 第 1 次回源
        files = await fetchOutputsFromProvider(provider, task.promptId);
        // 首次为空则阻塞后重试一次，覆盖产出瞬时未就绪
        if (files.length === 0) {
          await sleep(outputHistoryBackfillConfig.retryDelayMs);
          files = await fetchOutputsFromProvider(provider, task.promptId);
        }
        // 回填 DB，供后续请求与任务日志直接读取
        if (files.length > 0) {
          taskService.updateOutputFiles(task.id, files);
        }
      }

      const result = files.map(f => {
        // 直连模式下优先使用平台给出的绝对地址；无地址且实例可用时按执行端 /view 拼装
        const directUrl = f.url ?? (provider ? provider.buildOutputViewUrl(f) : null);
        return {
          ...f,
          url: mode === 'direct' && directUrl
            ? directUrl
            : `/api/tasks/${task.id}/output-files/${encodeURIComponent(f.filename)}?subfolder=${encodeURIComponent(f.subfolder)}&type=${f.type}`,
        };
      });
      res.json({ files: result });
    },

    /**
     * 代理下载输出文件。
     * 平台产出带绝对地址时直接回源该地址（RH COS 预签名地址无需鉴权头），
     * 否则按执行端 `/view` 拼装后流式转发。
     */
    async downloadOutputFile(req: Request, res: Response): Promise<void> {
      const task = taskService.getById(req.params.taskId as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      const provider = resolveProviderForTask(task);

      const filename = req.params.filename as string;
      const subfolder = (req.query.subfolder as string) || '';
      const type = (req.query.type as string) || 'output';

      // 解析回源地址：平台绝对地址优先，其次执行端 /view；两者都没有时无法下载
      let sourceUrl = findStoredOutputUrl(task.outputFiles, filename);
      if (!sourceUrl && provider) {
        sourceUrl = provider.buildOutputViewUrl({ filename, subfolder, type });
      }
      if (!sourceUrl) {
        res.status(502).json({ error: 'No execution provider configured', code: 'comfyui_unreachable' });
        return;
      }

      try {
        const comfyRes = await fetch(sourceUrl);
        if (!comfyRes.ok) {
          res.status(comfyRes.status).json({ error: 'ComfyUI error', code: 'comfyui_unreachable' });
          return;
        }
        const contentType = comfyRes.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        const safeFilename = filename.replace(/["\\]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
        const body = comfyRes.body;
        if (body) {
          const reader = body.getReader();
          const readable = new Readable({
            async read() {
              const { done, value } = await reader.read();
              if (done) {
                this.push(null);
              } else {
                this.push(Buffer.from(value));
              }
            },
          });
          readable.pipe(res);
        } else {
          res.end();
        }
      } catch {
        res.status(502).json({ error: 'Failed to fetch from ComfyUI', code: 'comfyui_unreachable' });
      }
    },

    /** 立即提交 queued 任务（普通实例无视并发限制直接提交；分组任务触发一次自动分配） */
    async submit(req: Request, res: Response): Promise<void> {
      const task = taskService.getById(req.params.taskId as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      if (task.status !== 'queued') {
        res.status(400).json({ error: 'Task is not in queued status', code: 'invalid_status' });
        return;
      }
      // 分组任务由调度器挑选成员实例，手动「立即提交」等价于立即触发一次自动分配
      if (task.providerId) {
        const owner = providerService.getById(task.providerId);
        if (owner?.type === 'group') {
          const dispatcher = getActiveDispatcher();
          if (!dispatcher) {
            res.status(503).json({ error: 'Dispatch service is not running', code: 'provider_not_configured' });
            return;
          }
          await dispatcher.drainGroup(owner.id);
          // 调度可能未成功（成员并发已满或均不可用）：据实返回任务当前状态
          const after = taskService.getById(task.id);
          res.json({
            task_id: task.id,
            status: after?.status ?? 'queued',
            error_message: after?.errorMessage ?? undefined,
          });
          return;
        }
      }
      const provider = resolveProviderForTask(task);
      if (!provider) {
        res.status(400).json({ error: 'No execution provider configured', code: 'provider_not_configured' });
        return;
      }
      if (!task.comfyuiRequestBody) {
        res.status(400).json({ error: 'Task has no request body', code: 'missing_parameter' });
        return;
      }
      const result = await provider.submitPrompt(task.comfyuiRequestBody);
      if (result.success) {
        taskService.updateStatus(task.id, {
          status: 'pending',
          promptId: result.promptId ?? undefined,
          comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
        });
        // 记录实际执行实例，保证跟踪器与并发统计口径一致
        taskService.setActualProvider(task.id, {
          actualProviderId: provider.id,
          actualProviderName: provider.name,
          promptId: result.promptId ?? '',
        });
        res.json({ task_id: task.id, status: 'pending', comfyui_response: result.comfyuiResponse });
      } else {
        // 手动提交失败：把原始错误与执行端原始响应体输出到控制台，便于定位失败原因
        console.error(
          `[TaskController] manual submit failed, task ${task.id}: ${result.errorMessage ?? 'Submit failed'}`,
        );
        console.error(
          `[TaskController] task ${task.id} original response: `
          + `${result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : '<none>'}`,
        );
        taskService.updateStatus(task.id, {
          status: 'failed',
          errorMessage: result.errorMessage ?? 'Submit failed',
          comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
        });
        res.json({ task_id: task.id, status: 'failed', error_message: result.errorMessage });
      }
    },

    /** 中断任务执行 */
    async cancel(req: Request, res: Response): Promise<void> {
      const task = taskService.getById(req.params.taskId as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      // queued 任务直接标记为失败，无需通知 ComfyUI
      if (task.status === 'queued') {
        taskService.updateStatus(task.id, {
          status: 'failed',
          errorMessage: 'Cancelled by user',
        });
        // 队列少了一个任务：立即触发一次分发，让后续排队任务尽快投递
        drainDispatcherSafely('queue cancel');
        res.json({ task_id: task.id, status: 'failed' });
        return;
      }
      if (task.status !== 'pending') {
        res.status(400).json({
          error: 'Only queued or pending tasks can be cancelled',
          code: 'invalid_status',
        });
        return;
      }
      // pending 任务：向执行端发送中断请求，确认停止后再置终态
      const provider = resolveProviderForTask(task);
      if (provider) {
        // 传入 promptId：中断后轮询 /queue 确认任务已停止执行，仍在执行则重试中断
        const stopped = await provider.interrupt(task.promptId ?? undefined);
        if (!stopped) {
          // 未能确认执行端已停止：保持 pending，交由跟踪器（WS 事件/兜底轮询）收敛，
          // 避免 DB 已置终态而执行端仍在运行导致并发判断失真
          res.status(502).json({
            error: 'Failed to confirm interruption',
            code: 'interrupt_unconfirmed',
          });
          return;
        }
      }
      taskService.updateStatus(task.id, {
        status: 'failed',
        errorMessage: 'Cancelled by user',
      });
      // 槽位已释放：主动触发该实例的队列调度，让排队中的任务立即提交（不阻塞响应）
      if (provider) {
        void drainProviderQueue(provider.id).catch(err => {
          console.error('[TaskController] drain after cancel error', err);
        });
        // 该实例可能是分组成员：同时触发分组调度，让分组队列中的任务尽快投递
        drainDispatcherSafely('cancel');
      }
      res.json({ task_id: task.id, status: 'failed' });
    },
  };
}
