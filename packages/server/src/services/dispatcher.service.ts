import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { ProviderService } from './providers/provider.service';
import { GroupProvider, type ResolvedGroupMember } from './providers/group.provider';
import type { HealthService } from './providers/health.service';
import type { ExecutionProvider, MediaType } from './providers/types';
import { TaskService, type UpdateActualProviderInput } from './task.service';
import { readStagedFilesWithMeta, releaseStaged, type StagedFileMeta } from './task-staging.service';

/**
 * 调度器可调参数。
 * 抽为对象供测试覆盖（缩短间隔），避免用例真实等待。
 */
export const dispatcherConfig = {
  /** 队列兜底扫描间隔（毫秒）：补偿遗漏的槽位释放通知，使队列自愈 */
  fallbackIntervalMs: 30000,
  /** 单轮调度最多提交的任务数（防御性上限，避免异常情况下长时间占用事件循环） */
  maxSubmitsPerRound: 50,
};

/**
 * 递归替换 JSON 结构中的文件名：字符串值与映射键匹配时替换为实例侧的真实文件名。
 * 同一暂存名可能出现在多个节点字段（同别名被多个参数引用），因此按值全量匹配，
 * 数组（多文件注入）与嵌套对象一并处理。
 * @param node 待处理的 JSON 节点
 * @param renames 暂存名 → 实例侧实际文件名
 * @returns 替换后的新节点（不修改入参）
 */
function replaceFilenames(node: unknown, renames: Map<string, string>): unknown {
  if (typeof node === 'string') return renames.get(node) ?? node;
  if (Array.isArray(node)) return node.map((item) => replaceFilenames(item, renames));
  if (node !== null && typeof node === 'object') {
    const replaced: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      replaced[key] = replaceFilenames(value, renames);
    }
    return replaced;
  }
  return node;
}

/**
 * 用「实例侧实际文件名」回写提交请求体中的「本地暂存名」。
 *
 * 暂存名只在本地有效：上传接口返回的才是成员实例上的真实文件名
 * （原生 ComfyUI 会在上传时重新生成唯一名，RunningHub 由平台分配文件名）。
 * 若不回写，工作流节点会引用成员实例上并不存在的文件，执行端将直接拒绝该 prompt。
 * 请求体解析失败或无可替换项时原样返回，交由提交流程处理。
 * @param requestBodyJson 提交请求体 JSON 字符串（形如 `{ prompt: {...} }`）
 * @param renames 暂存名 → 实例侧实际文件名；为空时直接返回原请求体
 * @returns 回写后的请求体 JSON 字符串
 */
export function rewriteUploadedFilenames(requestBodyJson: string, renames: Map<string, string>): string {
  if (renames.size === 0) return requestBodyJson;
  try {
    const parsed = JSON.parse(requestBodyJson) as { prompt?: unknown };
    if (parsed === null || typeof parsed !== 'object') return requestBodyJson;
    // 仅回写工作流 prompt 子树；其余字段（client_id 等）与文件名无关
    parsed.prompt = replaceFilenames(parsed.prompt, renames);
    return JSON.stringify(parsed);
  } catch {
    // 请求体损坏时原样返回：由提交阶段报错，避免此处吞掉问题
    return requestBodyJson;
  }
}

/**
 * 判断提交失败是否属于「永久性失败」。
 * 永久性失败（工作流本身有问题，如 payload 非法）不应改投其他成员，直接置任务失败；
 * 其余（网络异常、超时、5xx、实例级故障）视为瞬时故障，保留任务在队列中等待重试。
 * @param message 提交失败的错误信息
 * @returns 永久性失败返回 true
 */
export function isPermanentSubmitError(message: string | null): boolean {
  if (!message) return false;
  // 服务端返回 4xx 说明请求本身不被接受，换实例也不会成功
  return /status\s+4\d\d/i.test(message);
}

/**
 * 统一队列调度器。
 *
 * 重构后所有 queued 任务（无论目标为分组还是具体实例）都由本调度器消费，
 * 不再有「空闲直接提交」的旁路，也不再有实例跟踪器内的第二套队列消费逻辑：
 *
 * 1. 分组队列（drainGroup）：取该分组最早的 queued 任务，
 *    在可分配成员中按策略（priority / random / failover 灾备模式）挑选成员提交；
 * 2. 实例队列（drainProvider）：取锁定到该实例的最早的 queued 任务，
 *    实例有空闲槽位且探测通过时提交。
 *
 * 提交动作统一走 submitTask：探测目标实例 → 上传暂存媒体 → 回写文件名 →
 * 提交 prompt → 写入实际执行实例。任务记录中的请求体始终保留暂存名形态，
 * 改投其他实例重试时据此重新回写。
 *
 * 并发保护：同一任务不会同时被两轮调度处理（taskInFlight 集合 + 每队列串行 drain）。
 */
