import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as schema from '../../models/schema';
import { ComfyUIProvider } from './comfyui.provider';
import { RunningHubProvider } from './runninghub.provider';
import type { ExecutionProvider, ProviderConfig, ProviderType } from './types';

/** 提供商实例行（DB 行） */
export type ProviderRow = typeof schema.providers.$inferSelect;

/** 创建/更新提供商实例的输入 */
export interface ProviderInput {
  /** 展示名 */
  name: string;
  /** 提供商类型 */
  type: ProviderType;
  /** 类型化配置（按 type 区分） */
  config: ProviderConfig;
  /** 并发上限；缺省 1 */
  concurrency?: number;
  /** 是否启用；缺省 true */
  enabled?: boolean;
}

/** 校验用宽松输入（字段均为 unknown，容忍来自 HTTP body 的任意值） */
export interface ProviderInputLike {
  /** 展示名 */
  name?: unknown;
  /** 提供商类型 */
  type?: unknown;
  /** 类型化配置 */
  config?: unknown;
  /** 并发上限 */
  concurrency?: unknown;
  /** 是否启用 */
  enabled?: unknown;
}

/** 校验结果（判别联合：成功带规范化值 / 失败带错误信息） */
export type ValidationResult =
  | { ok: true; value: ProviderInput }
  | { ok: false; error: string };

/** 对外摘要（config 中的 apiKey 打码） */
export interface ProviderSummary {
  /** 实例 ID */
  id: string;
  /** 展示名 */
  name: string;
  /** 提供商类型 */
  type: ProviderType;
  /** 配置（runninghub 的 apiKey 已打码） */
  config: ProviderConfig & { apiKey?: string };
  /** 并发上限 */
  concurrency: number;
  /** 是否启用 */
  enabled: boolean;
  /** 解析后的 HTTP 基础地址 */
  resolvedBaseUrl: string;
  /** 任务跟踪模式 */
  trackingMode: 'websocket' | 'polling';
}

/** 类型白名单 */
const TYPES: readonly ProviderType[] = ['comfyui', 'runninghub'];
/** GPU 显存档位白名单 */
const GPU_SIZES: readonly string[] = ['24G', '48G'];

/**
 * 执行提供商实例服务：CRUD、解析（工作流/默认/node-info）、变更事件、测试连接。
 * 负责 providers 表的读写，并将 DB 行实例化为 ExecutionProvider。
 */
export class ProviderService {
  /**
   * @param db Drizzle 数据库实例
   */
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /** 列出全部实例（按创建时间升序） */
  list(): ProviderRow[] {
    return this.db.select().from(schema.providers).orderBy(schema.providers.createdAt).all();
  }

  /** 列出启用的实例 */
  listEnabled(): ProviderRow[] {
    return this.db.select().from(schema.providers).where(eq(schema.providers.enabled, 1)).all();
  }

  /** 按 ID 查询实例行 */
  getById(id: string): ProviderRow | null {
    return this.db.select().from(schema.providers).where(eq(schema.providers.id, id)).get() ?? null;
  }

  /** 解析实例行的类型化配置（config 为 JSON 文本） */
  getConfig(row: ProviderRow): ProviderConfig {
    return JSON.parse(row.config) as ProviderConfig;
  }

