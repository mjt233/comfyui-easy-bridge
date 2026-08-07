import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createProvidersRoutes } from './providers.routes';
import { createSettingsRoutes } from './settings.routes';
import { SettingsService } from '../services/settings.service';
import { onProviderChange } from '../services/providers/provider.service';

/**
 * 构造 :memory: 测试库（含 providers / settings / workflows 三表）与 Express 子应用。
 * 将 auth_enabled 置 '0' 关闭认证，让路由测试聚焦业务行为。
 * @returns Express 子应用与 Drizzle 数据库实例
 */
function buildApp(): {
  app: express.Express;
  db: BetterSQLite3Database<typeof schema>;
} {
  const sqlite = new Database(':memory:');
  // 与 schema.ts / 迁移 DDL 保持一致的最小建表语句
  sqlite.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  const db = drizzle(sqlite, { schema });
  // 关闭认证：createAuthMiddleware 依赖 settings 表读取 auth_enabled
  new SettingsService(db).set('auth_enabled', '0');

  const app = express();
  app.use(express.json());
  app.use('/api/providers', createProvidersRoutes(db));
  app.use('/api/settings', createSettingsRoutes(db));
  return { app, db };
}

describe('Provider API', () => {
  let app: express.Express;
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    const built = buildApp();
    app = built.app;
    db = built.db;
  });

  // 清理全局 fetch stub，避免测试连接用例污染其他用例
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates and lists providers with masked apiKey', async () => {
    // 创建 runninghub 实例
    const created = await supertest(app)
      .post('/api/providers')
      .send({ name: 'RH', type: 'runninghub', config: { apiKey: 'sk-12345678', gpuSize: '24G' }, concurrency: 2 });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('RH');

    // 列表返回摘要：apiKey 打码且不含完整密钥
    const listed = await supertest(app).get('/api/providers');
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].config.apiKey).toContain('****');
    expect(listed.body[0].config.apiKey).not.toContain('sk-12345678');
  });

  it('rejects invalid input with 400', async () => {
    const res = await supertest(app)
      .post('/api/providers')
      .send({ name: '', type: 'comfyui', config: { baseUrl: 'x' } });
    expect(res.status).toBe(400);

    // gpuSize 非法值应被拒绝（400），而非静默回退 24G
    const badGpu = await supertest(app)
      .post('/api/providers')
      .send({ name: 'RH', type: 'runninghub', config: { apiKey: 'k', gpuSize: '12G' } });
    expect(badGpu.status).toBe(400);
  });

  it('tests connection with given config via /test', async () => {
    // 桩掉全局 fetch，避免真实网络请求；返回非 2xx 使结果确定
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const res = await supertest(app)
      .post('/api/providers/test')
      .send({ type: 'comfyui', config: { baseUrl: 'http://unreachable.invalid' } });
    expect(res.status).toBe(200);
    expect(typeof res.body.ok).toBe('boolean');
    expect(res.body.ok).toBe(false);
  });

  it('deletes provider and clears workflow refs', async () => {
    // 先创建实例，再插入引用它的工作流
    const created = await supertest(app)
      .post('/api/providers')
      .send({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' } });
    const providerId = created.body.id as string;

    db.insert(schema.workflows).values({
      id: 'wf1',
      name: 'test',
      rawJson: '{}',
      providerId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    // 删除实例成功
    const del = await supertest(app).delete(`/api/providers/${providerId}`);
    expect(del.status).toBe(204);

    // 工作流的 provider_id 被置空（回退默认）
    const wf = db.select().from(schema.workflows).where(eq(schema.workflows.id, 'wf1')).get();
    expect(wf).toBeDefined();
    expect(wf?.providerId).toBeNull();
  });

  it('blocks deleting the default provider with 409', async () => {
    const created = await supertest(app)
      .post('/api/providers')
      .send({ name: 'Default', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' } });
    const providerId = created.body.id as string;

    // 通过 settings 接口将实例设为全局默认
    const setDefault = await supertest(app)
      .put('/api/settings')
      .send({ key: 'default_provider_id', value: providerId });
    expect(setDefault.status).toBe(200);

    // 默认实例禁止删除
    const del = await supertest(app).delete(`/api/providers/${providerId}`);
    expect(del.status).toBe(409);
  });

  it('updates provider', async () => {
    const created = await supertest(app)
      .post('/api/providers')
      .send({ name: 'Old', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' } });
    const providerId = created.body.id as string;

    const res = await supertest(app)
      .put(`/api/providers/${providerId}`)
      .send({ name: 'New', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' } });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
  });

  it('returns 404 on missing provider for PUT and DELETE', async () => {
    const put = await supertest(app)
      .put('/api/providers/nonexistent')
      .send({ name: 'x', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' } });
    expect(put.status).toBe(404);

    const del = await supertest(app).delete('/api/providers/nonexistent');
    expect(del.status).toBe(404);
  });

  it('supports partial update with name only and keeps existing config', async () => {
    const created = await supertest(app)
      .post('/api/providers')
      .send({ name: 'Original', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' } });
    const providerId = created.body.id as string;

    // 仅更新 name，不携带 config；应沿用原配置而非 400
    const res = await supertest(app)
      .put(`/api/providers/${providerId}`)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    // 原配置保持不变
    expect(res.body.config.baseUrl).toBe('http://localhost:8188');
  });

  it('returns 404 on testById for missing provider', async () => {
    const res = await supertest(app).post('/api/providers/nonexistent/test');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('provider_not_found');
  });

  it('tests connectivity of a saved provider via testById', async () => {
    // 桩掉 fetch，模拟 system_stats 返回 2xx（连通）
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const created = await supertest(app)
      .post('/api/providers')
      .send({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' } });
    const providerId = created.body.id as string;

    const res = await supertest(app).post(`/api/providers/${providerId}/test`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: '连接成功' });
  });

  it('returns ok:false with invalid-config message when saved config is corrupt', async () => {
    // 直接插入 config 损坏的行（非法 JSON），绕过创建接口的校验
    db.insert(schema.providers).values({
      id: 'corrupt-1',
      name: 'Corrupt',
      type: 'comfyui',
      config: '{not-json',
      concurrency: 1,
      enabled: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    const res = await supertest(app).post('/api/providers/corrupt-1/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, message: 'Provider config is invalid' });
  });

  it('notifies provider change when default provider is switched via settings', async () => {
    const created = await supertest(app)
      .post('/api/providers')
      .send({ name: 'Default', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' } });
    const providerId = created.body.id as string;

    // 订阅模块级变更总线，验证默认切换触发重建通知
    const listener = vi.fn();
    const unsubscribe = onProviderChange(listener);
    try {
      const res = await supertest(app)
        .put('/api/settings')
        .send({ key: 'default_provider_id', value: providerId });
      expect(res.status).toBe(200);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      // 清理订阅，避免影响其他用例
      unsubscribe();
    }
  });
});
