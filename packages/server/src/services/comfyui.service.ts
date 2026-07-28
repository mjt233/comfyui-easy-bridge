import WebSocket from 'ws';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from './task.service';
import { SettingsService } from './settings.service';
import { submitPrompt, COMFYUI_CLIENT_ID } from './executor.service';

const FALLBACK_INTERVAL = 10000;
const COMPLETION_POLL_INTERVAL = 1000;
const RECONNECT_DELAY = 5000;

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

/** 解析 ComfyUI /history/{promptId} 响应中的输出文件 */
function parseHistoryOutputs(historyData: unknown, promptId: string): OutputFile[] {
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

/** 启动 ComfyUI WebSocket 连接 + 队列调度 + 后备轮询服务 */
export function startComfyUIService(db: BetterSQLite3Database<typeof schema>): { stop: () => void } {
  const taskService = new TaskService(db);
  const settingsService = new SettingsService(db);

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let completionPollTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function getBaseUrl(): string | null {
    return settingsService.get('comfyui_base_url');
  }

  /**
   * 构造带 clientId 的 WebSocket URL，与 /prompt 提交的 client_id 一致。
   * @returns ws URL；未配置 base URL 时返回 null
   */
  function getWsUrl(): string | null {
    const base = getBaseUrl();
    if (!base) return null;
    // ComfyUI 使用 query clientId 识别会话，才能收到非广播的 execution_error
    return `${base.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(COMFYUI_CLIENT_ID)}`;
  }

  function getConcurrency(): number {
    const val = settingsService.get('comfyui_concurrency');
    return val ? parseInt(val, 10) : 1;
  }

  /** 调度队列：当 running < concurrency 时取出最旧 queued 任务提交 */
  async function drainQueue(): Promise<void> {
    try {
      const concurrency = getConcurrency();
      const running = taskService.countByStatus('pending');
      if (running >= concurrency) return;

      const queued = taskService.listQueued();
      if (queued.length === 0) return;

      const baseUrl = getBaseUrl();
      if (!baseUrl) return;

      const nextTask = queued[0];
      if (!nextTask.comfyuiRequestBody) {
        taskService.updateStatus(nextTask.id, {
          status: 'failed',
          errorMessage: 'Missing request body',
        });
        return;
      }

      const result = await submitPrompt(nextTask.comfyuiRequestBody, baseUrl);
      if (result.success) {
        taskService.updateStatus(nextTask.id, {
          status: 'pending',
          promptId: result.promptId ?? undefined,
          comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
        });
      } else {
        taskService.updateStatus(nextTask.id, {
          status: 'failed',
          errorMessage: result.errorMessage ?? 'Submit failed',
          comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
        });
      }
    } catch (err) {
      console.error('[ComfyUIService] drainQueue error', err);
    }
  }

  /** 将 pending 任务标记为已完成，提取输出文件并触发队列调度 */
  async function completeTask(promptId: string): Promise<void> {
    const task = taskService.getByPromptId(promptId);
    if (!task || task.status !== 'pending') return;
    taskService.updateStatus(task.id, { status: 'completed' });
    const baseUrl = getBaseUrl();
    if (baseUrl) {
      fetchHistoryAndExtractOutputs(promptId, baseUrl, taskService)
        .catch(err => console.error('[ComfyUIService] fetch outputs error', err));
    }
    drainQueue();
  }

  /** 将 pending 任务标记为失败并触发队列调度 */
  function failTask(promptId: string, errorMessage?: string): void {
    const task = taskService.getByPromptId(promptId);
    if (!task || task.status !== 'pending') return;
    taskService.updateStatus(task.id, {
      status: 'failed',
      errorMessage: errorMessage || 'Execution error',
    });
    drainQueue();
  }

  async function fetchHistoryAndExtractOutputs(
    promptId: string,
    baseUrl: string,
    taskService: TaskService,
  ): Promise<void> {
    try {
      const res = await fetch(`${baseUrl}/history/${promptId}`);
      if (!res.ok) return;
      const data = await res.json();
      const files = parseHistoryOutputs(data, promptId);
      if (files.length === 0) return;
      const task = taskService.getByPromptId(promptId);
      if (task) {
        taskService.updateOutputFiles(task.id, files);
      }
    } catch (err) {
      console.error('[ComfyUIService] fetchHistoryAndExtractOutputs error', err);
    }
  }

  function connect(): void {
    if (stopped) return;
    const url = getWsUrl();
    if (!url) {
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
      return;
    }

    try {
      ws = new WebSocket(url);
      ws.on('open', () => {
        console.log('[ComfyUIService] WebSocket connected');
      });

      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          const data = msg.data || {};
          const promptId = data.prompt_id;
          if (!promptId) return;

          if (msg.type === 'progress') {
            const { value, max } = data;
            if (value != null && max > 0) {
              const pct = Math.round((value / max) * 100);
              const task = taskService.getByPromptId(promptId);
              if (task && task.status === 'pending') {
                taskService.updateProgress(task.id, pct);
              }
            }
          } else if (msg.type === 'execution_success') {
            // 仅以 execution_success 作为成功信号；失败结束也会发 executing node=null
            completeTask(promptId);
          } else if (msg.type === 'execution_error') {
            failTask(promptId, toErrorMessage(data.exception_message, 'Execution error'));
          } else if (msg.type === 'execution_interrupted') {
            // 用户中断或 InterruptProcessingException
            failTask(promptId, 'Execution interrupted');
          }
          // 注意：不再将 executing + node=null 视为成功（失败任务也会收到该消息）
        } catch {
          // ignore parse errors
        }
      });

      ws.on('close', () => {
        if (!stopped) {
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
        }
      });

      ws.on('error', () => {
        // close event will fire and trigger reconnect
      });
    } catch {
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
    }
  }

  /**
   * 根据 history 解析结果更新 pending 任务终态。
   * @param taskId 本地任务 ID
   * @param promptId ComfyUI prompt_id
   * @param data history JSON
   * @returns 是否已进入终态
   */
  function applyHistoryOutcome(
    taskId: string,
    promptId: string,
    data: unknown,
  ): boolean {
    const outcome = resolveHistoryOutcome(data, promptId);
    if (outcome.kind === 'running') {
      return false;
    }

    if (outcome.kind === 'completed') {
      // 标记完成并尽量提取输出文件
      taskService.updateStatus(taskId, {
        status: 'completed',
        comfyuiResponse: JSON.stringify(data),
      });
      const files = parseHistoryOutputs(data, promptId);
      if (files.length > 0) {
        taskService.updateOutputFiles(taskId, files);
      }
      drainQueue();
      return true;
    }

    // failed
    taskService.updateStatus(taskId, {
      status: 'failed',
      errorMessage: outcome.errorMessage,
      comfyuiResponse: JSON.stringify(data),
    });
    drainQueue();
    return true;
  }

  /** 快速轮询进度 100% 但尚未完成的 pending 任务，1 秒间隔补足 WebSocket 可能丢失的完成/失败信号 */
  function startCompletionPoll(): void {
    completionPollTimer = setInterval(async () => {
      try {
        const pending = taskService.listPending();
        const stuck = pending.filter(t => t.progress != null && t.progress >= 100);
        if (stuck.length === 0) return;
        const baseUrl = getBaseUrl();
        if (!baseUrl) return;

        for (const task of stuck) {
          if (!task.promptId) continue;
          try {
            const res = await fetch(`${baseUrl}/history/${task.promptId}`);
            if (!res.ok) continue;
            const data = await res.json();
            // 成功或失败均通过统一解析器处理
            applyHistoryOutcome(task.id, task.promptId, data);
          } catch {
            // retry next cycle
          }
        }
      } catch {
        // ignore
      }
    }, COMPLETION_POLL_INTERVAL);
  }

  /** 后备轮询 /history 补偿 WebSocket 可能丢失的消息（含失败） */
  function startFallback(): void {
    fallbackTimer = setInterval(async () => {
      try {
        const pending = taskService.listPending();
        if (pending.length === 0) return;
        const baseUrl = getBaseUrl();
        if (!baseUrl) return;

        for (const task of pending) {
          if (!task.promptId) continue;
          try {
            const res = await fetch(`${baseUrl}/history/${task.promptId}`);
            if (res.status === 404) continue;
            if (res.status >= 500) {
              const text = await res.text();
              taskService.updateStatus(task.id, {
                status: 'failed',
                errorMessage: `ComfyUI error: ${text}`,
              });
              drainQueue();
              continue;
            }
            const text = await res.text();
            let data: unknown;
            try {
              data = JSON.parse(text);
            } catch {
              continue;
            }
            // 成功或失败均通过统一解析器处理
            applyHistoryOutcome(task.id, task.promptId, data);
          } catch {
            // retry next cycle
          }
        }
      } catch {
        // ignore
      }
    }, FALLBACK_INTERVAL);
  }

  connect();
  startFallback();
  startCompletionPoll();

  return {
    stop: () => {
      stopped = true;
      if (ws) { ws.close(); ws = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); }
      if (fallbackTimer) { clearInterval(fallbackTimer); }
      if (completionPollTimer) { clearInterval(completionPollTimer); }
    },
  };
}
