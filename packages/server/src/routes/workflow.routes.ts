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

  // 静态路径（export/import）需在 :id 动态路由之前注册
  router.post('/export', auth, controller.exportWorkflows);
  router.post('/import', auth, upload.single('file'), controller.importWorkflows);

  router.post('/:id/execute', upload.any(), controller.execute);

  router.get('/', auth, controller.list);
  router.post('/', auth, controller.create);
  router.get('/:id', auth, controller.getById);
  router.put('/:id', auth, controller.update);
  router.delete('/:id', auth, controller.delete);
  router.post('/:id/params', auth, controller.addParam);
  router.put('/:id/params/:paramId', auth, controller.updateParam);
  router.delete('/:id/params/:paramId', auth, controller.deleteParam);

  // 附件管理
  router.get('/:id/attachments', auth, controller.listAttachments);
  router.post('/:id/attachments', auth, upload.single('file'), controller.uploadAttachment);
  router.get('/:id/attachments/:attachmentId/download', auth, controller.downloadAttachment);
  router.delete('/:id/attachments/:attachmentId', auth, controller.deleteAttachment);

  return router;
}
