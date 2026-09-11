import WebSocket from 'ws';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from './task.service';
import { ProviderService } from './providers/provider.service';
import { HealthService } from './providers/health.service';
import { DispatcherService } from './dispatcher.service';
import { cleanupTaskUploads } from './cleanup.service';
import { releaseStaged } from './task-staging.service';
import { COMFYUI_CLIENT_ID } from './providers/types';
import type { ExecutionProvider } from './providers/types';

/**
 * 执行服务可调参数。
 * 抽为对象供测试覆盖（缩短间隔），避免用例真实等待。
 */
export const executionServiceConfig = {
  /** 后备轮询 /history 的间隔（毫秒），同时驱动队列兜底扫描 */
  fallbackIntervalMs: 10000,
  /** 进度 100% 但尚未完成任务的快速轮询间隔（毫秒） */
  completionPollIntervalMs: 1000,
  /** WebSocket 断线后的重连延迟（毫秒） */
  reconnectDelayMs: 5000,
};

/**
 * ComfyUI /history 条目解析结果。
 * - running: 尚无 history 条目（仍在队列或执行中）
 * - completed: 执行成功
 * - failed: 执行失败或中断
 */
export type HistoryOutcome =
  | { kind: 'running' }
  | { kind: 'completed' }
  | { kind: 'failed'; errorMessage: string };

/**
 * 从 ComfyUI status.messages 中提取可读错误信息。
 * messages 形如 [eventName, payload][]，payload 可能含 exception_message。
 * @param messages ComfyUI history status.messages
 * @returns 错误文案；无法提取时返回 null
 */
function extractErrorMessageFromMessages(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;

  let sawInterrupted = false;
  for (const entry of messages) {
    if (!Array.isArray(entry) || entry.length < 1) continue;
    const eventName = entry[0];
    const payload = entry[1];

    // 优先使用 execution_error 的 exception_message
    if (eventName === 'execution_error') {
      if (payload && typeof payload === 'object') {
        const msg = (payload as { exception_message?: unknown }).exception_message;
        if (typeof msg === 'string' && msg.trim() !== '') {
          return msg;
        }
      }
      return 'Execution error';
    }

    if (eventName === 'execution_interrupted') {
      sawInterrupted = true;
    }
  }

  if (sawInterrupted) {
    return 'Execution interrupted';
  }
  return null;
}

/**
 * 解析 ComfyUI GET /history/{promptId} 响应，判断任务是否仍在执行、已成功或已失败。
 * 仍在执行时 history 通常为 `{}`（无对应 prompt 条目）。
 * 失败时 status_str 为 `error` 且 completed 为 false。
 * @param historyData /history 或 /history/{id} 的 JSON 响应
 * @param promptId ComfyUI prompt_id
 * @returns HistoryOutcome
 */
export function resolveHistoryOutcome(historyData: unknown, promptId: string): HistoryOutcome {
  // 无有效对象时视为仍在执行
  if (!historyData || typeof historyData !== 'object') {
    return { kind: 'running' };
  }

  const promptEntry = (historyData as Record<string, unknown>)[promptId];
  if (!promptEntry || typeof promptEntry !== 'object') {
    return { kind: 'running' };
  }

  const statusObj = (promptEntry as {
    status?: {
      status_str?: unknown;
      completed?: unknown;
      messages?: unknown;
    };
  }).status;

  // 有条目但无 status 时保守视为仍在执行
  if (!statusObj || typeof statusObj !== 'object') {
    return { kind: 'running' };
  }

  const statusStr = typeof statusObj.status_str === 'string' ? statusObj.status_str : null;
  const completed = statusObj.completed === true;
  const messageError = extractErrorMessageFromMessages(statusObj.messages);

  // 成功：status_str=success 或 completed=true
  if (statusStr === 'success' || completed) {
    return { kind: 'completed' };
  }

  // 失败：status_str=error，或 messages 中含错误/中断事件
  if (statusStr === 'error' || messageError != null) {
    return {
      kind: 'failed',
      errorMessage: messageError ?? 'Execution error',
    };
  }

  // 未知 status 形态：不贸然终态化
  return { kind: 'running' };
}