export class DispatcherService {
  private readonly taskService: TaskService;
  private readonly providerService: ProviderService;
  /** 正在调度中的分组 ID（每分组串行，避免同一任务重复提交） */
  private readonly groupInFlight = new Set<string>();
  /** 正在调度中的实例 ID（每实例串行，避免同一任务重复提交） */
  private readonly providerInFlight = new Set<string>();
  /** 正在处理中的任务 ID */
  private readonly taskInFlight = new Set<string>();
  /**
   * 每轮调度中「已尝试且失败」的成员（按任务 ID 记录）。
   * 用于在某个候选探测失败/提交瞬时故障后，把任务改投下一个可用候选，
   * 而不是让整个队列停摆。
   */
  private readonly attemptedMembers = new Map<string, Set<string>>();
  /**
   * 灾备模式等待日志的去重记录：任务 ID → 上次记录的「等待梯队成员签名」。
   * 灾备模式下最高权重梯队满载时任务会持续等待，而兜底扫描每 30s 就会重新触发一轮调度；
   * 若不去重，同一等待状态会在日志中反复刷屏。仅当等待对象（梯队成员集合）变化时才重新记录。
   */
  private readonly failoverWaitLogged = new Map<string, string>();
  /** 队列兜底扫描定时器 */
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param db Drizzle 数据库实例
   * @param healthService 健康检测服务（挑选成员时据此跳过不可用实例）
   */
  constructor(
    db: BetterSQLite3Database<typeof schema>,
    private readonly healthService: HealthService,
  ) {
    this.taskService = new TaskService(db);
    this.providerService = new ProviderService(db);
  }

  /**
   * 调度全部队列：每个启用中的分组 + 每个启用中的非分组实例各一轮。
   * 供槽位释放通知、兜底扫描与外部入口统一调用。
   */
  async drainAll(): Promise<void> {
    // 先消费实例队列（目标已锁定的任务优先投递），再消费分组队列
    for (const row of this.providerService.listEnabled()) {
      if (row.type === 'group') continue;
      await this.drainProvider(row.id);
    }
    for (const group of this.listEnabledGroups()) {
      await this.drainGroup(group.id);
    }
  }

  /**
   * 调度单个分组的队列，直到没有可提交的任务。
   * @param groupId 分组实例 ID
   */
  async drainGroup(groupId: string): Promise<void> {
    // 重入保护：同一分组同时只跑一轮调度
    if (this.groupInFlight.has(groupId)) return;
    this.groupInFlight.add(groupId);
    try {
      const group = this.providerService.resolveGroupById(groupId);
      if (!group) return;
      for (let round = 0; round < dispatcherConfig.maxSubmitsPerRound; round++) {
        const queued = this.taskService.listQueuedByTarget(groupId);
        if (queued.length === 0) break;
        const task = queued[0];
        // 该任务已被其他路径处理中，避免重复提交
        if (this.taskInFlight.has(task.id)) break;
        // 本轮已经尝试过并失败的成员（探测失败/提交瞬时故障），避免重复尝试同一个
        const attempted = this.attemptedMembers.get(task.id) ?? new Set<string>();
        this.attemptedMembers.set(task.id, attempted);
        const member = this.pickMember(group, attempted, task.id);
        // 无可用候选（槽位全满或全部已在冷却/本轮已失败）：本轮结束，任务留在队列等待。
        // 灾备模式下「最高权重梯队满载」也走此分支：任务原地等待槽位释放，不降级到低权重成员
        if (!member) {
          this.attemptedMembers.delete(task.id);
          break;
        }
        const outcome = await this.submitTask(task.id, member.provider, `group:${group.id}`);
        if (outcome === 'submitted') {
          this.forgetTaskAttempts(task.id);
          // 提交成功后继续尝试填满其余空闲槽位
          continue;
        }
        if (outcome === 'member-failed') {
          // 当前成员故障（已进入冷却）：记住它，本轮改投其他可用成员
          attempted.add(member.providerId);
          continue;
        }
        // 任务永久失败：清理记录，继续处理队列中的下一个任务
        this.forgetTaskAttempts(task.id);
      }
    } catch (err: unknown) {
      console.error(`[Dispatcher:${groupId}] drainGroup error`, err);
    } finally {
      this.groupInFlight.delete(groupId);
    }
  }

