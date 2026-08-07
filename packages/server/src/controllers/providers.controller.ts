import { Request, Response, NextFunction } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { ProviderService } from '../services/providers/provider.service';
import type { ProviderConfig, ProviderType } from '../services/providers/types';

/**
 * 解析请求体中的配置为 ProviderConfig（不做校验，由 service.validateInput 完成）。
 * @param type 提供商类型
 * @param raw 原始 config
 * @returns 解析后的配置（字段缺失时回退空值/默认值）
 */
function parseConfigBody(type: ProviderType, raw: unknown): ProviderConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (type === 'runninghub') {
    return {
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : '',
      gpuSize: obj.gpuSize === '48G' ? '48G' : obj.gpuSize === '24G' ? '24G' : '24G',
    };
  }
  return { baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : '' };
}

/** 提供商管理控制器：路由层与 ProviderService 之间的薄适配层 */
export function createProvidersController(db: BetterSQLite3Database<typeof schema>) {
  const providerService = new ProviderService(db);

  return {
    /** 列出全部提供商实例（含脱敏摘要） */
    list(_req: Request, res: Response): void {
      res.json(providerService.list().map((r) => providerService.toSummary(r)));
    },

    /** 新建提供商实例；校验失败返回 400 */
    create(req: Request, res: Response): void {
      const body = req.body as { name?: unknown; type?: unknown; config?: unknown; concurrency?: unknown; enabled?: unknown };
      const type = body.type === 'runninghub' ? 'runninghub' : body.type === 'comfyui' ? 'comfyui' : null;
      if (!type) {
        res.status(400).json({ error: 'invalid type', code: 'missing_parameter' });
        return;
      }
      const config = parseConfigBody(type, body.config);
      const validation = providerService.validateInput({
        name: body.name as string,
        type,
        config,
        concurrency: body.concurrency as number,
        enabled: body.enabled as boolean,
      });
      if (!validation.ok) {
        res.status(400).json({ error: validation.error, code: 'missing_parameter' });
        return;
      }
      const rec = providerService.create(validation.value);
      // 通知共享事件总线，触发执行服务重建 provider 列表
      providerService.notifyChange();
      res.status(201).json(providerService.toSummary(rec));
    },

    /** 更新提供商实例；实例不存在返回 404，校验失败返回 400 */
    update(req: Request, res: Response): void {
      const id = req.params.id as string;
      const existing = providerService.getById(id);
      if (!existing) {
        res.status(404).json({ error: 'Provider not found', code: 'provider_not_found' });
        return;
      }
      const body = req.body as { name?: unknown; type?: unknown; config?: unknown; concurrency?: unknown; enabled?: unknown };
      // 未显式指定 type 时沿用现有类型
      const type = body.type === 'runninghub' ? 'runninghub' : body.type === 'comfyui' ? 'comfyui' : existing.type as ProviderType;
      // 未显式提供 config 时不覆盖（沿用旧配置）
      const config = body.config !== undefined ? parseConfigBody(type, body.config) : undefined;
      const validation = providerService.validateInput({
        name: body.name as string,
        type,
        config,
        concurrency: body.concurrency as number,
        enabled: body.enabled as boolean,
      });
      if (!validation.ok) {
        res.status(400).json({ error: validation.error, code: 'missing_parameter' });
        return;
      }
      // 上面已确认实例存在，update 不会返回 null
      const rec = providerService.update(id, validation.value)!;
      providerService.notifyChange();
      res.json(providerService.toSummary(rec));
    },

    /** 删除提供商实例；实例不存在返回 404，默认实例返回 409 */
    delete(req: Request, res: Response): void {
      const id = req.params.id as string;
      const result = providerService.delete(id);
      if (!result.deleted) {
        const status = result.error === 'provider_not_found' ? 404 : 409;
        res.status(status).json({ error: result.error, code: result.error ?? 'provider_delete_failed' });
        return;
      }
      providerService.notifyChange();
      res.status(204).send();
    },

    /** 用未保存配置测试连通性（测试失败不阻止保存） */
    async testByConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const body = req.body as { type?: unknown; config?: unknown };
        const type = body.type === 'runninghub' ? 'runninghub' : 'comfyui';
        const config = parseConfigBody(type, body.config);
        const result = await providerService.testConnection(config);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },

    /** 测试已保存实例的连通性 */
    async testById(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const row = providerService.getById(req.params.id as string);
        if (!row) {
          res.status(404).json({ error: 'Provider not found', code: 'provider_not_found' });
          return;
        }
        // getConfig 可能返回 null（config 损坏时），此时直接报不可达
        const config = providerService.getConfig(row);
        if (!config) {
          res.json({ ok: false, message: 'Provider config is invalid' });
          return;
        }
        const result = await providerService.testConnection(config);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  };
}
