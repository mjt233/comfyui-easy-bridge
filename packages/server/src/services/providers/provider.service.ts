import { and, count, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as schema from '../../models/schema';
import { ComfyUIProvider } from './comfyui.provider';
import { RunningHubProvider } from './runninghub.provider';
import { GroupProvider, type ResolvedGroupMember } from './group.provider';
import type { HealthService } from './health.service';
import type {
  ExecutionProvider,
  GroupDispatchPolicy,
  GroupProviderConfig,
  ProviderConfig,
  ProviderType,
} from './types';
import { connectivityProbeConfig } from './types';

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

/** 分组成员的展示摘要 */
export interface GroupMemberSummary {
  /** 成员实例 ID */
  providerId: string;
  /** 成员实例展示名；实例已删除时为 null */
  providerName: string | null;
  /** 成员实例类型；实例已删除时为 null */
  type: ProviderType | null;
  /** 算力性能权重 */
  weight: number;
  /** 成员实例是否已启用 */
  enabled: boolean;
  /** 成员实例并发上限 */
  concurrency: number;
  /** 当前占用的并发槽位（pending 任务数） */
  pendingCount: number;
  /** 当前空闲并发槽位（已停用或已删除时为 0） */
  availableSlots: number;
  /** 是否可用（已启用、未删除且未处于健康冷却期） */
  healthy: boolean;
  /** 是否处于健康冷却期 */
  inCooldown: boolean;
  /** 不可用原因；可用时为 null */
  unavailableReason: string | null;
}

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
  /** 解析后的 HTTP 基础地址（分组为空串） */
  resolvedBaseUrl: string;
  /** 任务跟踪模式 */
  trackingMode: 'websocket' | 'polling';
  /** 分组专属：调度策略；非分组为 null */
  dispatchPolicy: GroupDispatchPolicy | null;
  /** 分组专属：成员数量；非分组为 0 */
  memberCount: number;
  /** 分组专属：全部成员的空闲并发槽位合计；非分组为 0 */
  availableSlots: number;
  /** 分组专属：成员明细；非分组为空数组 */
  members: GroupMemberSummary[];
  /** 实例自身的健康状态（分组为 null，其健康由成员体现） */
  health: { healthy: boolean; inCooldown: boolean; lastCheckedAt: string | null; lastError: string | null } | null;
}

/** 类型白名单 */
const TYPES: readonly ProviderType[] = ['comfyui', 'runninghub', 'group'];

/** 调度策略白名单 */
const DISPATCH_POLICIES: readonly GroupDispatchPolicy[] = ['priority', 'random'];

/** 默认调度策略：按权重优先 */
const DEFAULT_DISPATCH_POLICY: GroupDispatchPolicy = 'priority';

/** 默认算力性能权重 */
const DEFAULT_MEMBER_WEIGHT = 1;

/**
 * 判断实例类型是否可作为分组成员。
 * 分组不可嵌套：分组类型永远不能作为其他分组的成员。
 * @param type 提供商类型
 * @returns 可作为成员返回 true
 */
export function isAssignableMemberType(type: ProviderType): boolean {
  return type === 'comfyui' || type === 'runninghub';
}

/**
 * 穷尽性检查：switch 覆盖全部类型时不会执行到此处。
 * 新增提供商类型但漏改分支时，TypeScript 会在编译期报错。
 * @param value 不应到达的值
 */
function assertNever(value: never): never {
  throw new Error(`Unsupported provider type: ${String(value)}`);
}

/**
 * 规范化算力性能权重：仅接受正数（含小数），其余一律回退默认值 1。
 * 需要把实例排除出分配池时应直接从分组成员中移除，而非依赖权重取值。
 * @param value 原始权重值
 * @returns 规范化后的权重
 */
