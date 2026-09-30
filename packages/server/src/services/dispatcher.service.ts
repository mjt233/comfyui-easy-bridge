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
 * 分组队列调度器。
 *
 * 职责：消费「提交到分组」的任务队列。每个分组独立排队，调度时：
 * 1. 取该分组最早的 queued 任务；
 * 2. 在可分配成员中按策略挑选一个有空闲槽位、且通过可用性检测的成员；
 * 3. 把暂存的媒体上传到该成员，提交任务，并把实际执行实例写入任务记录。
 *
 * 并发保护：同一任务不会同时被两轮调度处理（in-flight 集合 + 每分组串行 drain）。
 */
export class DispatcherService {
  private readonly taskService: TaskService;
  private readonly providerService: ProviderService;
  /** 正在调度中的分组 ID（每分组串行，避免同一任务重复提交） */
  private readonly groupInFlight = new Set<string>();
  /** 正在处理中的任务 ID */
  private readonly taskInFlight = new Set<string>();
  /**
   * 每轮调度中「已尝试且失败」的成员（按任务 ID 记录）。
   * 用于在某个候选探测失败/提交瞬时故障后，把任务改投下一个可用候选，
   * 而不是让整个队列停摆。
   */
  private readonly attemptedMembers = new Map<string, Set<string>>();
  /** 队列兜底扫描定时器 */
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param db Drizzle 数据库实例
   * @param healthService 健康检测服务（挑选成员时据此跳过不可用实例）
   */
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
   * 调度全部分组队列。
   * @returns 本轮发生提交的成员实例 ID 列表（供调用方按需刷新跟踪）
   */
  async drainAll(): Promise<string[]> {
    const groups = this.listEnabledGroups();
    const touched: string[] = [];
    for (const group of groups) {
      const submitted = await this.drainGroup(group.id);
      touched.push(...submitted);
    }
    return touched;
  }

  /**
   * 调度单个分组的队列，直到没有可提交的任务。
   * @param groupId 分组实例 ID
   * @returns 本轮发生提交的成员实例 ID 列表
   */
  async drainGroup(groupId: string): Promise<string[]> {
    // 重入保护：同一分组同时只跑一轮调度
    if (this.groupInFlight.has(groupId)) return [];
    this.groupInFlight.add(groupId);
    const submittedMembers: string[] = [];
    try {
      const group = this.providerService.resolveGroupById(groupId);
      if (!group) return [];
      for (let round = 0; round < dispatcherConfig.maxSubmitsPerRound; round++) {
        const queued = this.taskService.listQueuedByGroups([groupId]);
        if (queued.length === 0) break;
        const task = queued[0];
        // 该任务已被其他路径处理中，避免重复提交
        if (this.taskInFlight.has(task.id)) break;
        // 本轮已经尝试过并失败的成员（探测失败/提交瞬时故障），避免重复尝试同一个
        const attempted = this.attemptedMembers.get(task.id) ?? new Set<string>();
        this.attemptedMembers.set(task.id, attempted);
        const member = this.pickMember(group, attempted);
        // 无可用候选（槽位全满或全部已在冷却/本轮已失败）：本轮结束，任务留在队列等待
        if (!member) {
          this.attemptedMembers.delete(task.id);
          break;
        }
        const outcome = await this.submitTask(group, member, task.id);
        if (outcome === 'submitted') {
          submittedMembers.push(member.providerId);
          this.attemptedMembers.delete(task.id);
          // 提交成功后继续尝试填满其余空闲槽位
          continue;
        }
        if (outcome === 'member-failed') {
          // 当前成员故障（已进入冷却）：记住它，本轮改投其他可用成员
          attempted.add(member.providerId);
          continue;
        }
        // 任务永久失败：清理记录，继续处理队列中的下一个任务
        this.attemptedMembers.delete(task.id);
      }
      return submittedMembers;
    } catch (err: unknown) {
      console.error(`[Dispatcher:${groupId}] drainGroup error`, err);
      return submittedMembers;
    } finally {
      this.groupInFlight.delete(groupId);
    }
  }

  /**
   * 在分组成员中挑选一个可提交任务的成员。
   * 候选条件：健康（未处于冷却期）、有空闲并发槽位、且本轮尚未尝试失败过。
   * 策略：
   * - priority：按算力性能权重降序，取第一个满足条件的候选；权重相同时按分组成员配置顺序
   * - random：在满足条件的候选中随机挑选
   * @param group 分组 provider
   * @param attempted 本轮已尝试失败的成员 ID 集合
   * @returns 选中的成员；无可用候选时返回 null
   */
  private pickMember(group: GroupProvider, attempted: Set<string>): ResolvedGroupMember | null {
    // 过滤出健康、有空闲槽位且本轮未失败过的候选
    const candidates = group.listMembers().filter((member) => {
      if (attempted.has(member.providerId)) return false;
      if (!this.healthService.isHealthy(member.providerId)) return false;
      return this.slotsOf(member) > 0;
    });
    if (candidates.length === 0) return null;

    if (group.getDispatchPolicy() === 'random') {
      // 随机策略：等概率挑选一个可用候选
      const index = Math.floor(Math.random() * candidates.length);
      return candidates[index];
    }

    // 按权重优先：权重降序；权重相同时保持分组成员配置顺序（稳定排序）
    const sorted = [...candidates].sort((a, b) => b.weight - a.weight);
    return sorted[0];
  }

