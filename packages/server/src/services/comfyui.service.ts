import WebSocket from 'ws';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from './task.service';
import { SettingsService } from './settings.service';
import { submitPrompt } from './executor.service';

const FALLBACK_INTERVAL = 30000;
const RECONNECT_DELAY = 5000;

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

/** 按文件扩展名推断类型 */
function guessFileType(key: string): 'image' | 'video' | 'audio' {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
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
  let stopped = false;

  function getBaseUrl(): string | null {
    return settingsService.get('comfyui_base_url');
  }

  function getWsUrl(): string | null {
    const base = getBaseUrl();
    if (!base) return null;
    return base.replace(/^http/, 'ws') + '/ws';
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
              const tasks = taskService.listPending().filter(t => t.promptId === promptId);
              for (const t of tasks) {
                taskService.updateProgress(t.id, pct);
              }
            }
          } else if (msg.type === 'execution_complete' || msg.type === 'execution_success') {
            const tasks = taskService.listPending().filter(t => t.promptId === promptId);
            if (tasks.length > 0) {
              for (const t of tasks) {
                taskService.updateStatus(t.id, { status: 'completed' });
              }
              const baseUrl = getBaseUrl();
              if (baseUrl) {
                fetchHistoryAndExtractOutputs(promptId, baseUrl, taskService)
                  .catch(err => console.error('[ComfyUIService] fetch outputs error', err));
              }
              drainQueue();
            }
          } else if (msg.type === 'execution_error') {
            const tasks = taskService.listPending().filter(t => t.promptId === promptId);
            if (tasks.length > 0) {
              for (const t of tasks) {
                taskService.updateStatus(t.id, {
                  status: 'failed',
                  errorMessage: data.exception_message || 'Execution error',
                });
              }
              drainQueue();
            }
          }
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

  /** 后备轮询 /history 补偿 WebSocket 可能丢失的消息 */
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
              taskService.updateStatus(task.id, { status: 'failed', errorMessage: `ComfyUI error: ${text}` });
              continue;
            }
            const text = await res.text();
            let data: unknown;
            try { data = JSON.parse(text); } catch { continue; }
            const promptData = (data as Record<string, unknown>)[task.promptId];
            if (!promptData) continue;
            const statusObj = (promptData as { status?: { completed?: boolean } }).status;
            if (statusObj?.completed) {
              taskService.updateStatus(task.id, { status: 'completed', comfyuiResponse: JSON.stringify(data) });
              const files = parseHistoryOutputs(data, task.promptId);
              if (files.length > 0) {
                taskService.updateOutputFiles(task.id, files);
              }
              drainQueue();
            }
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

  return {
    stop: () => {
      stopped = true;
      if (ws) { ws.close(); ws = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); }
      if (fallbackTimer) { clearInterval(fallbackTimer); }
    },
  };
}