/**
 * 将任意异常消息安全转为字符串。
 * @param value WebSocket 或 history 中的错误字段
 * @param fallback 默认文案
 */
function toErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (value == null) return fallback;
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

/**
 * 解析 ComfyUI /history/{promptId} 响应中的输出文件。
 * 供 WebSocket 完成路径与任务输出列表读路径兜底复用。
 * @param historyData /history 或 /history/{id} 的 JSON 响应
 * @param promptId ComfyUI prompt_id
 * @returns 输出文件列表；无有效 outputs 时返回空数组
 */
export function parseHistoryOutputs(historyData: unknown, promptId: string): OutputFile[] {
  const result: OutputFile[] = [];
  if (!historyData || typeof historyData !== 'object') return result;
  const promptEntry = (historyData as Record<string, unknown>)[promptId];
  if (!promptEntry || typeof promptEntry !== 'object') return result;
  const outputs = (promptEntry as { outputs?: Record<string, unknown> }).outputs;
  if (!outputs) return result;

  const typeKeyMap: Record<string, 'image' | 'video' | 'audio'> = {
    images: 'image',
    videos: 'video',
    audio: 'audio',
  };

  for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
    if (!nodeOutput || typeof nodeOutput !== 'object') continue;
    for (const [key, items] of Object.entries(nodeOutput as Record<string, unknown>)) {
      const fileType = typeKeyMap[key] ?? guessFileType(key);
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item && typeof item === 'object') {
          const raw = item as Record<string, unknown>;
          if (raw.filename && typeof raw.filename === 'string') {
            result.push({
              filename: raw.filename,
              subfolder: typeof raw.subfolder === 'string' ? raw.subfolder : '',
              type: typeof raw.type === 'string' ? raw.type : 'output',
              nodeId,
              fileType,
            });
          }
        }
      }
    }
  }
  return result;
}

/** 按 ComfyUI 输出类型 key 或文件扩展名推断文件类型 */
function guessFileType(key: string): 'image' | 'video' | 'audio' {
  const lower = key.toLowerCase();
  if (lower.includes('image') || lower.includes('gif')) return 'image';
  if (lower.includes('video')) return 'video';
  if (lower.includes('audio')) return 'audio';
  const ext = lower.split('.').pop() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'avi', 'mov', 'mkv'].includes(ext)) return 'video';
  if (['wav', 'mp3', 'ogg', 'flac', 'aac'].includes(ext)) return 'audio';
  return 'image';
}

/** 单个提供商实例的跟踪器 */
interface ProviderTracker {
  /** 启动初始队列调度（服务启动/重建后立即处理 queued 任务） */
  init(): void;
  /** 立即触发一次队列调度（外部释放并发槽位后调用，如手动中断任务） */
  drain(): Promise<void>;
  /** 停止跟踪器：关闭 WebSocket 并清理定时器 */
  stop(): void;
}

/**
 * 活跃跟踪器的队列调度入口注册表（providerId → drain）。
 * 供跟踪器外部在释放并发槽位后主动触发调度（例如手动中断正在执行的任务）。
 * 进程内单例：随 startExecutionService 启动注册、停止或重建时清空。
 */
const providerDrains = new Map<string, () => Promise<void>>();

/**
 * 触发指定提供商实例的队列调度。
 * 实例未启用、不存在或执行服务未启动时静默返回，不抛异常。
 * @param providerId 提供商实例 ID
 */
export async function drainProviderQueue(providerId: string): Promise<void> {
  // 未注册该实例（未启用/已停止）时无事可做
  const drain = providerDrains.get(providerId);
  if (!drain) return;
  await drain();
}

/**
 * 分组队列调度入口。
 * 由执行服务在启动时注册（内部委派 DispatcherService.drainAll），
 * 供任务控制器在「取消排队中的分组任务」等场景主动触发。
 */
let groupQueueDrain: (() => Promise<void>) | null = null;

/**
 * 当前活跃的分组调度器。
 * 供控制器解析「发起本次请求时」的调度器实例（每次调用时解析，避免捕获陈旧实例）。
 */
let activeDispatcher: DispatcherService | null = null;

