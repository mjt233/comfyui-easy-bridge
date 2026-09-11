import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../models/schema';
import { ProviderService } from './provider.service';
import type { ExecutionProvider } from './types';

/**
 * 健康检测可调参数。
 * 抽为对象供测试覆盖（缩短间隔），避免用例真实等待。
 */
export const healthCheckConfig = {
  /** 后台巡检间隔（毫秒） */
  sweepIntervalMs: 30000,
  /** 连续失败达到该次数即标记不可用 */
  failureThreshold: 2,
  /** 标记不可用后的冷却时长（毫秒），冷却期内不再选中 */
  cooldownMs: 60000,
};

/** 单个实例的可用性状态 */
export interface ProviderHealthState {
  /** 是否可用（连续失败未达阈值时保持 true） */
  healthy: boolean;
  /** 最近一次探测是否成功；从未探测过为 null */
  lastProbeOk: boolean | null;
  /** 最近一次探测时间（ISO 字符串）；从未探测过为 null */
  lastCheckedAt: string | null;
  /** 最近一次失败原因；无失败为 null */
  lastError: string | null;
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 冷却截止时间戳（毫秒）；未处于冷却为 0 */
  cooldownUntil: number;
}

/** 对外输出的健康快照（供 API 返回） */
export interface ProviderHealthSnapshot {
  /** 实例 ID */
  providerId: string;
  /** 是否可用 */
  healthy: boolean;
  /** 是否处于冷却期 */
  inCooldown: boolean;
  /** 冷却截止时间（ISO 字符串）；未处于冷却为 null */
  cooldownUntil: string | null;
  /** 最近一次探测时间（ISO 字符串）；从未探测过为 null */
  lastCheckedAt: string | null;
  /** 最近一次失败原因；无失败为 null */
  lastError: string | null;
}

/** 内部初始状态工厂 */
function createInitialState(): ProviderHealthState {
  return {
    healthy: true,
    lastProbeOk: null,
    lastCheckedAt: null,
    lastError: null,
    consecutiveFailures: 0,
    cooldownUntil: 0,
  };
}

/**
 * 提供商实例可用性检测服务。
 *
 * 职责：
 * 1. 周期性探测「参与自动分配」的实例（即启用中的分组成员），刷新内存健康表；
 * 2. 供调度器查询实例是否可用（连续失败达阈值后进入冷却）；
 * 3. 记录提交阶段的即时探测结果（提交失败的实例立即进入冷却）。
 *
 * 状态为纯内存，进程重启后从「可用」重新开始（下一次巡检会刷新）。
 */
export class HealthService {
  private readonly providerService: ProviderService;
  /** providerId → 健康状态 */
  private readonly states = new Map<string, ProviderHealthState>();
  /** 巡检定时器 */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param db Drizzle 数据库实例（用于解析实例配置）
   */
  constructor(db: BetterSQLite3Database<typeof schema>) {
    this.providerService = new ProviderService(db);
  }

  /**
   * 读取实例健康状态；不存在时返回初始状态（视为可用）。
   * @param providerId 实例 ID
   * @returns 健康状态（内部结构，调用方不应修改）
   */
  private getState(providerId: string): ProviderHealthState {
    let state = this.states.get(providerId);
    if (!state) {
      state = createInitialState();
      this.states.set(providerId, state);
    }
    return state;
  }

  /**
   * 判断实例当前是否可用：不在冷却期内即视为可用。
   *
   * 冷却到期后自动恢复为可用：冷却的语义是「暂停使用一段时间」而非永久拉黑，
   * 到期后重新参与挑选，并由挑选前的即时探测兜底（探测失败会再次进入冷却）。
   * 连续失败计数在冷却结束时一并清零，避免残留计数让实例立即被再次拉黑。
   * @param providerId 实例 ID
   * @returns 可用返回 true
   */
  isHealthy(providerId: string): boolean {
    const state = this.states.get(providerId);
    // 从未探测过的实例视为可用（由提交前的即时探测兜底）
    if (!state) return true;
    if (Date.now() < state.cooldownUntil) return false;
    // 冷却已结束：恢复正常状态，计数清零
    if (!state.healthy) {
      state.healthy = true;
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
    }
    return true;
  }

  /**
   * 记录一次成功探测：清零失败计数、解除冷却。
   * @param providerId 实例 ID
   */
  markHealthy(providerId: string): void {
    const state = this.getState(providerId);
    state.healthy = true;
    state.lastProbeOk = true;
    state.lastCheckedAt = new Date().toISOString();
    state.lastError = null;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
  }

