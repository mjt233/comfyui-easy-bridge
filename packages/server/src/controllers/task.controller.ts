import { Request, Response } from 'express';
import { Readable } from 'stream';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from '../services/task.service';
import { SettingsService } from '../services/settings.service';
import { submitPromptRequest, interruptRequest } from '../services/providers/shared';
import { parseHistoryOutputs } from '../services/comfyui.service';

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
 * 从 ComfyUI /history/{promptId} 拉取并解析输出文件列表。
 * 网络错误或非 2xx 时返回空数组（软失败，不抛错）。
 * @param baseUrl ComfyUI 基础 URL
 * @param promptId ComfyUI prompt_id
 * @returns 解析到的输出文件；失败或无输出时为 []
 */
async function fetchOutputsFromHistory(baseUrl: string, promptId: string): Promise<OutputFile[]> {
  try {
    // 回源 ComfyUI history，供 completed 任务本地尚未回填时补全
    const res = await fetch(`${baseUrl}/history/${promptId}`);
    if (!res.ok) return [];
    const data: unknown = await res.json();
    return parseHistoryOutputs(data, promptId);
  } catch {
    return [];
  }
}

/** 任务日志控制器 */
export function createTaskController(db: BetterSQLite3Database<typeof schema>) {
  const taskService = new TaskService(db);
  const settingsService = new SettingsService(db);

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
     * 当任务已 completed 但本地 outputFiles 仍为空时，向 ComfyUI /history 回源补全；
     * 首次为空则阻塞 2s 再重试一次，成功后回填 DB。
     */
    async listOutputFiles(req: Request, res: Response): Promise<void> {
      const task = taskService.getById(req.params.taskId as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      const baseUrl = settingsService.get('comfyui_base_url');
      const mode = settingsService.get('output_download_mode') || 'proxy';
      let files: OutputFile[] = [];
      // 优先使用本地已持久化的输出列表
      if (task.outputFiles) {
        try {
          const parsed = JSON.parse(task.outputFiles);
          files = Array.isArray(parsed) ? parsed : [];
        } catch {
          files = [];
        }
      }

      // 读路径兜底：completed 且本地为空时，从 ComfyUI history 补全（最多 2 次）
      if (
        files.length === 0
        && task.status === 'completed'
        && task.promptId
        && baseUrl
      ) {
        // 第 1 次回源
        files = await fetchOutputsFromHistory(baseUrl, task.promptId);
        // 首次为空则阻塞后重试一次，覆盖 history 瞬时未就绪
        if (files.length === 0) {
          await sleep(outputHistoryBackfillConfig.retryDelayMs);
          files = await fetchOutputsFromHistory(baseUrl, task.promptId);
        }
        // 回填 DB，供后续请求与任务日志直接读取
        if (files.length > 0) {
          taskService.updateOutputFiles(task.id, files);
        }
      }

      const result = files.map(f => ({
        ...f,
        url: mode === 'direct' && baseUrl
          ? `${baseUrl}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=${f.type}`
          : `/api/tasks/${task.id}/output-files/${encodeURIComponent(f.filename)}?subfolder=${encodeURIComponent(f.subfolder)}&type=${f.type}`,
      }));
      res.json({ files: result });
    },

    /** 代理下载输出文件（从 ComfyUI 流式转发） */
    async downloadOutputFile(req: Request, res: Response): Promise<void> {
      const task = taskService.getById(req.params.taskId as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      const baseUrl = settingsService.get('comfyui_base_url');
      if (!baseUrl) {
        res.status(502).json({ error: 'ComfyUI base URL not configured', code: 'comfyui_unreachable' });
        return;
      }

      const filename = req.params.filename as string;
      const subfolder = (req.query.subfolder as string) || '';
      const type = (req.query.type as string) || 'output';

      const comfyUrl = `${baseUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;

      try {
        const comfyRes = await fetch(comfyUrl);
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

    /** 立即提交 queued 任务（无视并发限制） */
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
      const baseUrl = settingsService.get('comfyui_base_url');
      if (!baseUrl) {
        res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
        return;
      }
      if (!task.comfyuiRequestBody) {
        res.status(400).json({ error: 'Task has no request body', code: 'missing_parameter' });
        return;
      }
      const result = await submitPromptRequest(baseUrl, task.comfyuiRequestBody);
      if (result.success) {
        taskService.updateStatus(task.id, {
          status: 'pending',
          promptId: result.promptId ?? undefined,
          comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
        });
        res.json({ task_id: task.id, status: 'pending', comfyui_response: result.comfyuiResponse });
      } else {
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
      // pending 任务：向 ComfyUI 发送中断请求，轮询确认停止后标记为失败
      const baseUrl = settingsService.get('comfyui_base_url');
      if (baseUrl) {
        // 传入 promptId：中断后轮询 /queue 确认任务已停止执行，仍在执行则重试中断
        await interruptRequest(baseUrl, task.promptId ?? undefined);
      }
      taskService.updateStatus(task.id, {
        status: 'failed',
        errorMessage: 'Cancelled by user',
      });
      res.json({ task_id: task.id, status: 'failed' });
    },
  };
}