/** 触发全部分组的队列调度；执行服务未启动时静默返回 */
export async function drainGroupQueues(): Promise<void> {
  if (!groupQueueDrain) return;
  await groupQueueDrain();
}

/**
 * 分组队列调度器工厂。
 * 供任务/工作流控制器在请求处理期间按需获取「当前活跃」的调度器实例：
 * 每次调用时解析，避免控制器在模块加载阶段捕获到尚未创建的服务实例。
 * @returns 调度器实例；执行服务未启动时返回 null
 */
export function getActiveDispatcher(): DispatcherService | null {
  return activeDispatcher;
}

/**
 * 当前活跃的健康检测服务。
 * 供控制器读取实例可用性快照（设置页展示成员空闲槽位与冷却状态）；
 * 执行服务未启动（如单元测试）时为 null，调用方需容忍缺失。
 */
let activeHealthService: HealthService | null = null;

/**
 * 读取当前活跃的健康检测服务。
 * @returns 健康检测服务；执行服务未启动时返回 null
 */
export function getActiveHealthService(): HealthService | null {
  return activeHealthService;
}

/**
 * 为单个提供商实例创建跟踪器：队列调度 + （可选）WebSocket + 轮询。
 * @param provider 实例化后的执行提供商
 * @param taskService 任务服务
 * @param onSlotReleased 槽位释放回调（任务进入终态后触发，供分组调度器立即消费队列）
 */
