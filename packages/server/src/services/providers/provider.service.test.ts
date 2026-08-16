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

  it('getEnabledProviderById only returns enabled providers', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' }, concurrency: 1 });
    // 启用中的实例可正常获取
    expect(service.getEnabledProviderById(rec.id)?.id).toBe(rec.id);
    // 禁用后不可获取
    service.update(rec.id, { enabled: false });
    expect(service.getEnabledProviderById(rec.id)).toBeNull();
    // 不存在的实例不可获取
    expect(service.getEnabledProviderById('no-such-id')).toBeNull();
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
    // resolvedBaseUrl 同样不得泄露完整 apiKey
    expect(summary.resolvedBaseUrl).not.toContain('sk-abcdef');
    expect(summary.resolvedBaseUrl).toContain('****');
  });

  it('validateInput defaults missing gpuSize to 24G', () => {
    // 未提供 gpuSize 时应默认 24G，而不是拒绝
    const result = service.validateInput({ name: 'x', type: 'runninghub', config: { apiKey: 'k' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config).toEqual({ apiKey: 'k', gpuSize: '24G' });
    }
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

  it('notifyChange from one instance triggers subscribers of another instance', () => {
    // 事件总线为模块级共享：实例 A 订阅、实例 B 触发，回调仍应执行
    const a = new ProviderService(db);
    const b = new ProviderService(db);
    const fn = vi.fn();
    const unsub = a.onChange(fn);
    b.notifyChange();
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
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

  it('update changes name/config/concurrency and preserves enabled when not provided', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://a' }, concurrency: 1 });
    const updated = service.update(rec.id, { name: 'Local2', config: { baseUrl: 'http://b' }, concurrency: 4 });
    expect(updated).not.toBeNull();
    // 名称、并发、配置均被覆盖
    expect(updated?.name).toBe('Local2');
    expect(updated?.concurrency).toBe(4);
    expect(service.getConfig(updated!)).toEqual({ baseUrl: 'http://b' });
    // 未显式提供 enabled 时保留原值
    expect(updated?.enabled).toBe(1);
  });

  it('update with config sets new config JSON and returns null for missing id', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://a' }, concurrency: 1 });
    const updated = service.update(rec.id, { config: { baseUrl: 'http://c' } });
    expect(updated).not.toBeNull();
    expect(service.getConfig(updated!)).toEqual({ baseUrl: 'http://c' });
    // 不存在的 ID 返回 null
    expect(service.update('missing-id', { name: 'x' })).toBeNull();
  });

  it('update toggles enabled to 0 when enabled is false', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://a' }, concurrency: 1 });
    const updated = service.update(rec.id, { enabled: false });
    expect(updated).not.toBeNull();
    expect(updated?.enabled).toBe(0);
  });

  it('workflow pointing to a disabled provider falls back to the default', () => {
    // A 启用并设为默认，B 禁用但被工作流显式引用：应回退到 A
    const a = service.create({ name: 'A', type: 'comfyui', config: { baseUrl: 'http://a' }, concurrency: 1 });
    const b = service.create({ name: 'B', type: 'comfyui', config: { baseUrl: 'http://b' }, concurrency: 1 });
    service.setDefault(a.id);
    service.update(b.id, { enabled: false });
    db.insert(schema.workflows).values({ id: 'w1', name: 'wf', rawJson: '{}', providerId: b.id, createdAt: 'x', updatedAt: 'x' }).run();
    expect(service.resolveWorkflowProvider('w1')?.getBaseUrl()).toBe('http://a');
  });

  it('getDefaultProvider returns null when default is disabled', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://a' }, concurrency: 1 });
    service.setDefault(rec.id);
    service.update(rec.id, { enabled: false });
    expect(service.getDefaultProvider()).toBeNull();
  });

  it('validateInput trims baseUrl and normalizes concurrency', () => {
    const result = service.validateInput({ name: 'x', type: 'comfyui', config: { baseUrl: ' http://x ' }, concurrency: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.concurrency).toBe(3);
      // comfyui 配置始终包含 autoCleanup/inputDir 默认值
      expect(result.value.config).toEqual({ baseUrl: 'http://x', autoCleanup: false, inputDir: '' });
    }
  });

  it('validateInput normalizes comfyui autoCleanup and inputDir', () => {
    const result = service.validateInput({
      name: 'x',
      type: 'comfyui',
      config: { baseUrl: 'http://x', autoCleanup: true, inputDir: ' C:\\comfy\\input ' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // autoCleanup 保留布尔值，inputDir 去首尾空白
      expect(result.value.config).toEqual({ baseUrl: 'http://x', autoCleanup: true, inputDir: 'C:\\comfy\\input' });
    }
  });

  it('validateInput falls back autoCleanup to false for non-boolean values', () => {
    const result = service.validateInput({
      name: 'x',
      type: 'comfyui',
      config: { baseUrl: 'http://x', autoCleanup: 'yes' as unknown as boolean },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config).toEqual({ baseUrl: 'http://x', autoCleanup: false, inputDir: '' });
    }
  });

  it('validateInput falls back concurrency to 1 on NaN', () => {
    const result = service.validateInput({ name: 'x', type: 'comfyui', config: { baseUrl: 'http://x' }, concurrency: NaN });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.concurrency).toBe(1);
    }
  });

  it('instantiate returns null for corrupt config JSON', () => {
    // 直接插入 config 损坏（非合法 JSON）的行
    const now = new Date().toISOString();
    db.insert(schema.providers).values({ id: 'bad', name: 'Bad', type: 'comfyui', config: '{not-json', concurrency: 1, enabled: 1, createdAt: now, updatedAt: now }).run();
    const row = service.getById('bad')!;
    expect(service.getConfig(row)).toBeNull();
    expect(service.instantiate(row)).toBeNull();
    // toSummary 不得崩溃，配置为空对象
    expect(() => service.toSummary(row)).not.toThrow();
    expect(service.toSummary(row).config).toEqual({});
  });

  it('testConnection uses runninghub proxy URL derived from gpuSize 24G', async () => {
    // runninghub 24G → /proxy/<apiKey>/system_stats
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"system":{}}', { status: 200 })));
    const result = await service.testConnection({ apiKey: 'key123', gpuSize: '24G' });
    expect(result.ok).toBe(true);
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://www.runninghub.cn/proxy/key123/system_stats');
  });

  it('testConnection uses proxy-plus URL for gpuSize 48G', async () => {
    // runninghub 48G → /proxy-plus/<apiKey>/system_stats
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"system":{}}', { status: 200 })));
    await service.testConnection({ apiKey: 'key123', gpuSize: '48G' });
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://www.runninghub.cn/proxy-plus/key123/system_stats');
  });

  it('testConnection reports network errors', async () => {
    // fetch 拒绝（网络错误）：应报告失败且不抛异常
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const result = await service.testConnection({ baseUrl: 'http://localhost:8188' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ECONNREFUSED');
  });
});