export function normalizeMemberWeight(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MEMBER_WEIGHT;
}

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
   * 分类判定基于 type 字段（而非配置字段形状），分组类型会解析其成员列表。
   * @param row 实例行
   * @returns 实例化后的 provider；config 非法时返回 null
   */
  instantiate(row: ProviderRow): ExecutionProvider | null {
    const config = this.getConfig(row);
    // config 非法（损坏 JSON）时无法实例化，直接返回 null
    if (!config) return null;
    // 按 type 分类实例化；unknown 类型由 assertNever 兜底报错
    switch (row.type as ProviderType) {
      case 'comfyui':
        // comfyui 需要非空 baseUrl
        if (typeof (config as { baseUrl?: unknown }).baseUrl !== 'string') return null;
        return new ComfyUIProvider(row.id, row.name, config as Extract<ProviderConfig, { baseUrl: string }>, row.concurrency);
      case 'runninghub':
        // runninghub 需要非空 apiKey
        if (typeof (config as { apiKey?: unknown }).apiKey !== 'string') return null;
        return new RunningHubProvider(
          row.id,
          row.name,
          config as Extract<ProviderConfig, { apiKey: string; gpuSize: '24G' | '48G' }>,
          row.concurrency,
        );
      case 'group':
        return this.instantiateGroup(row, config as GroupProviderConfig);
      default:
        return assertNever(row.type as never);
    }
  }

  /**
   * 实例化分组 provider（解析成员列表）。
   * @param row 分组实例行
   * @param config 分组配置
   * @returns GroupProvider；配置非法时返回 null
   */
  private instantiateGroup(row: ProviderRow, config: GroupProviderConfig): GroupProvider | null {
    const members = this.buildResolvedMembers(config);
    // 配置非法（members 非数组）时无法实例化
    if (members === null) return null;
    const policy = DISPATCH_POLICIES.includes(config.dispatchPolicy) ? config.dispatchPolicy : DEFAULT_DISPATCH_POLICY;
    return new GroupProvider(row.id, row.name, row.concurrency, policy, members);
  }

  /**
   * 将分组成员配置解析为已实例化的成员列表。
   * 过滤规则（静默跳过，不报错）：
   * - 成员实例不存在（已删除）
   * - 成员实例已停用（enabled = 0）
   * - 成员实例类型为分组（禁止嵌套）
   * - 成员 config 非法无法实例化
   * 同一实例重复出现时仅保留首次出现的权重与次序。
   * @param config 分组配置
   * @returns 成员列表；config.members 非数组时返回 null
   */
  private buildResolvedMembers(config: GroupProviderConfig): ResolvedGroupMember[] | null {
    if (!Array.isArray(config.members)) return null;
    const result: ResolvedGroupMember[] = [];
    const seen = new Set<string>();
    for (const raw of config.members) {
      // 跳过非法条目（缺失 providerId / 非对象）
      if (!raw || typeof raw !== 'object') continue;
      const providerId = typeof raw.providerId === 'string' ? raw.providerId : '';
      if (providerId === '' || seen.has(providerId)) continue;
      seen.add(providerId);
      const row = this.getById(providerId);
      // 实例不存在或已停用时跳过该成员
      if (!row || row.enabled !== 1) continue;
      // 分组不可嵌套：分组类型实例不能作为成员
      if (!isAssignableMemberType(row.type as ProviderType)) continue;
      const provider = this.instantiate(row);
      if (!provider) continue;
      result.push({
        providerId: row.id,
        providerName: row.name,
        weight: normalizeMemberWeight(raw.weight),
        order: result.length,
        provider,
      });
    }
    return result;
  }

  /**
   * 解析分组实例的成员列表。
   * @param id 分组实例 ID
   * @returns 已实例化的成员列表；实例不存在、非分组类型或配置非法时返回 null
   */
  resolveGroupMembers(id: string): ResolvedGroupMember[] | null {
    const row = this.getById(id);
    if (!row || row.type !== 'group') return null;
    const config = this.getConfig(row);
    if (!config) return null;
    return this.buildResolvedMembers(config as GroupProviderConfig);
  }

  /**
   * 解析分组实例为 GroupProvider。
   * @param id 分组实例 ID
   * @returns GroupProvider；实例不存在、非分组或配置非法时返回 null
   */
  resolveGroupById(id: string): GroupProvider | null {
    const row = this.getById(id);
    if (!row || row.type !== 'group') return null;
    const config = this.getConfig(row);
    if (!config) return null;
    return this.instantiateGroup(row, config as GroupProviderConfig);
  }

  /**
   * 列出全部启用中的分组成员实例 ID（按实例 ID 去重）。
   * 供健康巡检确定探测目标，以及调度器判断哪些实例参与自动分配。
   * @returns 成员实例 ID 数组
   */
  listAutoAllocatableMemberIds(): string[] {
    const ids = new Set<string>();
    for (const row of this.listEnabled()) {
      // 仅分组实例携带成员配置
      if (row.type !== 'group') continue;
      const config = this.getConfig(row);
      if (!config) continue;
      for (const member of this.buildResolvedMembers(config as GroupProviderConfig) ?? []) {
        ids.add(member.providerId);
      }
    }
    return [...ids];
  }

  /**
   * 统计某实例当前占用的并发槽位。
   * 统一按 actual_provider_id 统计：普通任务的 actual_provider_id 即其 provider_id，
   * 分组任务的 provider_id 是分组、actual_provider_id 才是真正执行任务的成员实例。
   * @param providerId 实例 ID
   * @returns 占用槽位数
   */
  countPending(providerId: string): number {
    const row = this.db.select({ c: count() }).from(schema.taskLogs)
      .where(and(eq(schema.taskLogs.status, 'pending'), eq(schema.taskLogs.actualProviderId, providerId)))
      .get();
    return row?.c ?? 0;
  }

  /**
   * 构建单个分组成员的展示摘要（含空闲槽位与健康状态）。
   * @param member 已解析的成员
   * @param healthService 健康检测服务；缺省时按「已启用即可用」处理
   * @returns 成员摘要
   */
  private buildMemberSummary(member: ResolvedGroupMember, healthService?: HealthService): GroupMemberSummary {
    const snapshot = healthService?.getSnapshot(member.providerId);
    const inCooldown = snapshot?.inCooldown ?? false;
    const healthy = snapshot ? snapshot.healthy : true;
    const pendingCount = this.countPending(member.providerId);
    const availableSlots = healthy ? Math.max(member.provider.concurrency - pendingCount, 0) : 0;
    // 不可用原因按优先级给出：健康冷却 > 无可信来源（成员在解析阶段已过滤停用/删除）
    const unavailableReason = inCooldown
      ? `实例不可用（冷却中）：${snapshot?.lastError ?? '连接失败'}`
      : null;
    return {
      providerId: member.providerId,
      providerName: member.providerName,
      type: member.provider.type,
      weight: member.weight,
      enabled: true,
      concurrency: member.provider.concurrency,
      pendingCount,
      availableSlots,
      healthy,
      inCooldown,
      unavailableReason,
    };
  }

  /**
   * 构建分组摘要的专属字段（调度策略、成员明细、空闲槽位合计）。
   * @param row 分组实例行
   * @param healthService 健康检测服务；缺省时跳过健康判定
   * @returns 分组专属摘要字段
   */
  private buildGroupSummaryFields(
    row: ProviderRow,
    healthService?: HealthService,
  ): Pick<ProviderSummary, 'dispatchPolicy' | 'memberCount' | 'availableSlots' | 'members'> {
    const group = this.resolveGroupById(row.id);
    if (!group) {
      return { dispatchPolicy: null, memberCount: 0, availableSlots: 0, members: [] };
    }
    const members = group.listMembers().map((m) => this.buildMemberSummary(m, healthService));
    return {
      dispatchPolicy: group.getDispatchPolicy(),
      memberCount: members.length,
      availableSlots: members.reduce((sum, m) => sum + m.availableSlots, 0),
      members,
    };
  }

  /** 按 ID 获取实例化 provider */
  getProviderById(id: string): ExecutionProvider | null {
    const row = this.getById(id);
    if (!row) return null;
    return this.instantiate(row);
  }

  /**
   * 按 ID 获取已启用的实例化 provider。
   * 实例不存在、已禁用或 config 非法时返回 null。
   * 供「本次执行显式指定提供商」场景使用：显式指定必须为启用中的可用实例。
   * @param id 实例 ID
   * @returns 实例化 provider；不可用时返回 null
   */
  getEnabledProviderById(id: string): ExecutionProvider | null {
    const row = this.getById(id);
    // 实例缺失或已禁用时视为不可用
    if (!row || row.enabled !== 1) return null;
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
   * 解析工作流使用的 provider：workflow.providerId 优先，否则回退全局默认。
   *
   * 严格语义（硬报错，不静默回退）：
   * - 工作流**显式指定**了实例，但该实例不存在、已停用或配置非法 → 返回错误，
   *   避免「我明明选了 A 却跑到 B 上执行」的意外；
   * - 工作流未指定 → 使用全局默认，默认实例不可用时同样报错（视为未配置）。
   * @param workflowId 工作流 ID
   * @returns 解析结果：成功带 provider，失败带错误码与文案
   */
  resolveWorkflowProviderStrict(
    workflowId: string,
  ): { provider: ExecutionProvider; error?: undefined; message?: undefined } | { provider: null; error: string; message: string } {
    const wf = this.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
    if (wf?.providerId) {
      const row = this.getById(wf.providerId);
      // 显式指定但实例已不存在
      if (!row) {
        return { provider: null, error: 'provider_not_configured', message: '指定的执行提供商不存在' };
      }
      // 显式指定但实例已停用
      if (row.enabled !== 1) {
        return { provider: null, error: 'provider_not_configured', message: '指定的执行提供商已停用' };
      }
      const provider = this.instantiate(row);
      // 显式指定但配置非法（config 损坏或缺少必需字段）
      if (!provider) {
        return { provider: null, error: 'provider_not_configured', message: '指定的执行提供商配置非法' };
      }
      return { provider };
    }
    const fallback = this.getDefaultProvider();
    if (!fallback) {
      return { provider: null, error: 'provider_not_configured', message: '未配置可用的执行提供商' };
    }
    return { provider: fallback };
  }

  /**
   * 解析工作流使用的 provider，不可用时回退全局默认（宽松语义）。
   * 仅用于「只读预览」场景（工作流详情展示解析到的实例），执行路径请使用 resolveWorkflowProviderStrict。
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
   * 全局默认是分组时说明是分组（skip），不会参与 node-info 查询。
   * @returns comfyui 类型的 provider 或 null
   */
  getNodeInfoProvider(): ExecutionProvider | null {
    const def = this.getDefaultProvider();
    if (def?.type === 'comfyui') return def;
    // 默认实例缺失/不是 comfyui（含分组）时，回退第一个启用中的 comfyui 实例
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
    // 按 type 分类校验配置；unknown 类型由 assertNever 兜底
    switch (raw.type as ProviderType) {
      case 'comfyui':
        return this.validateComfyUIInput(name, raw);
      case 'runninghub':
        return this.validateRunningHubInput(name, raw);
      case 'group':
        return this.validateGroupInput(name, raw);
      default:
        return assertNever(raw.type as never);
    }
  }

  /**
   * 校验 comfyui 类型输入。
   * @param name 已规范化的展示名
   * @param raw 原始输入
   * @returns 校验结果
   */
  private validateComfyUIInput(name: string, raw: ProviderInputLike): ValidationResult {
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

  /**
   * 校验 runninghub 类型输入。
   * @param name 已规范化的展示名
   * @param raw 原始输入
   * @returns 校验结果
   */
  private validateRunningHubInput(name: string, raw: ProviderInputLike): ValidationResult {
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

  /**
   * 校验 group（分组）类型输入。
   * dispatchPolicy 缺省为 priority；members 缺省空数组，逐项规范化：
   * - 丢弃非对象条目与缺失 providerId 的条目
   * - 同一 providerId 重复出现时保留首次出现的权重
   * - 权重非正数/非有限数时回退默认值 1
   * 空成员与「成员均为分组类型」属于运行期不可分配问题（提交任务时返回 400），
   * 此处不阻塞保存，便于用户先建分组再逐步配置成员。
   * @param name 已规范化的展示名
   * @param raw 原始输入
   * @returns 校验结果
   */
  private validateGroupInput(name: string, raw: ProviderInputLike): ValidationResult {
    const cfg = raw.config as { dispatchPolicy?: unknown; members?: unknown } | undefined;
    // dispatchPolicy 缺省 priority；显式提供非法值则拒绝
    const rawPolicy = cfg?.dispatchPolicy;
    if (rawPolicy !== undefined && !DISPATCH_POLICIES.includes(rawPolicy as GroupDispatchPolicy)) {
      return { ok: false, error: 'dispatchPolicy must be priority or random' };
    }
    const dispatchPolicy = (rawPolicy as GroupDispatchPolicy | undefined) ?? DEFAULT_DISPATCH_POLICY;
    // members 缺省空数组；显式提供非数组则拒绝
    if (cfg?.members !== undefined && !Array.isArray(cfg.members)) {
      return { ok: false, error: 'members must be an array' };
    }
    const members = this.normalizeGroupMembers(cfg?.members);
    return {
      ok: true,
      value: {
        name,
        type: 'group',
        config: { dispatchPolicy, members },
        // 分组自身不执行任务，并发上限字段无意义，固定为 1
        concurrency: 1,
        enabled: this.normalizeEnabled(raw.enabled),
      },
    };
  }

  /**
   * 规范化分组成员数组：去重、丢弃非法条目、规范化权重。
   * @param raw 原始 members 值
   * @returns 规范化后的成员数组
   */
  private normalizeGroupMembers(raw: unknown): { providerId: string; weight: number }[] {
    if (!Array.isArray(raw)) return [];
    const members: { providerId: string; weight: number }[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const obj = entry as { providerId?: unknown; weight?: unknown };
      const providerId = typeof obj.providerId === 'string' ? obj.providerId.trim() : '';
      // 缺失 providerId 或重复出现的成员直接丢弃
      if (providerId === '' || seen.has(providerId)) continue;
      seen.add(providerId);
      members.push({ providerId, weight: normalizeMemberWeight(obj.weight) });
    }
    return members;
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
   * 分组实例额外附带调度策略、成员明细、空闲槽位与健康状态。
   * @param row 实例行
   * @param healthService 健康检测服务；缺省时不附带健康判定（一律视为可用）
   * @returns 摘要
   */
  toSummary(row: ProviderRow, healthService?: HealthService): ProviderSummary {
    const config = this.getConfig(row);
    const provider = this.instantiate(row);
    const type = row.type as ProviderType;
    let maskedConfig: ProviderSummary['config'];
    if (config) {
      maskedConfig = config as ProviderSummary['config'];
      if (type === 'runninghub') {
        // 仅打码 apiKey，其余字段原样透出
        const apiKey = (config as { apiKey: string }).apiKey;
        maskedConfig = { ...(config as object), apiKey: apiKey.length <= 4 ? '****' : `${apiKey.slice(0, 4)}****` } as ProviderSummary['config'];
      }
    } else {
      // config 非法（损坏 JSON）时输出空配置，保证摘要不崩溃
      maskedConfig = {} as ProviderSummary['config'];
    }
    // 分组专属字段：成员明细与空闲槽位合计
    const groupFields = type === 'group'
      ? this.buildGroupSummaryFields(row, healthService)
      : { dispatchPolicy: null, memberCount: 0, availableSlots: 0, members: [] };
    // 实例自身健康状态：分组由其成员体现，故为 null
    const snapshot = type === 'group' ? null : healthService?.getSnapshot(row.id) ?? null;
    return {
      id: row.id,
      name: row.name,
      type,
      config: maskedConfig,
      concurrency: row.concurrency,
      enabled: row.enabled === 1,
      resolvedBaseUrl: provider?.getDisplayBaseUrl() ?? '',
      trackingMode: provider?.trackingMode ?? 'polling',
      ...groupFields,
      health: snapshot
        ? {
            healthy: snapshot.healthy,
            inCooldown: snapshot.inCooldown,
            lastCheckedAt: snapshot.lastCheckedAt,
            lastError: snapshot.lastError,
          }
        : null,
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
   * 连通性测试（未保存配置也可测试）。
   * 分组类型无自有端点，改为探测其成员是否至少有一个可用（仅统计已启用且可解析的成员）。
   * @param config 待测试的配置
   * @param providerType 提供商类型；缺省按配置字段形状推断（兼容既有调用方）
   * @returns 测试结果
   */
  async testConnection(
    config: ProviderConfig,
    providerType?: ProviderType,
  ): Promise<{ ok: boolean; message: string }> {
    const type = providerType ?? this.inferConfigType(config);
    if (type === 'group') {
      return this.testGroupConnection(config as GroupProviderConfig);
    }
    // runninghub 由 apiKey + gpuSize 推导 proxy 地址；comfyui 直接用 baseUrl
    const baseUrl = type === 'runninghub'
      ? `https://www.runninghub.cn/${(config as Extract<ProviderConfig, { gpuSize: '24G' | '48G' }>).gpuSize === '48G' ? 'proxy-plus' : 'proxy'}/${(config as { apiKey: string }).apiKey}`
      : (config as { baseUrl: string }).baseUrl;
    try {
      const res = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(connectivityProbeConfig.timeoutMs) });
      if (res.ok) return { ok: true, message: '连接成功' };
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * 分组连通性测试：逐个探测配置中的成员，遇到第一个可用成员即成功。
   * 已删除/已停用/非法的成员条目被跳过（与运行期一致）。
   * @param config 分组配置
   * @returns 测试结果
   */
  private async testGroupConnection(config: GroupProviderConfig): Promise<{ ok: boolean; message: string }> {
    const members = this.buildResolvedMembers(config) ?? [];
    if (members.length === 0) {
      return { ok: false, message: '分组未配置可用成员实例' };
    }
    let lastError = '分组内成员实例均不可用';
    for (const member of members) {
      const result = await member.provider.testConnection();
      if (result.ok) {
        return { ok: true, message: `连接成功（成员：${member.providerName}）` };
      }
      lastError = `${member.providerName}: ${result.message}`;
    }
    return { ok: false, message: lastError };
  }

  /**
   * 按配置字段形状推断类型（兼容未显式传 providerType 的既有调用方）。
   * @param config 提供商配置
   * @returns 推断出的类型
   */
  private inferConfigType(config: ProviderConfig): ProviderType {
    if ('apiKey' in config) return 'runninghub';
    if ('baseUrl' in config) return 'comfyui';
    return 'group';
  }
}
