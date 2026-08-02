import { Request, Response, NextFunction } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { WorkflowService } from '../services/workflow.service';
import { AttachmentService } from '../services/attachment.service';
import { WorkflowIOService } from '../services/workflow-io.service';
import {
  executeWorkflow,
  applyAliases,
  processMediaParams,
  resolveSubmittedAliasValues,
  toRuntimeParams,
} from '../services/executor.service';
import { runBuildScript } from '../services/build.service';
import { BUILD_SCRIPT_API_DTS, type ComfyWorkflow } from '../services/build-script-api';
import { getNodeInfoCached, generateBuildDts, toNodeReferenceList } from '../services/node-info.service';
import { SettingsService } from '../services/settings.service';
import { TaskService } from '../services/task.service';

export function createWorkflowController(db: BetterSQLite3Database<typeof schema>) {
  const workflowService = new WorkflowService(db);
  const settingsService = new SettingsService(db);
  const taskService = new TaskService(db);
  const attachmentService = new AttachmentService(db);
  const workflowIOService = new WorkflowIOService(db);

  return {
    /** 返回动态构建脚本 API 的 d.ts 文本（供 Monaco 注册类型提示） */
    async getBuildApiTypes(_req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        // 有 object_info 时返回动态版（含节点类补全），否则降级为静态版
        const nodeInfo = await getNodeInfoCached(db);
        res.type('text/plain').send(nodeInfo ? generateBuildDts(nodeInfo) : BUILD_SCRIPT_API_DTS);
      } catch (err) {
        next(err);
      }
    },

    /** 返回 ComfyUI 节点速查表（供构建脚本编辑器搜索节点类型） */
    async getNodeReference(_req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const nodeInfo = await getNodeInfoCached(db);
        // ComfyUI 未配置/不可达时返回 503，前端据此提示
        if (!nodeInfo) {
          res.status(503).json({
            error: 'ComfyUI 节点信息不可用：请确认已在设置中配置 ComfyUI 地址且服务可达',
            code: 'comfyui_unreachable',
          });
          return;
        }
        res.json({ nodes: toNodeReferenceList(nodeInfo) });
      } catch (err) {
        next(err);
      }
    },

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
      res.json({ ...wf, buildScriptEnabled: wf.buildScriptEnabled === 1, params });
    },

    /** 保存动态构建脚本与启用状态 */
    saveBuildScript(req: Request, res: Response): void {
      const id = req.params.id as string;
      const existing = workflowService.getById(id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const body = req.body as { script?: unknown; enabled?: unknown };
      if (typeof body.script !== 'string') {
        res.status(400).json({ error: 'script is required', code: 'missing_parameter' });
        return;
      }
      const wf = workflowService.updateBuildScript(id, {
        script: body.script,
        enabled: body.enabled === true,
      });
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      // 与 getById 返回结构保持一致：补充 params，供前端直接作为 WorkflowDetail 使用
      const params = workflowService.getParams(id);
      res.json({ ...wf, buildScriptEnabled: wf.buildScriptEnabled === 1, params });
    },

    /** 模拟构建：脚本构建 + 按声明配置上传媒体 + 注入，返回最终 JSON 与参数配置 */
    async simulateBuild(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const id = req.params.id as string;
        const wf = workflowService.getById(id);
        if (!wf) {
          res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
          return;
        }
        // multipart 或 JSON：script/params 与上传文件
        const isMultipart = req.is('multipart/form-data');
        let body: { script?: unknown; params?: unknown };
        const filesMeta: Record<string, { buffer: Buffer; originalname: string; mimetype: string; size: number }[]> = {};
        if (isMultipart) {
          // 与 execute 一致：params 字段为 JSON 序列化的别名值
          body = {
            script: req.body.script,
            params: JSON.parse(req.body.params || '{}') as Record<string, unknown>,
          };
          const multerFiles = (req.files as Express.Multer.File[]) || [];
          for (const f of multerFiles) {
            if (!filesMeta[f.fieldname]) filesMeta[f.fieldname] = [];
            filesMeta[f.fieldname].push({
              buffer: f.buffer,
              originalname: f.originalname,
              mimetype: f.mimetype,
              // size 供动态构建脚本 filesMeta 使用（FileMeta 要求）
              size: f.size,
            });
          }
        } else {
          body = req.body as { script?: unknown; params?: unknown };
        }

        if (typeof body.script !== 'string' || body.script.trim() === '') {
          res.status(400).json({ error: 'script is required', code: 'missing_parameter' });
          return;
        }
        const aliasParams = (body.params && typeof body.params === 'object' && !Array.isArray(body.params))
          ? body.params as Record<string, unknown>
          : {};

        const baseUrl = settingsService.get('comfyui_base_url');
        if (!baseUrl) {
          res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
          return;
        }
        const baseParams = toRuntimeParams(workflowService.getParams(id));

        // 脚本构建（声明工作流与参数配置）
        const buildResult = await runBuildScript(
          body.script,
          aliasParams,
          JSON.parse(wf.rawJson) as ComfyWorkflow,
          baseParams,
          filesMeta,
        );
        if (!buildResult.ok) {
          res.status(400).json({ error: buildResult.error, code: buildResult.code });
          return;
        }
        const effectiveParams = buildResult.params ?? baseParams;

        // 按声明配置上传媒体（真实上传，模拟与真实执行一致）
        const uploadedAliasValues = await processMediaParams(effectiveParams, aliasParams, filesMeta, baseUrl);

        // 注入并返回
        const finalJson = applyAliases(JSON.stringify(buildResult.workflow), effectiveParams, uploadedAliasValues);
        res.json({ json: finalJson, params: effectiveParams });
      } catch (err) {
        next(err);
      }
    },

    create(req: Request, res: Response): void {
      const { id, name, rawJson } = req.body;
      if (!id || !name || !rawJson) {
        res.status(400).json({ error: 'id, name, and rawJson are required', code: 'missing_parameter' });
        return;
      }
      // description 可选（Markdown 文本），非字符串时忽略
      const description = typeof req.body.description === 'string' ? req.body.description : '';
      const wf = workflowService.create({ id, name, rawJson, description });
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
      // 先清理附件磁盘文件，再删除工作流（附件行由 FK 级联删除）
      attachmentService.deleteByWorkflow(id);
      workflowService.delete(id);
      res.status(204).send();
    },

    /** 复制工作流：克隆本体、参数、动态构建脚本与附件，名称追加 " (copy)" */
    duplicate(req: Request, res: Response): void {
      const id = req.params.id as string;
      const existing = workflowService.getById(id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const wf = workflowIOService.duplicate(id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      res.status(201).json(wf);
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

        // 解析 multipart 或 JSON 请求（值可能是 string/number/boolean）
        const isMultipart = req.is('multipart/form-data');
        let aliasValues: Record<string, unknown>;
        let uploadedFiles: Record<string, { buffer: Buffer; originalname: string; mimetype: string; size: number }[]>;

        if (isMultipart) {
          aliasValues = JSON.parse(req.body.params || '{}') as Record<string, unknown>;
          const multerFiles = (req.files as Express.Multer.File[]) || [];
          uploadedFiles = {};
          for (const f of multerFiles) {
            if (!uploadedFiles[f.fieldname]) uploadedFiles[f.fieldname] = [];
            uploadedFiles[f.fieldname].push({
              buffer: f.buffer,
              originalname: f.originalname,
              mimetype: f.mimetype,
              // size 供动态构建脚本 filesMeta 使用（FileMeta 要求）
              size: f.size,
            });
          }
        } else {
          aliasValues = req.body as Record<string, unknown>;
          uploadedFiles = {};
        }

        // 静态参数转运行时形态（脚本声明的基底）
        const baseParams = toRuntimeParams(params);

        // 【动态构建】先运行脚本，声明工作流与参数配置（仅当已保存且启用）
        let buildSource = wf.rawJson;
        let effectiveParams = baseParams;
        if (wf.buildScriptEnabled && wf.buildScript) {
          const buildResult = await runBuildScript(
            wf.buildScript,
            aliasValues,
            JSON.parse(wf.rawJson) as ComfyWorkflow,
            baseParams,
            uploadedFiles,
          );
          if (!buildResult.ok) {
            // 构建失败：记录 failed 任务，不提交 ComfyUI
            const failedTask = taskService.create({
              workflowId: wf.id,
              workflowName: wf.name,
              aliasValues: JSON.stringify(aliasValues),
              comfyuiUrl: `${baseUrl}/prompt`,
              comfyuiRequestBody: null,
              comfyuiResponse: null,
              promptId: null,
            });
            taskService.updateStatus(failedTask.id, {
              status: 'failed',
              errorMessage: `Dynamic build failed [${buildResult.code ?? 'build_script_error'}]: ${buildResult.error}`,
            });
            res.json({ task_id: failedTask.id, status: 'failed', comfyui_response: null });
            return;
          }
          buildSource = JSON.stringify(buildResult.workflow);
          effectiveParams = buildResult.params ?? baseParams;
        }

        // 【媒体上传】按有效参数配置（含脚本声明的媒体参数与 fileIndex）上传文件
        const finalAliasValues = await processMediaParams(effectiveParams, aliasValues, uploadedFiles, baseUrl);

        // 将别名值注入工作流 JSON（缺失参数跳过，保留默认值，作用于构建后的 JSON）
        const modifiedJson = applyAliases(buildSource, effectiveParams, finalAliasValues);

        // 任务日志记录转换后、实际提交到 ComfyUI 的别名参数
        const submittedAliasValues = resolveSubmittedAliasValues(effectiveParams, finalAliasValues);
        const submittedAliasValuesJson = JSON.stringify(submittedAliasValues);

        // 检查并发数
        const concurrencyStr = settingsService.get('comfyui_concurrency');
        const concurrency = concurrencyStr ? parseInt(concurrencyStr, 10) : 1;
        const pendingCount = taskService.countByStatus('pending');

        if (pendingCount >= concurrency) {
          // 超过并发限制，进入排队
          const task = taskService.create({
            workflowId: wf.id,
            workflowName: wf.name,
            aliasValues: submittedAliasValuesJson,
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

        const result = await executeWorkflow(buildSource, effectiveParams, finalAliasValues, baseUrl);

        const task = taskService.create({
          workflowId: wf.id,
          workflowName: wf.name,
          aliasValues: submittedAliasValuesJson,
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

    /**
     * 多选导出工作流为 ZIP（含参数与附件）
     * @param req 请求体 { ids: string[] }
     * @param res ZIP 文件响应
     */
    async exportWorkflows(req: Request, res: Response): Promise<void> {
      const ids = (req.body?.ids ?? []) as unknown;
      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ error: 'ids array is required', code: 'missing_parameter' });
        return;
      }
      const buffer = await workflowIOService.exportWorkflows(ids as string[]);
      const filename = `workflows-export-${Date.now()}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    },

    /**
     * 批量导入工作流 ZIP
     * @param req multipart 请求，字段 file 为 ZIP 文件
     * @param res 导入结果摘要
     */
    async importWorkflows(req: Request, res: Response): Promise<void> {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        res.status(400).json({ error: 'zip file is required', code: 'missing_parameter' });
        return;
      }
      try {
        const result = await workflowIOService.importWorkflows(file.buffer);
        res.json(result);
      } catch (err: unknown) {
        if (err instanceof Error && /manifest/i.test(err.message)) {
          res.status(400).json({ error: err.message, code: 'missing_parameter' });
          return;
        }
        throw err;
      }
    },

    /**
     * 上传工作流附件
     * @param req multipart 请求，字段 file 为附件
     * @param res 新建的附件记录
     */
    uploadAttachment(req: Request, res: Response): void {
      const id = req.params.id as string;
      const wf = workflowService.getById(id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        res.status(400).json({ error: 'file is required', code: 'missing_parameter' });
        return;
      }
      const attachment = attachmentService.create(id, {
        filename: file.originalname,
        buffer: file.buffer,
        mimetype: file.mimetype ?? null,
      });
      res.status(201).json(attachment);
    },

    /**
     * 列出工作流附件
     * @param req 路径参数 id 为工作流 ID
     * @param res 附件记录列表
     */
    listAttachments(req: Request, res: Response): void {
      const id = req.params.id as string;
      const wf = workflowService.getById(id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      res.json(attachmentService.list(id));
    },

    /**
     * 下载工作流附件
     * @param req 路径参数 id / attachmentId
     * @param res 附件二进制响应
     */
    downloadAttachment(req: Request, res: Response): void {
      const id = req.params.id as string;
      const attachmentId = Number(req.params.attachmentId);
      const attachment = attachmentService.getById(attachmentId);
      // 附件不存在或不属于该工作流
      if (!attachment || attachment.workflowId !== id) {
        res.status(404).json({ error: 'Attachment not found', code: 'attachment_not_found' });
        return;
      }
      let buffer: Buffer;
      try {
        buffer = attachmentService.readBuffer(attachment);
      } catch {
        // 磁盘文件缺失
        res.status(404).json({ error: 'Attachment file not found', code: 'attachment_not_found' });
        return;
      }
      // 中文文件名使用 RFC 5987 编码
      const encoded = encodeURIComponent(attachment.filename);
      res.setHeader('Content-Type', attachment.mimetype ?? 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
      );
      res.send(buffer);
    },

    /**
     * 删除工作流附件（磁盘文件 + 记录行）
     * @param req 路径参数 id / attachmentId
     * @param res 204
     */
    deleteAttachment(req: Request, res: Response): void {
      const id = req.params.id as string;
      const attachmentId = Number(req.params.attachmentId);
      const attachment = attachmentService.getById(attachmentId);
      if (!attachment || attachment.workflowId !== id) {
        res.status(404).json({ error: 'Attachment not found', code: 'attachment_not_found' });
        return;
      }
      attachmentService.delete(attachmentId);
      res.status(204).send();
    },
  };
}