  /**
   * 调度单个实例的队列，直到没有可提交的任务。
   * 目标已锁定为该实例的排队任务（actualProviderId = 实例 ID），
   * 实例有空闲并发槽位且探测通过时按提交顺序投递。
   * @param providerId 实例 ID
   */
  async drainProvider(providerId: string): Promise<void> {
    // 重入保护：同一实例同时只跑一轮调度
    if (this.providerInFlight.has(providerId)) return;
    this.providerInFlight.add(providerId);
    try {
      // 实例已停用/删除/配置非法时队列不再消费（resolver 返回 null）
      const provider = this.providerService.getEnabledProviderById(providerId);
      if (!provider || provider.type === 'group') return;
      for (let round = 0; round < dispatcherConfig.maxSubmitsPerRound; round++) {
        // 槽位已满：本轮结束，任务留在队列等待槽位释放
        if (this.slotsOf(provider) <= 0) break;
        const queued = this.taskService.listQueuedByTarget(providerId);
        if (queued.length === 0) break;
        const task = queued[0];
        // 该任务已被其他路径处理中，避免重复提交
        if (this.taskInFlight.has(task.id)) break;
        const outcome = await this.submitTask(task.id, provider, `provider:${provider.id}`);
        if (outcome === 'submitted') {
          // 提交成功后继续尝试填满其余空闲槽位
          continue;
        }
        // 指定实例场景：探测失败/提交瞬时故障已冷却该实例，本轮结束等待恢复；
        // 任务永久失败已置终态，队列继续消费由下一轮兜底扫描驱动
        break;
      }
    } catch (err: unknown) {
      console.error(`[Dispatcher:${providerId}] drainProvider error`, err);
    } finally {
      this.providerInFlight.delete(providerId);
    }
  }

  /**
   * 提交单个排队任务到指定目标实例（插队入口，无视并发上限）。
   * 供任务控制器「立即提交」使用：调用前需自行探测目标实例连通性。
   * @param taskId 任务 ID（须为 queued 状态）
   * @param provider 目标实例（非分组）
   * @returns 处理结果：submitted=提交成功；failed=任务永久失败；unavailable=实例不可用/状态已变
   */
  async submitTaskNow(
    taskId: string,
    provider: ExecutionProvider,
  ): Promise<'submitted' | 'failed' | 'unavailable'> {
    // 任务已被其他路径改状态（如手动取消）时无需提交
    const task = this.taskService.getById(taskId);
    if (!task || task.status !== 'queued') return 'failed';
    if (!task.comfyuiRequestBody) {
      // 请求体缺失属于数据问题，重试无意义
      this.taskService.updateStatus(taskId, { status: 'failed', errorMessage: 'Missing request body' });
      void releaseStaged(taskId);
      return 'failed';
    }
    this.taskInFlight.add(taskId);
    try {
      const outcome = await this.submitToProvider(taskId, provider, `manual:${provider.id}`);
      // 归一化：member-failed 在手动入口语义上即「实例不可用」；task-failed 即任务永久失败
      if (outcome === 'member-failed') return 'unavailable';
      return outcome === 'submitted' ? 'submitted' : 'failed';
    } finally {
      this.taskInFlight.delete(taskId);
    }
  }

