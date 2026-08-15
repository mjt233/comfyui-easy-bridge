import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createAuthController } from '../controllers/auth.controller';
import { createAuthMiddleware } from '../middleware/auth';

export function createAuthRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createAuthController(db);
  const auth = createAuthMiddleware(db);

  router.post('/login', controller.login);
  router.get('/status', controller.status);
  // 修改密码需要已登录（Bearer token），旧密码校验通过后更新哈希
  router.post('/change-password', auth, controller.changePassword);

  return router;
}
