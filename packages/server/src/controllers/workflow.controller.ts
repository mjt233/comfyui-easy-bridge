import { Request, Response, NextFunction } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { WorkflowService } from '../services/workflow.service';
import { executeWorkflow, applyAliases, processMediaParams } from '../services/executor.service';
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
      try {
        const wf = workflowService.update(id, req.body);
        res.json(wf);
      } catch (err: unknown) {
        if (err instanceof Error && err.message?.includes('UNIQUE constraint failed')) {
          res.status(409).json({ error: 'ID already exists', code: 'id_conflict' });
          return;
        }
        throw err;
      }
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
      const { nodeId, fieldName, alias, label, paramType, defaultValue } = req.body;
      if (!nodeId || !fieldName) {
        res.status(400).json({ error: 'nodeId and fieldName are required', code: 'missing_parameter' });
        return;
      }
      // 空字符串 alias 视为未提供
      const normalizedAlias = typeof alias === 'string' && alias.trim() === '' ? null : alias ?? null;
      const hasDefault = defaultValue !== undefined && defaultValue !== null;
      if (normalizedAlias == null && !hasDefault) {
        res.status(400).json({ error: 'alias or defaultValue is required', code: 'missing_parameter' });
        return;
      }
      try {
        const param = workflowService.addParam({
          workflowId: id,
          nodeId,
          fieldName,
          alias: normalizedAlias,
          label,
          paramType,
          defaultValue: defaultValue === undefined ? null : defaultValue,
        });
        res.status(201).json(param);
      } catch (err: unknown) {
        if (err instanceof Error && err.message?.includes('UNIQUE constraint failed')) {
          res.status(409).json({ error: 'Alias already exists', code: 'alias_conflict' });
          return;
        }
        if (err instanceof Error && /alias|defaultValue|required/i.test(err.message)) {
          res.status(400).json({ error: err.message, code: 'missing_parameter' });
          return;
        }
        throw err;
      }
    },

    updateParam(req: Request, res: Response): void {
      try {
        const body = { ...req.body } as {
          alias?: string | null;
          label?: string | null;
          paramType?: string;
          defaultValue?: string | null;
        };
        // 空字符串 alias 视为清除别名
        if (typeof body.alias === 'string' && body.alias.trim() === '') {
          body.alias = null;
        }
        const param = workflowService.updateParam(Number(req.params.paramId), body);
        res.json(param);
      } catch (err: unknown) {
        if (err instanceof Error && err.message?.includes('UNIQUE constraint failed')) {
          res.status(409).json({ error: 'Alias already exists', code: 'alias_conflict' });
          return;
        }
        if (err instanceof Error && /alias|defaultValue|required|not found/i.test(err.message)) {
          res.status(400).json({ error: err.message, code: 'missing_parameter' });
          return;
        }
        throw err;
      }
    },

    deleteParam(req: Request, res: Response): void {
      workflowService.deleteParam(Number(req.params.paramId));
      res.status(204).send();
    },

    async execute(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
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

        // 解析 multipart 或 JSON 请求
        const isMultipart = req.is('multipart/form-data');
        let aliasValues: Record<string, string>;
        let uploadedFiles: Record<string, { buffer: Buffer; originalname: string; mimetype: string }[]>;

        if (isMultipart) {
          aliasValues = JSON.parse(req.body.params || '{}');
          const multerFiles = (req.files as Express.Multer.File[]) || [];
          uploadedFiles = {};
          for (const f of multerFiles) {
            if (!uploadedFiles[f.fieldname]) uploadedFiles[f.fieldname] = [];
            uploadedFiles[f.fieldname].push({
              buffer: f.buffer,
              originalname: f.originalname,
              mimetype: f.mimetype,
            });
          }
        } else {
          aliasValues = req.body as Record<string, string>;
          uploadedFiles = {};
        }

        // 处理媒体文件上传
        const finalAliasValues = await processMediaParams(params, aliasValues, uploadedFiles, baseUrl);

        // 将别名值注入工作流 JSON（缺失参数跳过，保留默认值）
        const modifiedJson = applyAliases(wf.rawJson, params, finalAliasValues);

        // 检查并发数
        const concurrencyStr = settingsService.get('comfyui_concurrency');
        const concurrency = concurrencyStr ? parseInt(concurrencyStr, 10) : 1;
        const pendingCount = taskService.countByStatus('pending');

        if (pendingCount >= concurrency) {
          // 超过并发限制，进入排队
          const task = taskService.create({
            workflowId: wf.id,
            workflowName: wf.name,
            aliasValues: JSON.stringify(finalAliasValues),
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

        const result = await executeWorkflow(wf.rawJson, params, finalAliasValues, baseUrl);

        const task = taskService.create({
          workflowId: wf.id,
          workflowName: wf.name,
          aliasValues: JSON.stringify(finalAliasValues),
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
      } catch (err) {
        next(err);
      }
    },
  };
}