  /**
   * 在分组成员中挑选一个可提交任务的成员。
   * 通用候选条件：在线（未处于健康冷却期）且本轮尚未尝试失败过。
   * 策略：
   * - priority：在「有空闲槽位」的候选中按算力性能权重降序取第一个；权重相同时按分组成员配置顺序
   * - random：在「有空闲槽位」的候选中等概率随机挑选
   * - failover（灾备模式）：只认权重最大的在线梯队；梯队内任一成员有空闲槽位即提交，
   *   整个梯队满载时**原地等待**（返回 null，由调用方结束本轮），绝不降级到低权重成员；
   *   仅当该梯队离线（冷却中或本轮已失败）时才顺延到下一个权重梯队
   * @param group 分组 provider
   * @param attempted 本轮已尝试失败的成员 ID 集合
   * @param taskId 队头任务 ID（仅供灾备模式的等待日志去重使用）
   * @returns 选中的成员；无可用候选或灾备模式需等待槽位释放时返回 null
   */
  private pickMember(group: GroupProvider, attempted: Set<string>, taskId: string): ResolvedGroupMember | null {
    // 在线且本轮未失败过的成员，按权重降序稳定排序（同权重保持分组成员配置顺序）
    const online = group.listMembers()
      .filter((member) => !attempted.has(member.providerId) && this.healthService.isHealthy(member.providerId))
      .sort((a, b) => b.weight - a.weight);
    if (online.length === 0) return null;

    // 灾备模式：候选集合必须包含满载成员（否则会误判为「无候选」而静默降级），故单独挑选
    if (group.getDispatchPolicy() === 'failover') {
      return this.pickFailoverMember(online, taskId);
    }

    // priority / random：仅在有空闲槽位的在线成员中挑选
    const available = online.filter((member) => this.slotsOf(member.provider) > 0);
    if (available.length === 0) return null;

    if (group.getDispatchPolicy() === 'random') {
      // 随机策略：等概率挑选一个可用候选
      const index = Math.floor(Math.random() * available.length);
      return available[index];
    }

    // 按权重优先：已按权重降序排序，取第一个（权重相同时即配置顺序最靠前者）
    return available[0];
  }

  /**
   * 灾备模式的成员挑选：固定使用权重最大的在线梯队。
   *
   * 权重相同的成员构成同一优先级梯队，梯队内优先使用有空闲槽位的成员（同权重按配置顺序取第一个空闲者）；
   * 整个梯队都满载时返回 null，让任务留在队列**等待槽位释放**——这正是灾备模式与 priority 的核心差异：
   * 不会因为满载而降级使用低权重成员。只有当梯队内成员全部离线（冷却中或本轮已失败）时，
   * 调用方的下一轮挑选才会顺延到下一个权重梯队。
   * @param online 在线且本轮未失败过的成员（已按权重降序排序，首项即最高权重）
   * @param taskId 队头任务 ID（等待日志去重用）
   * @returns 选中的成员；最高权重梯队满载需等待时返回 null
   */
  private pickFailoverMember(online: ResolvedGroupMember[], taskId: string): ResolvedGroupMember | null {
    // 排序后首项的权重即最高权重，同权重成员构成一个梯队
    const topWeight = online[0].weight;
    const tier = online.filter((member) => member.weight === topWeight);

    // 梯队内任有空闲槽位即可提交（同权重时按配置顺序取第一个空闲者）
    const free = tier.find((member) => this.slotsOf(member.provider) > 0);
    if (free) {
      // 任务已脱离等待状态：清理去重记录，便于它下次因满载而等待时重新提示
      this.failoverWaitLogged.delete(taskId);
      return free;
    }

    // 梯队整体满载：不降级到低权重成员，任务留在队列等待槽位释放，
    // 由槽位释放回调 / 健康巡检回调 / 兜底扫描唤醒后重试
    this.logFailoverWait(taskId, tier);
    return null;
  }

  /**
   * 记录一次灾备模式「最高权重梯队满载而等待」的日志（按任务去重，避免反复刷屏）。
   * @param taskId 队头任务 ID
   * @param tier 正在等待的最高权重梯队成员
   */
  private logFailoverWait(taskId: string, tier: ResolvedGroupMember[]): void {
    // 等待对象未变化时不重复记录（兜底扫描每 30s 就会触发一轮调度）
    const signature = tier.map((member) => member.providerId).join(',');
    if (this.failoverWaitLogged.get(taskId) === signature) return;
    this.failoverWaitLogged.set(taskId, signature);
    const names = tier.map((member) => member.providerName).join('、');
    console.info(`[Dispatcher] failover: task ${taskId} waits for a free slot on ${names}`);
  }

  /**
   * 清理某个任务的调度中间态记录（已提交 / 永久失败后调用），避免内存长期累积。
   * @param taskId 任务 ID
   */
  private forgetTaskAttempts(taskId: string): void {
    this.attemptedMembers.delete(taskId);
    this.failoverWaitLogged.delete(taskId);
  }

  /**
   * 计算实例当前空闲的并发槽位。
   * 统一按 actual_provider_id 统计 pending 任务（分组任务调度后 actual 即成员实例）。
   * @param provider 实例
   * @returns 空闲槽位数
   */
  private slotsOf(provider: ExecutionProvider): number {
    const pending = this.taskService.countPendingByActualProvider(provider.id);
    return Math.max(provider.concurrency - pending, 0);
  }