  /**
   * 计算成员实例当前空闲的并发槽位。
   * 分组任务的 provider_id 为分组 ID，因此必须按 actual_provider_id 统计。
   * @param member 成员
   * @returns 空闲槽位数
   */
  private slotsOf(member: ResolvedGroupMember): number {
    const pending = this.taskService.countPendingByActualProvider(member.providerId);
    return Math.max(member.provider.concurrency - pending, 0);
  }

  /**
   * 把队列中的任务提交到指定成员实例。
   * @param group 分组 provider（用于日志定位）
   * @param member 目标成员
   * @param taskId 任务 ID
   * @returns 处理结果：submitted=提交成功；member-failed=成员故障（已冷却）；task-failed=任务永久失败
   */
  private async submitTask(
    group: GroupProvider,
    member: ResolvedGroupMember,
    taskId: string,
  ): Promise<'submitted' | 'member-failed' | 'task-failed'> {
    const task = this.taskService.getById(taskId);
    // 任务已被其他路径改状态（如手动取消）时无需提交
    if (!task || task.status !== 'queued') return 'task-failed';

    // 提交前即时探测候选实例，避免向刚宕机的实例提交
    const probe = await member.provider.testConnection();
    if (!probe.ok) {
      this.healthService.markFailedNow(member.providerId, probe.message);
      console.warn(`[Dispatcher:${group.id}] member ${member.providerName} unavailable: ${probe.message}`);
      return 'member-failed';
    }
    this.healthService.markHealthy(member.providerId);

    // 探测期间可能已有其他任务占满槽位，二次确认
    if (this.slotsOf(member) <= 0) return 'task-failed';

    // 提交前再次确认任务仍处于排队状态，避免与外部状态变更竞争
    const fresh = this.taskService.getById(taskId);
    if (!fresh || fresh.status !== 'queued') return 'task-failed';
    if (!fresh.comfyuiRequestBody) {
      // 请求体缺失属于数据问题，重试无意义
      this.taskService.updateStatus(taskId, { status: 'failed', errorMessage: 'Missing request body' });
      void releaseStaged(taskId);
      return 'task-failed';
    }

    this.taskInFlight.add(taskId);
    try {
      // 1) 把暂存媒体上传到最终选定的成员实例（各实例文件存储相互独立）
      let renames: Map<string, string>;
      try {
        renames = await this.uploadStagedMedia(fresh.id, fresh.originalForm, member.provider);
      } catch (err: unknown) {
        // 上传失败（网络/HTTP/平台拒绝）属实例级故障：标记冷却并改投其他候选。
        // 不在此处收敛会让任务每轮兜底扫描都重试同一个故障成员，长期滞留在队列中
        const message = err instanceof Error ? err.message : String(err);
        this.healthService.markFailedNow(member.providerId, message);
        console.error(`[Dispatcher:${group.id}] upload media failed on ${member.providerName} `
          + `(task ${taskId}): ${message}`);
        return 'member-failed';
      }
      // 2) 用实例侧实际文件名回写请求体：暂存名只在本地有效，提交时必须引用成员实例上的真实文件名。
      //    请求体仍以「暂存名」形态留在任务记录中，使改投其他成员重试时能基于同一份暂存信息重新回写
      const requestBody = rewriteUploadedFilenames(fresh.comfyuiRequestBody, renames);
      if (renames.size > 0) {
        // 记录实例侧真实文件名：终态后的资产自动清理按该名单删除（暂存名在成员实例上并不存在）
        this.taskService.addUploadedFiles(fresh.id, [...renames.values()]);
      }
      // 3) 提交到成员实例
      const result = await member.provider.submitPrompt(requestBody);
      if (result.success) {
        const input: UpdateActualProviderInput = {
          actualProviderId: member.providerId,
          actualProviderName: member.providerName,
          promptId: result.promptId ?? '',
          comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
        };
        this.taskService.updateActualProvider(taskId, input);
        // 任务已由该成员执行，暂存文件不再需要
        void releaseStaged(taskId);
        return 'submitted';
      }

      // 提交失败：区分永久性失败（工作流问题）与瞬时故障（实例问题）
      const failureDetail = `[Dispatcher:${group.id}] submit failed on ${member.providerName} `
        + `(task ${taskId}): ${result.errorMessage ?? 'Submit failed'}`;
      const failureResponse = `[Dispatcher:${group.id}] task ${taskId} original response: `
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
      // 瞬时故障：标记成员不可用并停止本轮，任务保留在队列中改投其他成员（打印原始错误便于排查）
      this.healthService.markFailedNow(member.providerId, result.errorMessage ?? 'Submit failed');
      console.error(failureDetail);
      console.error(failureResponse);
      return 'member-failed';
    } finally {
      this.taskInFlight.delete(taskId);
    }
  }

  /**
   * 把任务暂存的媒体上传到选定成员实例。
   * 普通（未暂存）任务无暂存文件，直接返回空映射，不影响既有逻辑。
   * @param taskId 任务 ID
   * @param originalFormJson 任务原始表单 JSON（携带 stagedFiles）
   * @param provider 目标成员实例
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

    // 读取暂存文件（保留与元数据的配对），逐个上传到选定的成员实例
    const entries = await readStagedFilesWithMeta(taskId, stagedFiles);
    for (const { meta, file } of entries) {
      // 实际文件名由成员实例决定（ComfyUI 上传时重新生成唯一名，RunningHub 由平台分配），
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
   * 补偿遗漏的槽位释放通知（例如成员实例被外部恢复可用）。
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
    this.taskInFlight.clear();
    this.attemptedMembers.clear();
  }
}