function createProviderTracker(
  provider: ExecutionProvider,
  taskService: TaskService,
  onSlotReleased?: () => void,
): ProviderTracker {
  const providerId = provider.id;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let completionPollTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  /** 是否正在执行 drainQueue（防止并发重复提交同一任务） */
  let draining = false;
  /** 连续 history 拉取失败计数（按任务 ID）；达到阈值后将该任务置为失败 */
  const historyErrorCounts = new Map<string, number>();
  /** 连续失败阈值：达到后不再重试，将任务标记为失败 */
  const MAX_CONSECUTIVE_HISTORY_ERRORS = 5;

  /**
   * 统计本实例当前占用的并发槽位。
   * 按 actual_provider_id 统计：普通任务该字段即 providerId，
   * 分组任务则是实际执行任务的成员实例 ID（其 providerId 记录的是分组）。
   */
  function countPending(): number {
    return taskService.countPendingByActualProvider(providerId);
  }

  /**
   * 列出本实例排队中的任务。
   * 按 actual_provider_id 过滤：分组任务入队时不带实际执行实例，不归本实例消费。
   */
  function listQueued() {
    return taskService.listQueuedByActualProvider(providerId);
  }

  /** 槽位释放后的统一处理：触发本实例队列调度，并通知分组调度器消费分组队列 */
  function afterSlotReleased(): void {
    drainQueue();
    onSlotReleased?.();
  }

  /** 调度队列：当 running < concurrency 时取出最旧 queued 任务提交，循环填满并发槽位 */
  async function drainQueue(): Promise<void> {
    // 已停止的跟踪器不再提交任务（避免服务重建后旧实例继续写入）
    if (stopped) return;
    // 重入保护：并发触发时直接返回，避免同一任务被重复提交
    if (draining) return;
    draining = true;
    try {
      // 循环提交：一次触发尽可能填满空闲槽位（每轮至少消费一个 queued 任务，必然收敛）
      for (;;) {
        const running = countPending();
        if (running >= provider.concurrency) return;

        const queued = listQueued();
        if (queued.length === 0) return;

        const nextTask = queued[0];
        if (!nextTask.comfyuiRequestBody) {
          // 请求体缺失属于数据问题：置失败后继续处理后续排队任务
          taskService.updateStatus(nextTask.id, {
            status: 'failed',
            errorMessage: 'Missing request body',
          });
          continue;
        }

        const result = await provider.submitPrompt(nextTask.comfyuiRequestBody);
        if (result.success) {
          taskService.updateStatus(nextTask.id, {
            status: 'pending',
            promptId: result.promptId ?? undefined,
            comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
          });
          // 继续尝试填满下一个槽位
          continue;
        }
        taskService.updateStatus(nextTask.id, {
          status: 'failed',
          errorMessage: result.errorMessage ?? 'Submit failed',
          comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
        });
        // 提交失败同样产生孤儿上传文件，触发自动清理
        cleanupTaskUploads(provider, nextTask.uploadedFiles);
        // 提交失败通常意味着提供商不可达等实例级故障：停止本轮，避免连续失败风暴
        return;
      }
    } catch (err) {
      console.error(`[ExecutionService:${providerId}] drainQueue error`, err);
    } finally {
      draining = false;
    }
  }

  /** 将 pending 任务标记为已完成，提取输出文件并触发队列调度 */
  async function completeTask(promptId: string): Promise<void> {
    const task = taskService.getByPromptId(promptId);
    if (!task || task.status !== 'pending') return;
    taskService.updateStatus(task.id, { status: 'completed' });
    // 任务已进入终态，清理其连续失败计数
    historyErrorCounts.delete(task.id);
    // 终态后触发自动清理本次上传的资产与本地暂存文件
    cleanupTaskUploads(provider, task.uploadedFiles);
    void releaseStaged(task.id);
    fetchHistoryAndExtractOutputs(promptId)
      .catch(err => console.error(`[ExecutionService:${providerId}] fetch outputs error`, err));
    afterSlotReleased();
  }

  /** 将 pending 任务标记为失败并触发队列调度 */
  function failTask(promptId: string, errorMessage?: string): void {
    const task = taskService.getByPromptId(promptId);
    if (!task || task.status !== 'pending') return;
    taskService.updateStatus(task.id, {
      status: 'failed',
      errorMessage: errorMessage || 'Execution error',
    });
    // 任务已进入终态，清理其连续失败计数
    historyErrorCounts.delete(task.id);
    // 终态后触发自动清理本次上传的资产与本地暂存文件
    cleanupTaskUploads(provider, task.uploadedFiles);
    void releaseStaged(task.id);
    afterSlotReleased();
  }

  /**
   * 拉取 history 并提取输出文件，写入任务输出列表（异步兜底，失败仅记录日志）。
   * @param promptId ComfyUI prompt_id
   */
  async function fetchHistoryAndExtractOutputs(promptId: string): Promise<void> {
    try {
      const data = await provider.fetchHistory(promptId);
      const files = parseHistoryOutputs(data, promptId);
      if (files.length === 0) return;
      const task = taskService.getByPromptId(promptId);
      if (task) {
        taskService.updateOutputFiles(task.id, files);
      }
    } catch (err) {
      console.error(`[ExecutionService:${providerId}] fetchHistoryAndExtractOutputs error`, err);
    }
  }

  /** 按 history 解析结果更新 pending 任务终态 */
  function applyHistoryOutcome(taskId: string, promptId: string, data: unknown): boolean {
    const outcome = resolveHistoryOutcome(data, promptId);
    if (outcome.kind === 'running') return false;

    if (outcome.kind === 'completed') {
      taskService.updateStatus(taskId, { status: 'completed', comfyuiResponse: JSON.stringify(data) });
      // 任务已进入终态，清理其连续失败计数
      historyErrorCounts.delete(taskId);
      const files = parseHistoryOutputs(data, promptId);
      if (files.length > 0) {
        taskService.updateOutputFiles(taskId, files);
      }
      // 终态后触发自动清理本次上传的资产与本地暂存文件
      cleanupTaskUploads(provider, taskService.getById(taskId)?.uploadedFiles);
      void releaseStaged(taskId);
      afterSlotReleased();
      return true;
    }

    taskService.updateStatus(taskId, {
      status: 'failed',
      errorMessage: outcome.errorMessage,
      comfyuiResponse: JSON.stringify(data),
    });
    // 任务已进入终态，清理其连续失败计数
    historyErrorCounts.delete(taskId);
    // 终态后触发自动清理本次上传的资产与本地暂存文件
    cleanupTaskUploads(provider, taskService.getById(taskId)?.uploadedFiles);
    void releaseStaged(taskId);
    afterSlotReleased();
    return true;
  }

  /** 仅 websocket 模式建立连接 */
  function connect(): void {
    if (stopped || provider.trackingMode !== 'websocket') return;
    const url = `${provider.getBaseUrl().replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(COMFYUI_CLIENT_ID)}`;
    try {
      ws = new WebSocket(url);
      ws.on('open', () => {
        console.log(`[ExecutionService:${providerId}] WebSocket connected`);
      });
      ws.on('message', (raw: Buffer) => {
        try {
          const parsed: unknown = JSON.parse(raw.toString());
          // 仅处理对象类型消息，其余忽略
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          const msg = parsed as Record<string, unknown>;
          // data 字段非对象时按空对象处理
          const data = msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data)
            ? (msg.data as Record<string, unknown>)
            : {};
          const promptId = typeof data.prompt_id === 'string' ? data.prompt_id : '';
          if (!promptId) return;
          if (msg.type === 'progress') {
            const { value, max } = data;
            if (typeof value === 'number' && typeof max === 'number' && max > 0) {
              const pct = Math.round((value / max) * 100);
              const task = taskService.getByPromptId(promptId);
              if (task && task.status === 'pending') {
                taskService.updateProgress(task.id, pct);
              }
            }
          } else if (msg.type === 'execution_success') {
            completeTask(promptId);
          } else if (msg.type === 'execution_error') {
            failTask(promptId, toErrorMessage(data.exception_message, 'Execution error'));
          } else if (msg.type === 'execution_interrupted') {
            failTask(promptId, 'Execution interrupted');
          }
        } catch {
          // ignore parse errors
        }
      });
      ws.on('close', () => {
        if (!stopped) {
          reconnectTimer = setTimeout(connect, executionServiceConfig.reconnectDelayMs);
        }
      });
      ws.on('error', () => {
        // close event will fire and trigger reconnect
      });
    } catch {
      reconnectTimer = setTimeout(connect, executionServiceConfig.reconnectDelayMs);
    }
  }

  /** 快速轮询进度 100% 但尚未完成的 pending 任务 */
  function startCompletionPoll(): void {
    completionPollTimer = setInterval(async () => {
      // 已停止的跟踪器不再产生任何副作用（clearInterval 无法取消已在途的回调）
      if (stopped) return;
      try {
        const pending = taskService.listPending(providerId);
        const stuck = pending.filter(t => t.progress != null && t.progress >= 100);
        if (stuck.length === 0) return;
        for (const task of stuck) {
          if (!task.promptId) continue;
          try {
            const data = await provider.fetchHistory(task.promptId);
            applyHistoryOutcome(task.id, task.promptId, data);
          } catch {
            // retry next cycle
          }
        }
      } catch {
        // ignore
      }
    }, executionServiceConfig.completionPollIntervalMs);
  }

  /**
   * 槽位空闲且存在排队任务时触发一次调度。
   * 兜底任何绕过跟踪器终态路径的槽位释放（例如手动中断任务后 controller 直接置终态），
   * 使队列在 ≤ 一个轮询周期内自愈。
   */
  async function drainIfSlotsAvailable(): Promise<void> {
    // 槽位已满或队列为空时无需调度
    if (countPending() >= provider.concurrency) return;
    if (listQueued().length === 0) return;
    await drainQueue();
  }

  /** 后备轮询 /history 补偿丢失消息（同时驱动队列兜底调度） */
  function startFallback(): void {
    fallbackTimer = setInterval(async () => {
      // 已停止的跟踪器不再产生任何副作用（clearInterval 无法取消已在途的回调）
      if (stopped) return;
      try {
        // 队列兜底：无论 pending 是否为空都要检查，否则槽位空闲时队列会永久停住
        await drainIfSlotsAvailable();

        const pending = taskService.listPendingByActualProvider(providerId);
        if (pending.length === 0) return;
        for (const task of pending) {
          if (!task.promptId) continue;
          try {
            const data = await provider.fetchHistory(task.promptId);
            historyErrorCounts.delete(task.id);
            applyHistoryOutcome(task.id, task.promptId, data);
          } catch (err) {
            // 连续失败计数：达到阈值后终止任务，避免永久卡在 pending
            const count = (historyErrorCounts.get(task.id) ?? 0) + 1;
            historyErrorCounts.set(task.id, count);
            if (count >= MAX_CONSECUTIVE_HISTORY_ERRORS) {
              historyErrorCounts.delete(task.id);
              taskService.updateStatus(task.id, {
                status: 'failed',
                errorMessage: err instanceof Error ? `History check failed: ${err.message}` : 'History check failed',
              });
              // 终态后触发自动清理本次上传的资产与本地暂存文件
              cleanupTaskUploads(provider, task.uploadedFiles);
              void releaseStaged(task.id);
              afterSlotReleased();
            }
            // 未达阈值则下一轮重试
          }
        }
      } catch {
        // ignore
      }
    }, executionServiceConfig.fallbackIntervalMs);
  }

  connect();
  startFallback();
  startCompletionPoll();

  return {
    init: () => {
      // 启动即触发一次队列调度，让 queued 任务尽快进入 pending（fire-and-forget）
      drainQueue().catch(err => console.error(`[ExecutionService:${providerId}] init drain error`, err));
    },
    drain: () => drainQueue(),
    stop: () => {
      stopped = true;
      if (ws) { ws.close(); ws = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); }
      if (fallbackTimer) { clearInterval(fallbackTimer); }
      if (completionPollTimer) { clearInterval(completionPollTimer); }
    },
  };
}

