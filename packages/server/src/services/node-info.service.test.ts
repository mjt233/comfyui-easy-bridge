import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from './settings.service';
import {
  summarizeNodeInfo,
  generateNodeClassDts,
  generateBuildDts,
  getNodeInfoCached,
  fetchNodeInfo,
  clearNodeInfoCache,
  nodeInfoServiceConfig,
} from './node-info.service';

/** 样本 object_info（覆盖 COMBO 两种形态、required/optional/hidden、output/output_name） */
const sampleObjectInfo = {
  KSampler: {
    input: {
      required: {
        model: ['MODEL', { tooltip: 'the model' }],
        seed: ['INT', { default: 0, min: 0, max: 999, tooltip: 'seed' }],
        sampler_name: [['euler', 'heun'], { tooltip: 'sampler' }],
      },
      optional: {
        denoise: ['FLOAT', { default: 1.0 }],
      },
      hidden: {
        prompt: ['PROMPT'],
      },
    },
    display_name: 'KSampler',
    category: 'sampling',
    output: ['LATENT'],
    output_name: ['LATENT'],
  },
  SaveVideo: {
    input: {
      required: {
        format: ['COMBO', { options: ['auto', 'mp4'], default: 'auto' }],
      },
    },
    display_name: 'Save Video',
    output: ['VIDEO'],
    output_name: ['video'],
  },
};

describe('summarizeNodeInfo', () => {
  it('extracts fields, drops hidden and config details, supports both COMBO forms', () => {
    const result = summarizeNodeInfo(sampleObjectInfo);

    expect(Object.keys(result)).toEqual(['KSampler', 'SaveVideo']);

    const ks = result['KSampler']!;
    expect(ks.display_name).toBe('KSampler');
    expect(ks.category).toBe('sampling');
    // required：MODEL 类型无 options
    expect(ks.required_inputs.model).toEqual({ type: 'MODEL' });
    // 直接选项数组形态 → COMBO
    expect(ks.required_inputs.sampler_name).toEqual({ type: 'COMBO', options: ['euler', 'heun'] });
    // hidden 剔除
    expect(ks.required_inputs.prompt).toBeUndefined();
    expect(ks.optional_inputs.denoise).toEqual({ type: 'FLOAT' });
    expect(ks.outputs).toEqual(['LATENT']);
    expect(ks.output_names).toEqual(['LATENT']);

    // COMBO config.options 形态
    expect(result['SaveVideo']!.required_inputs.format).toEqual({ type: 'COMBO', options: ['auto', 'mp4'] });
    expect(result['SaveVideo']!.display_name).toBe('Save Video');
  });
});

describe('generateNodeClassDts / generateBuildDts', () => {
  it('generates dts with class union, field keys, and dynamic signatures', () => {
    const fragment = generateNodeClassDts(summarizeNodeInfo(sampleObjectInfo));
    expect(fragment).toContain('declare type ComfyNodeInputs = {');
    expect(fragment).toContain('"KSampler": {');
    expect(fragment).toContain('"seed": unknown;');
    expect(fragment).toContain('declare type ComfyClassType = keyof ComfyNodeInputs;');
    expect(fragment).toContain('declare interface ComfyNodeClassInfo');

    const full = generateBuildDts(summarizeNodeInfo(sampleObjectInfo));
    expect(full).toContain('declare interface ComfyNode');
    expect(full).toContain('declare type ComfyNodeInputs = {');
    expect(full).toContain('addNode<K extends ComfyClassType>(nodeId: string, classType: K, inputs?: Partial<ComfyNodeInputs[K]>): void;');
    expect(full).toContain('findNodesByClass(classType: ComfyClassType): string[];');
  });

  it('produces stable output across calls', () => {
    const info = summarizeNodeInfo(sampleObjectInfo);
    expect(generateNodeClassDts(info)).toBe(generateNodeClassDts(info));
  });
});