  /**
   * 记录一次失败探测：累计失败次数，达到阈值后标记不可用并进入冷却。
   * @param providerId 实例 ID
   * @param reason 失败原因
   */
  markUnhealthy(providerId: string, reason: string): void {
    const state = this.getState(providerId);
    state.lastProbeOk = false;
    state.lastCheckedAt = new Date().toISOString();
    state.lastError = reason;
    state.consecutiveFailures += 1;
    // 未达阈值时保持可用（容忍偶发网络抖动），达到阈值才真正判定不可用
    if (state.consecutiveFailures >= healthCheckConfig.failureThreshold) {
      state.healthy = false;
      state.cooldownUntil = Date.now() + healthCheckConfig.cooldownMs;
    }
  }

  /**
   * 立即将实例标记为不可用并进入冷却（用于提交阶段探测失败）。
   * 与 markUnhealthy 的区别：直接判定不可用，不等失败计数累计。
   * @param providerId 实例 ID
   * @param reason 失败原因
   */
  markFailedNow(providerId: string, reason: string): void {
    const state = this.getState(providerId);
    state.healthy = false;
    state.lastProbeOk = false;
    state.lastCheckedAt = new Date().toISOString();
    state.lastError = reason;
    state.consecutiveFailures = healthCheckConfig.failureThreshold;
    state.cooldownUntil = Date.now() + healthCheckConfig.cooldownMs;
  }

  /**
   * 探测单个实例并写入健康表。
   * @param provider 已实例化的执行提供商
   * @returns 是否可用
   */
  async probe(provider: ExecutionProvider): Promise<boolean> {
    const result = await provider.testConnection();
    if (result.ok) {
      this.markHealthy(provider.id);
      return true;
    }
    this.markUnhealthy(provider.id, result.message);
    return false;
  }

  /**
   * 执行一轮巡检：探测所有启用中的分组成员实例（按实例 ID 去重）。
   * 同时清理已不在任何分组中的实例健康记录，避免长期占用内存。
   * @returns 本轮是否触发了组重建（成员集合发生变化）
   */
  async sweep(): Promise<boolean> {
    const memberIds = this.providerService.listAutoAllocatableMemberIds();
    const memberIdSet = new Set(memberIds);

    // 清理不再参与自动分配的实例记录（已退出分组/被停用）
    let changed = false;
    for (const id of [...this.states.keys()]) {
      if (!memberIdSet.has(id)) {
        this.states.delete(id);
        changed = true;
      }
    }
    // 新加入的成员没有历史记录，视为变更（供调度器重建分组跟踪）
    for (const id of memberIds) {
      if (!this.states.has(id)) changed = true;
    }

    // 逐实例探测；单个失败不影响其他实例
    for (const id of memberIds) {
      const provider = this.providerService.getEnabledProviderById(id);
      if (!provider) continue;
      try {
        await this.probe(provider);
      } catch (err: unknown) {
        // testConnection 契约上不抛错，此处仅作最后兜底
        this.markUnhealthy(id, err instanceof Error ? err.message : 'Unknown error');
      }
    }
    return changed;
  }

  /**
   * 启动后台巡检定时器；重复调用只保留一个定时器。
   * @param onMemberHealthChange 巡检后回调（供调度器在实例恢复可用后立即投递队列）
   */
  start(onMemberHealthChange?: () => void): void {
    if (this.sweepTimer) return;
    // 启动后立即巡检一次，避免刚启动时所有实例都处于「未探测」状态
    void this.sweep()
      .then(() => onMemberHealthChange?.())
      .catch((err: unknown) => console.error('[HealthService] initial sweep failed', err));

    this.sweepTimer = setInterval(() => {
      void this.sweep()
        .then(() => onMemberHealthChange?.())
        .catch((err: unknown) => console.error('[HealthService] sweep failed', err));
    }, healthCheckConfig.sweepIntervalMs);
  }

  /** 停止后台巡检并清空健康表 */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.states.clear();
  }

  /**
   * 读取实例健康快照（供 API 返回）。
   * @param providerId 实例 ID
   * @returns 健康快照
   */
  getSnapshot(providerId: string): ProviderHealthSnapshot {
    const state = this.states.get(providerId);
    if (!state) {
      return {
        providerId,
        healthy: true,
        inCooldown: false,
        cooldownUntil: null,
        lastCheckedAt: null,
        lastError: null,
      };
    }
    const inCooldown = Date.now() < state.cooldownUntil;
    return {
      providerId,
      // 冷却结束后视为可用（与 isHealthy 的恢复语义保持一致）
      healthy: inCooldown ? false : true,
      inCooldown,
      cooldownUntil: inCooldown ? new Date(state.cooldownUntil).toISOString() : null,
      lastCheckedAt: state.lastCheckedAt,
      lastError: state.lastError,
    };
  }
}