  /** 新建实例 */
  create(input: ProviderInput): ProviderRow {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.insert(schema.providers).values({
      id,
      name: input.name,
      type: input.type,
      config: JSON.stringify(input.config),
      concurrency: input.concurrency ?? 1,
      enabled: input.enabled === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.getById(id)!;
  }

  /** 更新实例；config/concurrency/enabled/name 均可选，缺省保留原值 */
  update(id: string, input: Partial<ProviderInput>): ProviderRow | null {
    const existing = this.getById(id);
    if (!existing) return null;
    // 仅在显式提供 config 时覆盖，否则沿用旧配置
    const config = input.config ? JSON.stringify(input.config) : existing.config;
    this.db.update(schema.providers)
      .set({
        name: input.name ?? existing.name,
        type: input.type ?? existing.type,
        config,
        concurrency: input.concurrency ?? existing.concurrency,
        enabled: input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.providers.id, id))
      .run();
    return this.getById(id)!;
  }

  /**
   * 删除实例。默认实例禁止删除。
   * 被工作流引用的实例：将 workflows.provider_id 置空（回退默认）。
   * @param id 实例 ID
   * @returns { deleted, error? } 删除结果
   */
  delete(id: string): { deleted: boolean; error?: string } {
    const existing = this.getById(id);
    if (!existing) return { deleted: false, error: 'provider_not_found' };
    if (this.getDefault()?.id === id) {
      return { deleted: false, error: 'default_provider_not_deletable' };
    }
    // 引用该实例的工作流回退为默认（置空 providerId）
    this.db.update(schema.workflows)
      .set({ providerId: null })
      .where(eq(schema.workflows.providerId, id))
      .run();
    this.db.delete(schema.providers).where(eq(schema.providers.id, id)).run();
    return { deleted: true };
  }

  /** 读取全局默认实例 ID（settings.default_provider_id） */
  getDefaultId(): string | null {
    const row = this.db.select().from(schema.settings).where(eq(schema.settings.key, 'default_provider_id')).get();
    return row?.value ?? null;
  }

  /** 读取全局默认实例行 */
  getDefault(): ProviderRow | null {
    const id = this.getDefaultId();
    if (!id) return null;
    return this.getById(id);
  }

  /** 设置全局默认实例（写入 settings 表，upsert） */
  setDefault(id: string): void {
    this.db.insert(schema.settings)
      .values({ key: 'default_provider_id', value: id })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: id } })
      .run();
  }

  /**
   * 将实例行实例化为 ExecutionProvider。
   * @param row 实例行
   * @returns 实例化后的 provider；config 非法时返回 null
   */
  instantiate(row: ProviderRow): ExecutionProvider | null {
    const config = this.getConfig(row);
    // 按类型分别构造对应的 provider 实现
    if (row.type === 'comfyui' && typeof (config as { baseUrl?: string }).baseUrl === 'string') {
      return new ComfyUIProvider(row.id, row.name, config as Extract<ProviderConfig, { baseUrl: string }>, row.concurrency);
    }
    if (row.type === 'runninghub' && typeof (config as { apiKey?: string }).apiKey === 'string') {
      return new RunningHubProvider(row.id, row.name, config as Extract<ProviderConfig, { apiKey: string; gpuSize: '24G' | '48G' }>, row.concurrency);
    }
    return null;
  }

  /** 按 ID 获取实例化 provider */
  getProviderById(id: string): ExecutionProvider | null {
    const row = this.getById(id);
    if (!row) return null;
    return this.instantiate(row);
  }

  /** 获取全局默认的实例化 provider */
  getDefaultProvider(): ExecutionProvider | null {
    const row = this.getDefault();
    if (!row) return null;
    return this.instantiate(row);
  }

  /**
   * 解析工作流使用的 provider：workflow.providerId 优先，其次全局默认。
   * @param workflowId 工作流 ID
   * @returns 实例化 provider 或 null
   */
  resolveWorkflowProvider(workflowId: string): ExecutionProvider | null {
    const wf = this.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
    // 工作流显式指定了实例则优先使用；未指定或失效时回退全局默认
    if (wf?.providerId) {
      const p = this.getProviderById(wf.providerId);
      if (p) return p;
    }
    return this.getDefaultProvider();
  }

  /**
   * 解析 node-info 用的 provider：仅原生 ComfyUI 类型。
   * 全局默认若是 comfyui 则用它；否则取第一个启用的 comfyui 实例。
   * @returns comfyui 类型的 provider 或 null
   */
  getNodeInfoProvider(): ExecutionProvider | null {
    const def = this.getDefaultProvider();
    if (def?.type === 'comfyui') return def;
    const row = this.listEnabled().find((r) => r.type === 'comfyui');
    if (!row) return null;
    return this.instantiate(row);
  }

  /**
   * 校验并规范化创建/更新输入。
   * 字段类型取宽松（unknown），容忍来自 HTTP body 的任意值，校验通过后产出强类型 ProviderInput。
   * @param raw 原始输入
   * @returns 校验结果
   */
  validateInput(raw: ProviderInputLike): ValidationResult {
    // 名称：需为非空字符串
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name === '') return { ok: false, error: 'name is required' };
    // 类型：必须在白名单内
    if (typeof raw.type !== 'string' || !TYPES.includes(raw.type as ProviderType)) {
      return { ok: false, error: 'invalid type' };
    }
    if (raw.type === 'comfyui') {
      // comfyui 需要非空 baseUrl
      const baseUrl = (raw.config as { baseUrl?: unknown } | undefined)?.baseUrl;
      if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
        return { ok: false, error: 'baseUrl is required' };
      }
      return {
        ok: true,
        value: {
          name,
          type: 'comfyui',
          config: { baseUrl: baseUrl.trim() },
          concurrency: this.normalizeConcurrency(raw.concurrency),
          enabled: this.normalizeEnabled(raw.enabled),
        },
      };
    }
    // runninghub 需要非空 apiKey 与白名单内的 gpuSize
    const cfg = raw.config as { apiKey?: unknown; gpuSize?: unknown } | undefined;
    if (typeof cfg?.apiKey !== 'string' || cfg.apiKey.trim() === '') {
      return { ok: false, error: 'apiKey is required' };
    }
    const gpuSize = typeof cfg.gpuSize === 'string' && GPU_SIZES.includes(cfg.gpuSize)
      ? cfg.gpuSize as '24G' | '48G'
      : null;
    if (!gpuSize) return { ok: false, error: 'gpuSize must be 24G or 48G' };
    return {
      ok: true,
      value: {
        name,
        type: 'runninghub',
        config: { apiKey: cfg.apiKey.trim(), gpuSize },
        concurrency: this.normalizeConcurrency(raw.concurrency),
        enabled: this.normalizeEnabled(raw.enabled),
      },
    };
  }

  /** 规范化并发数：非法时回退 1 */
  private normalizeConcurrency(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(n) && n > 0 ? n : 1;
  }

  /** 规范化启用标记：仅接受布尔值，否则回退 undefined（沿用原值） */
  private normalizeEnabled(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  /**
   * 生成对外摘要：apiKey 打码、附解析地址与跟踪模式。
   * @param row 实例行
   * @returns 摘要
   */
  toSummary(row: ProviderRow): ProviderSummary {
    const config = this.getConfig(row);
    const provider = this.instantiate(row);
    let maskedConfig = config as ProviderSummary['config'];
    if (row.type === 'runninghub') {
      // 仅打码 apiKey，其余字段原样透出
      const apiKey = (config as { apiKey: string }).apiKey;
      maskedConfig = { ...(config as object), apiKey: apiKey.length <= 4 ? '****' : `${apiKey.slice(0, 4)}****` } as ProviderSummary['config'];
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type as ProviderType,
      config: maskedConfig,
      concurrency: row.concurrency,
      enabled: row.enabled === 1,
      resolvedBaseUrl: provider?.getBaseUrl() ?? '',
      trackingMode: provider?.trackingMode ?? 'polling',
    };
  }

  /** 变更事件回调集合 */
  private listeners = new Set<() => void>();

  /** 订阅实例变更事件，返回取消订阅函数 */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** 触发变更事件（增删改实例 / 默认切换后调用） */
  notifyChange(): void {
    for (const cb of this.listeners) cb();
  }

  /**
   * 连通性测试：GET {base}/system_stats，2xx 视为连通（单一确定行为，无退化）。
   * @param config 待测试的配置（未保存也可）
   * @returns 测试结果
   */
  async testConnection(config: ProviderConfig): Promise<{ ok: boolean; message: string }> {
    // runninghub 由 apiKey + gpuSize 推导 proxy 地址；comfyui 直接用 baseUrl
    const baseUrl = 'baseUrl' in config
      ? config.baseUrl
      : `https://www.runninghub.cn/${config.gpuSize === '48G' ? 'proxy-plus' : 'proxy'}/${config.apiKey}`;
    try {
      const res = await fetch(`${baseUrl}/system_stats`);
      if (res.ok) return { ok: true, message: '连接成功' };
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : 'Unknown error' };
    }
  }
}