describe('getNodeInfoCached', () => {
  let sqlite: Database.Database;
  // 与既有测试文件一致：显式标注 Drizzle 类型
  let db: BetterSQLite3Database<typeof schema>;
  /** 记录 fetch 调用次数与 URL */
  let fetchCalls: string[];

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db = drizzle(sqlite, { schema });
    fetchCalls = [];
    // 覆盖 fetch 实现：返回样本 object_info
    nodeInfoServiceConfig.fetchImpl = async (url: string) => {
      fetchCalls.push(url);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify(sampleObjectInfo);
        },
      } as unknown as Response;
    };
    nodeInfoServiceConfig.now = () => 1_000_000;
    clearNodeInfoCache();
  });

  afterEach(() => {
    clearNodeInfoCache();
    // 恢复默认超时，避免影响其他用例
    nodeInfoServiceConfig.fetchTimeoutMs = 10000;
  });

  it('returns null when comfyui_base_url is not configured', async () => {
    const result = await getNodeInfoCached(db);
    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it('fetches, summarizes and caches within TTL', async () => {
    new SettingsService(db).set('comfyui_base_url', 'http://comfy:8188');

    const first = await getNodeInfoCached(db);
    expect(first).not.toBeNull();
    expect(first!['KSampler']!.required_inputs.seed).toEqual({ type: 'INT' });

    // TTL 内第二次调用走缓存
    const second = await getNodeInfoCached(db);
    expect(second).toEqual(first);
    expect(fetchCalls).toHaveLength(1);
  });

  it('refetches after TTL expiry', async () => {
    new SettingsService(db).set('comfyui_base_url', 'http://comfy:8188');

    await getNodeInfoCached(db);
    expect(fetchCalls).toHaveLength(1);

    // 时间前进超过 TTL
    nodeInfoServiceConfig.now = () => 1_000_000 + nodeInfoServiceConfig.cacheTtlMs + 1;
    await getNodeInfoCached(db);
    expect(fetchCalls).toHaveLength(2);
  });

  it('returns null on fetch failure without throwing', async () => {
    new SettingsService(db).set('comfyui_base_url', 'http://comfy:8188');
    nodeInfoServiceConfig.fetchImpl = async () => {
      throw new Error('unreachable');
    };

    const result = await getNodeInfoCached(db);
    expect(result).toBeNull();
  });

  it('negative-caches fetch failures within short TTL', async () => {
    new SettingsService(db).set('comfyui_base_url', 'http://comfy:8188');
    // 首次拉取失败（push URL 后抛错，便于统计重试次数）
    nodeInfoServiceConfig.fetchImpl = async (url: string) => {
      fetchCalls.push(url);
      throw new Error('unreachable');
    };
    const first = await getNodeInfoCached(db);
    expect(first).toBeNull();
    expect(fetchCalls).toHaveLength(1);

    // 负缓存 TTL 内：不再重试，仍返回 null
    const second = await getNodeInfoCached(db);
    expect(second).toBeNull();
    expect(fetchCalls).toHaveLength(1);

    // 负缓存过期后：重试一次（仍然失败 → null）
    nodeInfoServiceConfig.now = () => 1_000_000 + nodeInfoServiceConfig.negativeCacheTtlMs + 1;
    const third = await getNodeInfoCached(db);
    expect(third).toBeNull();
    expect(fetchCalls).toHaveLength(2);
  });

  it('deduplicates concurrent calls into a single fetch', async () => {
    new SettingsService(db).set('comfyui_base_url', 'http://comfy:8188');

    // 用延迟 promise 模拟慢速拉取，验证并发去重
    // 延迟 promise 的 resolve 在闭包内赋值，用 `!` 断言绕过“使用前未赋值”检查
    let resolveFetch!: (value: Response | PromiseLike<Response>) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    nodeInfoServiceConfig.fetchImpl = async (url: string) => {
      fetchCalls.push(url);
      return fetchPromise as Promise<Response>;
    };

    const p1 = getNodeInfoCached(db);
    const p2 = getNodeInfoCached(db);
    // 两个并发调用尚未完成前，只应发起一次 fetch
    expect(fetchCalls).toHaveLength(1);

    // 完成第一个 fetch，两个调用都应拿到同一份数据
    resolveFetch({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(sampleObjectInfo);
      },
    } as unknown as Response);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(fetchCalls).toHaveLength(1);
  });

  it('returns null when fetch times out (abort)', async () => {
    new SettingsService(db).set('comfyui_base_url', 'http://comfy:8188');
    nodeInfoServiceConfig.fetchTimeoutMs = 50;

    // fetchImpl 永不 resolve，仅在 abort 时 reject（模拟超时）
    nodeInfoServiceConfig.fetchImpl = async (_url: string, init?: { signal?: AbortSignal }) => {
      fetchCalls.push(_url);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };

    const result = await getNodeInfoCached(db);
    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('fetchNodeInfo', () => {
  // fetchNodeInfo 仅依赖 baseUrl 与 nodeInfoServiceConfig，无需 DB
  beforeEach(() => {
    // 使用既有 fetch 覆盖模式：返回样本 object_info
    nodeInfoServiceConfig.fetchImpl = async (_url: string) => {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify(sampleObjectInfo);
        },
      } as unknown as Response;
    };
    nodeInfoServiceConfig.now = () => 1_000_000;
  });

  afterEach(() => {
    nodeInfoServiceConfig.fetchTimeoutMs = 10000;
  });

  it('throws on non-2xx status', async () => {
    nodeInfoServiceConfig.fetchImpl = async () => {
      return { ok: false, status: 500, async text() { return 'boom'; } } as unknown as Response;
    };

    await expect(fetchNodeInfo('http://comfy:8188')).rejects.toThrow('object_info returned status 500');
  });

  it('throws on invalid JSON', async () => {
    nodeInfoServiceConfig.fetchImpl = async () => {
      return { ok: true, status: 200, async text() { return 'not json'; } } as unknown as Response;
    };

    await expect(fetchNodeInfo('http://comfy:8188')).rejects.toThrow(SyntaxError);
  });

  it('throws when parsed JSON is not an object', async () => {
    nodeInfoServiceConfig.fetchImpl = async () => {
      return { ok: true, status: 200, async text() { return JSON.stringify([1, 2, 3]); } } as unknown as Response;
    };

    await expect(fetchNodeInfo('http://comfy:8188')).rejects.toThrow('object_info is not an object');
  });
});
