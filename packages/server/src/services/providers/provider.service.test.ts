import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../models/schema';
import { ProviderService } from './provider.service';

/**
 * 构造 :memory: 测试库（含 providers / settings / workflows 三表）。
 * @returns Drizzle 数据库实例
 */
function buildDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, provider_id TEXT);
  `);
  return drizzle(sqlite, { schema });
}

describe('ProviderService', () => {
  let db: ReturnType<typeof buildDb>;
  let service: ProviderService;

  beforeEach(() => {
    db = buildDb();
    service = new ProviderService(db);
  });

  // 每个用例结束后清理全局 fetch stub，避免用例间相互污染
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates and lists providers with parsed config', () => {
    const rec = service.create({ name: 'RH', type: 'runninghub', config: { apiKey: 'k', gpuSize: '24G' }, concurrency: 2 });
    const list = service.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('RH');
    expect(service.getConfig(rec)).toEqual({ apiKey: 'k', gpuSize: '24G' });
  });

  it('instantiates provider by id', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' }, concurrency: 1 });
    const provider = service.getProviderById(rec.id);
    expect(provider?.getBaseUrl()).toBe('http://localhost:8188');
    expect(provider?.trackingMode).toBe('websocket');
  });

  it('resolves default provider from settings', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' }, concurrency: 1 });
    service.setDefault(rec.id);
    expect(service.getDefaultProvider()?.id).toBe(rec.id);
  });

  it('resolveWorkflowProvider prefers workflow providerId over default', () => {
    const a = service.create({ name: 'A', type: 'comfyui', config: { baseUrl: 'http://a' }, concurrency: 1 });
    const b = service.create({ name: 'B', type: 'comfyui', config: { baseUrl: 'http://b' }, concurrency: 1 });
    service.setDefault(a.id);
    db.insert(schema.workflows).values({ id: 'w1', name: 'wf', rawJson: '{}', providerId: b.id, createdAt: 'x', updatedAt: 'x' }).run();
    expect(service.resolveWorkflowProvider('w1')?.getBaseUrl()).toBe('http://b');
    expect(service.resolveWorkflowProvider('missing')?.getBaseUrl()).toBe('http://a');
  });

  it('getNodeInfoProvider only returns comfyui type', () => {
    const rh = service.create({ name: 'RH', type: 'runninghub', config: { apiKey: 'k', gpuSize: '24G' }, concurrency: 1 });
    service.setDefault(rh.id);
    expect(service.getNodeInfoProvider()).toBeNull();
    const cu = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' }, concurrency: 1 });
    expect(service.getNodeInfoProvider()?.id).toBe(cu.id);
  });

  it('blocks deleting the default provider', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' }, concurrency: 1 });
    service.setDefault(rec.id);
    const result = service.delete(rec.id);
    expect(result.deleted).toBe(false);
    expect(service.getById(rec.id)).not.toBeNull();
  });

  it('clears workflow providerId when deleting a referenced provider', () => {
    const rec = service.create({ name: 'A', type: 'comfyui', config: { baseUrl: 'http://a' }, concurrency: 1 });
    db.insert(schema.workflows).values({ id: 'w1', name: 'wf', rawJson: '{}', providerId: rec.id, createdAt: 'x', updatedAt: 'x' }).run();
    const result = service.delete(rec.id);
    expect(result.deleted).toBe(true);
    const wf = db.select().from(schema.workflows).where(eq(schema.workflows.id, 'w1')).get();
    expect(wf?.providerId).toBeNull();
  });

  it('validates provider input', () => {
    expect(service.validateInput({ name: '', type: 'comfyui', config: { baseUrl: 'http://x' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'x', type: 'nope', config: { baseUrl: 'http://x' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'x', type: 'comfyui', config: { baseUrl: '' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'x', type: 'runninghub', config: { apiKey: '', gpuSize: '24G' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'x', type: 'runninghub', config: { apiKey: 'k', gpuSize: '99G' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'x', type: 'comfyui', config: { baseUrl: 'http://x' } }).ok).toBe(true);
  });

  it('masks apiKey in summary', () => {
    const rec = service.create({ name: 'RH', type: 'runninghub', config: { apiKey: 'sk-abcdef', gpuSize: '24G' }, concurrency: 1 });
    const summary = service.toSummary(rec);
    expect(summary.config.apiKey).not.toContain('abcdef');
  });

  it('emits change events', () => {
    const fn = vi.fn();
    const unsub = service.onChange(fn);
    service.notifyChange();
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    service.notifyChange();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('testConnection succeeds on 2xx system_stats', async () => {
    // 模拟 GET {base}/system_stats 返回 200：应视为连通
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"system":{}}', { status: 200 })));
    const result = await service.testConnection({ baseUrl: 'http://localhost:8188' });
    expect(result.ok).toBe(true);
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('http://localhost:8188/system_stats');
  });

  it('testConnection reports non-2xx as failure', async () => {
    // 模拟 HTTP 500：应报告失败且不抛异常
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await service.testConnection({ baseUrl: 'http://localhost:8188' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('500');
  });
});
