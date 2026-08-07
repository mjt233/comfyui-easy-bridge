import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createTagsController } from '../controllers/tags.controller';
import { createAuthMiddleware } from '../middleware/auth';

/**
 * 标签管理路由工厂。
 * @param db Drizzle 数据库实例
 * @returns 挂载了标签 CRUD 端点的 Router
 */
export function createTagsRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createTagsController(db);
  const auth = createAuthMiddleware(db);

  router.get('/', auth, controller.list);
  router.post('/', auth, controller.create);
  router.put('/:id', auth, controller.update);
  router.delete('/:id', auth, controller.delete);

  return router;
}