  /**
   * 把队列中的任务提交到指定实例（探测 → 上传媒体 → 回写文件名 → 提交）。
   * 自动调度路径的统一入口（分组选定的成员 / 锁定的目标实例共用）。
   * @param taskId 任务 ID（须为 queued 状态）
   * @param provider 目标实例
   * @param context 日志定位用的调度来源（如 group:<id> / provider:<id>）
   * @returns 处理结果：submitted=提交成功；member-failed=实例故障（已冷却）；task-failed=任务永久失败
   */
  private async submitTask(
    taskId: string,
    provider: ExecutionProvider,
    context: string,
  ): Promise<'submitted' | 'member-failed' | 'task-failed'> {
    // 任务已被其他路径改状态（如手动取消）时无需提交
    const task = this.taskService.getById(taskId);
    if (!task || task.status !== 'queued') return 'task-failed';
    if (!task.comfyuiRequestBody) {
      // 请求体缺失属于数据问题，重试无意义
      this.taskService.updateStatus(taskId, { status: 'failed', errorMessage: 'Missing request body' });
      void releaseStaged(taskId);
      return 'task-failed';
    }

    this.taskInFlight.add(taskId);
    try {
      return await this.submitToProvider(taskId, provider, context);
    } finally {
      this.taskInFlight.delete(taskId);
    }
  }

  /**
   * 提交核心流程：探测目标实例 → 上传暂存媒体 → 回写文件名 → 提交 prompt。
   * 调用方保证任务处于 queued 状态且有请求体。
   * @param taskId 任务 ID
   * @param provider 目标实例
   * @param context 日志定位用的调度来源
   * @returns 处理结果：submitted=提交成功；member-failed=实例故障（已冷却）；task-failed=任务永久失败
   */
  private async submitToProvider(
    taskId: string,
    provider: ExecutionProvider,
    context: string,
  ): Promise<'submitted' | 'member-failed' | 'task-failed'> {
    const task = this.taskService.getById(taskId)!;
    const requestBodyJson = task.comfyuiRequestBody!;

    // 提交前即时探测目标实例，避免向刚宕机的实例提交
    const probe = await provider.testConnection();
    if (!probe.ok) {
      this.healthService.markFailedNow(provider.id, probe.message);
      console.warn(`[Dispatcher:${context}] target ${provider.name} unavailable: ${probe.message}`);
      return 'member-failed';
    }
    this.healthService.markHealthy(provider.id);

    // 1) 把暂存媒体上传到最终选定的实例（各实例文件存储相互独立）
    let renames: Map<string, string>;
    try {
      renames = await this.uploadStagedMedia(task.id, task.originalForm, provider);
    } catch (err: unknown) {
      // 上传失败（网络/HTTP/平台拒绝）属实例级故障：标记冷却并改投其他候选。
      // 不在此处收敛会让任务每轮兜底扫描都重试同一个故障实例，长期滞留在队列中
      const message = err instanceof Error ? err.message : String(err);
      this.healthService.markFailedNow(provider.id, message);
      console.error(`[Dispatcher:${context}] upload media failed on ${provider.name} `
        + `(task ${taskId}): ${message}`);
      return 'member-failed';
    }
    // 2) 用实例侧实际文件名回写请求体：暂存名只在本地有效，提交时必须引用实例上的真实文件名。
    //    请求体仍以「暂存名」形态留在任务记录中，使改投其他实例重试时能基于同一份暂存信息重新回写
    const requestBody = rewriteUploadedFilenames(requestBodyJson, renames);
    if (renames.size > 0) {
      // 记录实例侧真实文件名：终态后的资产自动清理按该名单删除（暂存名在实例上并不存在）
      this.taskService.addUploadedFiles(task.id, [...renames.values()]);
    }
    // 3) 提交到实例
    const result = await provider.submitPrompt(requestBody);
    if (result.success) {
      const input: UpdateActualProviderInput = {
        actualProviderId: provider.id,
        actualProviderName: provider.name,
        promptId: result.promptId ?? '',
        comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
      };
      this.taskService.updateActualProvider(taskId, input);
      // 任务已由该实例执行，暂存文件不再需要
      void releaseStaged(taskId);
      return 'submitted';
    }

    // 提交失败：区分永久性失败（工作流问题）与瞬时故障（实例问题）
    const failureDetail = `[Dispatcher:${context}] submit failed on ${provider.name} `
      + `(task ${taskId}): ${result.errorMessage ?? 'Submit failed'}`;
    const failureResponse = `[Dispatcher:${context}] task ${taskId} original response: `
      + `${result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : '<none>'}`;
    if (isPermanentSubmitError(result.errorMessage)) {
      // 永久性失败不会重试：必须打印原始错误，否则问题只留在任务记录里无人可见
      console.error(failureDetail);
      console.error(failureResponse);
      this.taskService.updateStatus(taskId, {
        status: 'failed',
        errorMessage: result.errorMessage ?? 'Submit failed',
        comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
      });
      void releaseStaged(taskId);
      return 'task-failed';
    }
    // 瞬时故障：标记实例不可用并停止本轮，任务保留在队列中改投其他实例（打印原始错误便于排查）
    this.healthService.markFailedNow(provider.id, result.errorMessage ?? 'Submit failed');
    console.error(failureDetail);
    console.error(failureResponse);
    return 'member-failed';
  }

