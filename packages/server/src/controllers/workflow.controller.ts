import { Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { WorkflowService } from '../services/workflow.service';
import { executeWorkflow } from '../services/executor.service';
import { SettingsService } from '../services/settings.service';

export function createWorkflowController(db: BetterSQLite3Database<typeof schema>) {
  const workflowService = new WorkflowService(db);
  const settingsService = new SettingsService(db);

  return {
    list(_req: Request, res: Response): void {
      res.json(workflowService.list());
    },

    getById(req: Request, res: Response): void {
      const wf = workflowService.getById(req.params.id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const params = workflowService.getParams(req.params.id);
      res.json({ ...wf, params });
    },

    create(req: Request, res: Response): void {
      const { id, name, rawJson } = req.body;
      if (!id || !name || !rawJson) {
        res.status(400).json({ error: 'id, name, and rawJson are required', code: 'missing_parameter' });
        return;
      }
      const wf = workflowService.create({ id, name, rawJson });
      res.status(201).json(wf);
    },

    update(req: Request, res: Response): void {
      const existing = workflowService.getById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const wf = workflowService.update(req.params.id, req.body);
      res.json(wf);
    },

    delete(req: Request, res: Response): void {
      const existing = workflowService.getById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      workflowService.delete(req.params.id);
      res.status(204).send();
    },

    addParam(req: Request, res: Response): void {
      const existing = workflowService.getById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const { nodeId, fieldName, alias, label } = req.body;
      if (!nodeId || !fieldName || !alias) {
        res.status(400).json({ error: 'nodeId, fieldName, and alias are required', code: 'missing_parameter' });
        return;
      }
      try {
        const param = workflowService.addParam({ workflowId: req.params.id, nodeId, fieldName, alias, label });
        res.status(201).json(param);
      } catch (err: unknown) {
        if (err instanceof Error && err.message?.includes('UNIQUE constraint failed')) {
          res.status(409).json({ error: 'Alias already exists', code: 'alias_conflict' });
          return;
        }
        throw err;
      }
    },

    updateParam(req: Request, res: Response): void {
      const param = workflowService.updateParam(Number(req.params.paramId), req.body);
      res.json(param);
    },

    deleteParam(req: Request, res: Response): void {
      workflowService.deleteParam(Number(req.params.paramId));
      res.status(204).send();
    },

    async execute(req: Request, res: Response): Promise<void> {
      const wf = workflowService.getById(req.params.id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const params = workflowService.getParams(req.params.id);
      const baseUrl = settingsService.get('comfyui_base_url');
      if (!baseUrl) {
        res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
        return;
      }
      try {
        const result = await executeWorkflow(wf.rawJson, params, req.body, baseUrl);
        res.json(result);
      } catch (err: unknown) {
        if (err instanceof Error) {
          res.status(502).json({ error: err.message, code: 'comfyui_unreachable' });
          return;
        }
        throw err;
      }
    },
  };
}
