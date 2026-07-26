import { Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService } from '../services/task.service';
import { SettingsService } from '../services/settings.service';
import { submitPrompt } from '../services/executor.service';

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
  };
}
