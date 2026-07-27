import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createAuthController } from '../controllers/auth.controller';

export function createAuthRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createAuthController(db);

  router.post('/login', controller.login);
  router.get('/status', controller.status);

  return router;
}
