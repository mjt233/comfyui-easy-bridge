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

/** 提供商变更监听器 */
type ProviderChangeListener = () => void;

/**
 * 模块级变更事件总线：跨 ProviderService 实例共享。
 * 任何实例的 notifyChange 都会触发所有订阅者，确保执行服务能感知到
 * 其他模块（如 providers.controller 持有的独立实例）发起的变更。
 */
const changeListeners = new Set<ProviderChangeListener>();

/**
 * 订阅提供商变更（模块级共享）；返回取消订阅函数。
 * @param cb 变更回调
 */
export function onProviderChange(cb: ProviderChangeListener): () => void {
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
}

/** 触发提供商变更通知（模块级共享） */
export function notifyProviderChange(): void {
  for (const cb of changeListeners) cb();
}

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

  /**
   * 解析实例行的类型化配置。
   * @param row 实例行
   * @returns 类型化配置；config 为损坏 JSON 或非普通对象时返回 null
   */
  getConfig(row: ProviderRow): ProviderConfig | null {
    try {
      const parsed = JSON.parse(row.config) as unknown;
      // 必须为普通对象（数组/原始值视为非法配置）
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as ProviderConfig;
    } catch {
      // JSON 解析失败（config 损坏）时返回 null，由调用方兜底
      return null;
    }
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
    // config 非法（损坏 JSON）时无法实例化，直接返回 null
    if (!config) return null;
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

  /**
   * 获取全局默认的实例化 provider。
   * 默认实例被禁用时视为未配置。
   * @returns 实例化 provider；默认缺失或已禁用时返回 null
   */
  getDefaultProvider(): ExecutionProvider | null {
    const row = this.getDefault();
    // 默认实例缺失或已禁用时视为未配置
    if (!row || row.enabled !== 1) return null;
    return this.instantiate(row);
  }

  /**
   * 解析工作流使用的 provider：workflow.providerId 优先（须为启用状态），否则回退全局默认。
   * 工作流指定实例不存在或已禁用时回退默认；默认同样受启用规则约束（getDefaultProvider 已处理）。
   * @param workflowId 工作流 ID
   * @returns 实例化 provider；无可用实例时返回 null
   */
  resolveWorkflowProvider(workflowId: string): ExecutionProvider | null {
    const wf = this.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
    // 工作流显式指定了启用中的实例则优先使用；否则回退全局默认
    if (wf?.providerId) {
      const row = this.getById(wf.providerId);
      if (row && row.enabled === 1) {
        const p = this.instantiate(row);
        if (p) return p;
      }
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
      // comfyui 需要非空 baseUrl；autoCleanup/inputDir 可选（缺省回退默认值）
      const cfg = raw.config as { baseUrl?: unknown; autoCleanup?: unknown; inputDir?: unknown } | undefined;
      const baseUrl = cfg?.baseUrl;
      if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
        return { ok: false, error: 'baseUrl is required' };
      }
      // autoCleanup 仅接受布尔值，否则回退 false；inputDir 为字符串时 trim，否则回退空串
      const autoCleanup = typeof cfg?.autoCleanup === 'boolean' ? cfg.autoCleanup : false;
      const inputDir = typeof cfg?.inputDir === 'string' ? cfg.inputDir.trim() : '';
      return {
        ok: true,
        value: {
          name,
          type: 'comfyui',
          config: { baseUrl: baseUrl.trim(), autoCleanup, inputDir },
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
    // gpuSize 缺省时默认 24G；显式提供非法值则拒绝
    const gpuSize = cfg.gpuSize === '48G' ? '48G' : cfg.gpuSize === '24G' ? '24G' : cfg.gpuSize === undefined ? '24G' : null;
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
    let maskedConfig: ProviderSummary['config'];
    if (config) {
      maskedConfig = config as ProviderSummary['config'];
      if (row.type === 'runninghub') {
        // 仅打码 apiKey，其余字段原样透出
        const apiKey = (config as { apiKey: string }).apiKey;
        maskedConfig = { ...(config as object), apiKey: apiKey.length <= 4 ? '****' : `${apiKey.slice(0, 4)}****` } as ProviderSummary['config'];
      }
    } else {
      // config 非法（损坏 JSON）时输出空配置，保证摘要不崩溃
      maskedConfig = {} as ProviderSummary['config'];
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type as ProviderType,
      config: maskedConfig,
      concurrency: row.concurrency,
      enabled: row.enabled === 1,
      resolvedBaseUrl: provider?.getDisplayBaseUrl() ?? '',
      trackingMode: provider?.trackingMode ?? 'polling',
    };
  }

  /**
   * 订阅实例变更事件，返回取消订阅函数。
   * 委托到模块级共享总线：任何 ProviderService 实例（含执行服务自身的订阅）的
   * 变更都会触发本订阅，实现跨实例感知。
   */
  onChange(cb: () => void): () => void {
    return onProviderChange(cb);
  }

  /**
   * 触发变更事件（增删改实例 / 默认切换后调用）。
   * 委托到模块级共享总线：所有订阅者（其他实例/执行服务）都会收到通知。
   */
  notifyChange(): void {
    notifyProviderChange();
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
