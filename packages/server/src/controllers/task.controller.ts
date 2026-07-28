import { Request, Response } from 'express';
import { Readable } from 'stream';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from '../services/task.service';
import { SettingsService } from '../services/settings.service';
import { submitPrompt, interruptPrompt } from '../services/executor.service';

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

    /** 获取任务的输出文件列表 */
    async listOutputFiles(req: Request, res: Response): Promise<void> {
      const task = taskService.getById(req.params.taskId as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      const baseUrl = settingsService.get('comfyui_base_url');
      const mode = settingsService.get('output_download_mode') || 'proxy';
      let files: OutputFile[] = [];
      if (task.outputFiles) {
        try {
          const parsed = JSON.parse(task.outputFiles);
          files = Array.isArray(parsed) ? parsed : [];
        } catch {
          files = [];
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
      const result = await submitPrompt(task.comfyuiRequestBody, baseUrl);
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
      // pending 任务：向 ComfyUI 发送中断请求，再标记为失败
      const baseUrl = settingsService.get('comfyui_base_url');
      if (baseUrl) {
        await interruptPrompt(baseUrl);
      }
      taskService.updateStatus(task.id, {
        status: 'failed',
        errorMessage: 'Cancelled by user',
      });
      res.json({ task_id: task.id, status: 'failed' });
    },
  };
}
