import { Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService } from '../services/task.service';

/** 任务日志控制器 */
export function createTaskController(db: BetterSQLite3Database<typeof schema>) {
  const taskService = new TaskService(db);

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
  };
}
