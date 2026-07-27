import { Router } from 'express';
import multer from 'multer';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createWorkflowController } from '../controllers/workflow.controller';
import { createAuthMiddleware } from '../middleware/auth';

export function createWorkflowRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createWorkflowController(db);
  const auth = createAuthMiddleware(db);
  const upload = multer({ storage: multer.memoryStorage() });

  router.post('/:id/execute', upload.any(), controller.execute);

  router.get('/', auth, controller.list);
  router.post('/', auth, controller.create);
  router.get('/:id', auth, controller.getById);
  router.put('/:id', auth, controller.update);
  router.delete('/:id', auth, controller.delete);
  router.post('/:id/params', auth, controller.addParam);
  router.put('/:id/params/:paramId', auth, controller.updateParam);
  router.delete('/:id/params/:paramId', auth, controller.deleteParam);

  return router;
}
