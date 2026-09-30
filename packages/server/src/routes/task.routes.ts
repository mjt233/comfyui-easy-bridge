import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createTaskController } from '../controllers/task.controller';
import { createAuthMiddleware } from '../middleware/auth';

/** 创建任务日志路由（需认证） */
export function createTaskRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createTaskController(db);
  const auth = createAuthMiddleware(db);

  router.get('/', auth, controller.list);
  router.delete('/completed', auth, controller.clearCompleted);
  // 修改排队任务的执行目标（人工干预自动调度；仅 queued 任务）
  router.patch('/:taskId/provider', auth, controller.updateProvider);
  // 立即提交（插队）：无视并发上限直接投递到指定的具体实例
  router.post('/:taskId/submit', auth, controller.submit);
  router.post('/:taskId/cancel', auth, controller.cancel);
  router.get('/:taskId/output-files', auth, controller.listOutputFiles);
  router.get('/:taskId/output-files/:filename', auth, controller.downloadOutputFile);
  router.get('/:taskId', auth, controller.getById);

  return router;
}