  /**
   * 把任务暂存的媒体上传到选定实例。
   * 无暂存文件的任务直接返回空映射，不影响提交流程。
   * @param taskId 任务 ID
   * @param originalFormJson 任务原始表单 JSON（携带 stagedFiles）
   * @param provider 目标实例
   * @returns 暂存名 → 实例侧实际文件名的映射（仅包含发生改名的文件，未改名/无文件时为空）
   */
  private async uploadStagedMedia(
    taskId: string,
    originalFormJson: string | null,
    provider: ExecutionProvider,
  ): Promise<Map<string, string>> {
    const renames = new Map<string, string>();
    const stagedFiles = this.parseStagedFiles(originalFormJson);
    if (stagedFiles.length === 0) return renames;

    // 读取暂存文件（保留与元数据的配对），逐个上传到选定的实例
    const entries = await readStagedFilesWithMeta(taskId, stagedFiles);
    for (const { meta, file } of entries) {
      // 实际文件名由实例决定（ComfyUI 上传时重新生成唯一名，RunningHub 由平台分配），
      // 与暂存名不同时必须回写请求体，否则节点会引用该实例上不存在的文件
      const uploaded = await provider.uploadMedia(file, meta.paramType as MediaType);
      if (uploaded && uploaded !== meta.stagedName) {
        renames.set(meta.stagedName, uploaded);
      }
    }
    return renames;
  }

  /**
   * 从任务原始表单中解析暂存文件列表。
   * @param originalFormJson 原始表单 JSON
   * @returns 暂存文件元数据；无暂存文件或解析失败时返回空数组
   */
  private parseStagedFiles(originalFormJson: string | null): StagedFileMeta[] {
    if (!originalFormJson) return [];
    try {
      const parsed = JSON.parse(originalFormJson) as { stagedFiles?: unknown };
      const staged = parsed.stagedFiles;
      if (!Array.isArray(staged)) return [];
      // 仅保留字段完整的条目
      return staged.filter((item): item is StagedFileMeta => {
        if (!item || typeof item !== 'object') return false;
        const meta = item as Partial<StagedFileMeta>;
        return typeof meta.alias === 'string'
          && typeof meta.stagedName === 'string'
          && typeof meta.originalname === 'string';
      });
    } catch {
      // 表单损坏时视为无暂存文件，交由提交阶段的错误处理
      return [];
    }
  }

  /**
   * 列出启用中的分组实例。
   * @returns 分组 provider 列表（配置非法的分组被跳过）
   */
  private listEnabledGroups(): GroupProvider[] {
    const groups: GroupProvider[] = [];
    for (const row of this.providerService.listEnabled()) {
      if (row.type !== 'group') continue;
      const group = this.providerService.resolveGroupById(row.id);
      if (group) groups.push(group);
    }
    return groups;
  }

  /**
   * 启动队列兜底扫描：周期性触发一次全量调度，
   * 补偿遗漏的槽位释放通知（例如实例被外部恢复可用）。
   */
  start(): void {
    if (this.fallbackTimer) return;
    this.fallbackTimer = setInterval(() => {
      void this.drainAll().catch((err: unknown) => {
        console.error('[Dispatcher] fallback drain failed', err);
      });
    }, dispatcherConfig.fallbackIntervalMs);
  }

  /** 停止兜底扫描 */
  stop(): void {
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.groupInFlight.clear();
    this.providerInFlight.clear();
    this.taskInFlight.clear();
    this.attemptedMembers.clear();
    this.failoverWaitLogged.clear();
  }
}
