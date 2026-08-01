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
});
