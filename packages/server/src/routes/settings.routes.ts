import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createSettingsController } from '../controllers/settings.controller';
import { createAuthMiddleware } from '../middleware/auth';

export function createSettingsRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createSettingsController(db);
  const auth = createAuthMiddleware(db);

  router.get('/', auth, controller.getAll);
  router.put('/', auth, controller.update);

  return router;
}