/**
 * 启动执行服务：
 * - 为每个启用的非分组实例启动独立跟踪器（分组实例不直接执行任务，不建跟踪器）；
 * - 启动健康巡检与分组队列调度器。
 * 实例变更（增删改/默认切换）时整体重建。
 * @param db 数据库实例
 */
export function startExecutionService(db: BetterSQLite3Database<typeof schema>): { stop: () => void } {
  const taskService = new TaskService(db);
  const providerService = new ProviderService(db);
  const healthService = new HealthService(db);
  const dispatcher = new DispatcherService(db, healthService);
  let trackers: ProviderTracker[] = [];

  function stopAll(): void {
    for (const t of trackers) t.stop();
    trackers = [];
    // 同步注销调度入口，避免外部拿到已停止实例的 drain
    providerDrains.clear();
  }

  /**
   * 成员实例槽位释放后触发分组调度（fire-and-forget）。
   * 分组任务由分组调度器统一消费，成员跟踪器只负责感知槽位释放。
   */
  function onMemberSlotReleased(): void {
    void dispatcher.drainAll().catch((err: unknown) => {
      console.error('[ExecutionService] group dispatch after slot release failed', err);
    });
  }

  function startAll(): void {
    stopAll();
    const rows = providerService.listEnabled();
    trackers = rows
      // 分组实例没有可执行端点，其队列由分组调度器消费
      .filter((row) => row.type !== 'group')
      .map((row) => providerService.instantiate(row))
      .filter((p): p is ExecutionProvider => p !== null)
      .map((p) => {
        const tracker = createProviderTracker(p, taskService, onMemberSlotReleased);
        // 注册该实例的调度入口，供外部（如手动中断）释放槽位后主动触发
        providerDrains.set(p.id, tracker.drain);
        return tracker;
      });
    // 启动/重建后立即 drain 一次，让队列中已存在的任务尽快开始执行
    for (const tracker of trackers) tracker.init();
  }

  const unsubscribe = providerService.onChange(() => startAll());
  startAll();

  // 健康巡检：探测参与自动分配的实例；巡检后立即尝试投递分组队列（实例恢复可用时尽快消费队列）
  healthService.start(onMemberSlotReleased);
  // 分组队列兜底扫描：补偿遗漏的槽位释放通知
  dispatcher.start();
  // 启动即尝试消费一次分组队列，让重启前排队的分组任务尽快执行
  onMemberSlotReleased();
  // 注册分组调度入口，供任务控制器在取消排队任务后主动触发
  groupQueueDrain = () => dispatcher.drainAll().then(() => undefined);
  // 暴露调度器与健康服务供控制器按请求解析
  activeDispatcher = dispatcher;
  activeHealthService = healthService;

  return {
    stop: () => {
      unsubscribe();
      stopAll();
      groupQueueDrain = null;
      // 仅当仍指向本实例时才清空，避免后启动的服务被先停止的服务清掉引用
      if (activeDispatcher === dispatcher) activeDispatcher = null;
      if (activeHealthService === healthService) activeHealthService = null;
      dispatcher.stop();
      healthService.stop();
    },
  };
}
