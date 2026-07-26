import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService } from './task.service';
import { SettingsService } from './settings.service';

const POLL_INTERVAL = 3000;

/** 启动后台轮询服务，定期检查 pending 任务在 ComfyUI 中的完成状态 */
export function startPollingService(db: BetterSQLite3Database<typeof schema>): { stop: () => void } {
  const taskService = new TaskService(db);
  const settingsService = new SettingsService(db);

  const intervalId = setInterval(async () => {
    try {
      const pending = taskService.listPending();
      if (pending.length === 0) return;

      const baseUrl = settingsService.get('comfyui_base_url');
      if (!baseUrl) return;

      for (const task of pending) {
        if (!task.promptId) {
          taskService.updateStatus(task.id, {
            status: 'failed',
            errorMessage: 'Missing prompt_id',
          });
          continue;
        }
        try {
          const res = await fetch(`${baseUrl}/history/${task.promptId}`);
          if (res.status === 404) continue;
          // ComfyUI 返回服务端错误，标记为失败
          if (res.status >= 500) {
            const text = await res.text();
            taskService.updateStatus(task.id, {
              status: 'failed',
              errorMessage: `ComfyUI returned ${res.status}: ${text}`,
            });
            continue;
          }

          const text = await res.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { continue; }

          const promptData = (data as Record<string, unknown>)[task.promptId];
          if (!promptData) continue;

          const statusObj = (promptData as { status?: { completed?: boolean } }).status;
          if (statusObj?.completed) {
            taskService.updateStatus(task.id, {
              status: 'completed',
              comfyuiResponse: JSON.stringify(data),
            });
          }
        } catch (err: unknown) {
          console.error('[PollingService] Error checking task', task.id, err);
        }
      }
    } catch (err: unknown) {
      console.error('[PollingService] Unexpected error in poll cycle', err);
    }
  }, POLL_INTERVAL);

  return {
    stop: () => clearInterval(intervalId),
  };
}
