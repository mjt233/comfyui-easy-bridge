import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createProvidersController } from '../controllers/providers.controller';
import { createAuthMiddleware } from '../middleware/auth';

/**
 * 提供商管理路由工厂。
 * @param db Drizzle 数据库实例
 * @returns 挂载了提供商 CRUD / 测试连接端点的 Router
 */
export function createProvidersRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createProvidersController(db);
  const auth = createAuthMiddleware(db);

  router.get('/', auth, controller.list);
  router.post('/', auth, controller.create);
  // 注意：/test 需在 /:id 动态路由之前注册，避免被当作实例 ID 捕获
  router.post('/test', auth, controller.testByConfig);
  router.put('/:id', auth, controller.update);
  router.delete('/:id', auth, controller.delete);
  router.post('/:id/test', auth, controller.testById);

  return router;
}
