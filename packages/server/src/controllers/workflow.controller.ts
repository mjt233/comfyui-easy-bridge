import { Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { WorkflowService } from '../services/workflow.service';
import { executeWorkflow, applyAliases } from '../services/executor.service';
import { SettingsService } from '../services/settings.service';
import { TaskService } from '../services/task.service';

export function createWorkflowController(db: BetterSQLite3Database<typeof schema>) {
  const workflowService = new WorkflowService(db);
  const settingsService = new SettingsService(db);
  const taskService = new TaskService(db);

  return {
    list(_req: Request, res: Response): void {
      res.json(workflowService.list());
    },

    getById(req: Request, res: Response): void {
      const id = req.params.id as string;
      const wf = workflowService.getById(id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const params = workflowService.getParams(id);
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
      const id = req.params.id as string;
      const existing = workflowService.getById(id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const wf = workflowService.update(id, req.body);
      res.json(wf);
    },

    delete(req: Request, res: Response): void {
      const id = req.params.id as string;
      const existing = workflowService.getById(id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      workflowService.delete(id);
      res.status(204).send();
    },

    addParam(req: Request, res: Response): void {
      const id = req.params.id as string;
      const existing = workflowService.getById(id);
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
        const param = workflowService.addParam({ workflowId: id, nodeId, fieldName, alias, label });
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
      const id = req.params.id as string;
      const wf = workflowService.getById(id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const params = workflowService.getParams(id);
      const baseUrl = settingsService.get('comfyui_base_url');
      if (!baseUrl) {
        res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
        return;
      }
      const aliasValues = req.body as Record<string, string>;

      // 先验证参数（applyAliases 会检查缺失参数并抛异常）
      const modifiedJson = applyAliases(wf.rawJson, params, aliasValues);

      // 检查并发数
      const concurrencyStr = settingsService.get('comfyui_concurrency');
      const concurrency = concurrencyStr ? parseInt(concurrencyStr, 10) : 1;
      const pendingCount = taskService.countByStatus('pending');

      if (pendingCount >= concurrency) {
        // 超过并发限制，进入排队
        const task = taskService.create({
          workflowId: wf.id,
          workflowName: wf.name,
          aliasValues: JSON.stringify(aliasValues),
          comfyuiUrl: `${baseUrl}/prompt`,
          comfyuiRequestBody: JSON.stringify({ prompt: JSON.parse(modifiedJson) }),
          comfyuiResponse: null,
          promptId: null,
        });
        // 覆盖为 queued 状态
        taskService.updateStatus(task.id, { status: 'queued' });
        res.json({
          task_id: task.id,
          status: 'queued',
          comfyui_response: null,
        });
        return;
      }

      const result = await executeWorkflow(wf.rawJson, params, aliasValues, baseUrl);

      const task = taskService.create({
        workflowId: wf.id,
        workflowName: wf.name,
        aliasValues: JSON.stringify(aliasValues),
        comfyuiUrl: `${baseUrl}/prompt`,
        comfyuiRequestBody: JSON.stringify({ prompt: JSON.parse(modifiedJson) }),
        comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : null,
        promptId: result.promptId,
      });

      if (!result.success) {
        taskService.updateStatus(task.id, {
          status: 'failed',
          errorMessage: result.errorMessage ?? 'Unknown error',
        });
      }

      res.json({
        task_id: task.id,
        status: task.status,
        comfyui_response: result.comfyuiResponse,
      });
    },
  };
}
