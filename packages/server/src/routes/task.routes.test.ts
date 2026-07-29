import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createTaskRoutes } from './task.routes';
import { outputHistoryBackfillConfig } from '../controllers/task.controller';
import { SettingsService } from '../services/settings.service';
import { TaskService } from '../services/task.service';

/**
 * 构造带 task_logs / settings 的内存库与 Express 子应用，供输出文件接口测试复用。
 * @param baseUrl ComfyUI base URL；null 表示未配置
 */
function createOutputFilesTestApp(baseUrl: string | null): {
  app: express.Express;
  db: BetterSQLite3Database<typeof schema>;
  taskService: TaskService;
} {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const db = drizzle(sqlite, { schema });
  const taskService = new TaskService(db);
  const settings = new SettingsService(db);
  if (baseUrl) settings.set('comfyui_base_url', baseUrl);
  settings.set('auth_enabled', '0');
  settings.set('output_download_mode', 'proxy');

  db.insert(schema.workflows).values({
    id: 'wf1', name: 'test', rawJson: '{}',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();

  const routeApp = express();
  routeApp.use(express.json());
  routeApp.use('/api/tasks', createTaskRoutes(db));
  return { app: routeApp, db, taskService };
}

/**
 * 构造 ComfyUI /history 成功响应体。
 * @param promptId prompt_id
 * @param withOutputs 是否包含 images 输出
 */
function buildHistoryJson(promptId: string, withOutputs: boolean): unknown {
  return {
    [promptId]: {
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: withOutputs
        ? {
            '9': {
              images: [
                { filename: 'history-out.png', subfolder: '', type: 'output' },
              ],
            },
          }
        : {},
    },
  };
}

describe('Task output files endpoints', () => {
  let app: express.Express;
  let appUnreachable: express.Express;
  let taskId: string;
  let taskIdNoOutput: string;
  let unreachableTaskId: string;

  beforeAll(() => {
    const main = createOutputFilesTestApp('http://localhost:8188');
    app = main.app;
    const task = main.taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'prompt-abc',
    });
    main.taskService.updateStatus(task.id, { status: 'completed' });
    main.taskService.updateOutputFiles(task.id, [
      { filename: 'output.png', subfolder: '', type: 'output', nodeId: '9', fileType: 'image' },
    ]);
    taskId = task.id;

    const noOutputTask = main.taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: null,
    });
    taskIdNoOutput = noOutputTask.id;

    const unreachable = createOutputFilesTestApp(null);
    appUnreachable = unreachable.app;
    const unreachableTask = unreachable.taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'prompt-abc',
    });
    unreachable.taskService.updateStatus(unreachableTask.id, { status: 'completed' });
    unreachable.taskService.updateOutputFiles(unreachableTask.id, [
      { filename: 'output.png', subfolder: '', type: 'output', nodeId: '9', fileType: 'image' },
    ]);
    unreachableTaskId = unreachableTask.id;
  });

  it('GET /api/tasks/:taskId/output-files returns file list with proxy urls', async () => {
    const res = await supertest(app)
      .get(`/api/tasks/${taskId}/output-files`);
    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].filename).toBe('output.png');
    expect(res.body.files[0].fileType).toBe('image');
    expect(res.body.files[0].url).toContain('/api/tasks/');
    expect(res.body.files[0].url).toContain('output-files/output.png');
  });

  it('GET /api/tasks/:taskId/output-files returns 404 for non-existent task', async () => {
    const res = await supertest(app)
      .get('/api/tasks/nonexistent/output-files');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('task_not_found');
  });

  it('GET /api/tasks/:taskId/output-files returns empty list for task without output files', async () => {
    const res = await supertest(app)
      .get(`/api/tasks/${taskIdNoOutput}/output-files`);
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
  });

  it('GET /api/tasks/:taskId/output-files/:filename returns 404 for non-existent task', async () => {
    const res = await supertest(app)
      .get('/api/tasks/nonexistent/output-files/test.png');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('task_not_found');
  });

  it('GET /api/tasks/:taskId/output-files/:filename returns 502 when ComfyUI is unreachable', async () => {
    const res = await supertest(appUnreachable)
      .get(`/api/tasks/${unreachableTaskId}/output-files/output.png`);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('comfyui_unreachable');
  });
});

/**
 * completed 任务本地 outputFiles 为空时，从 ComfyUI /history 回源补全（含重试）。
 * 将 retryDelayMs 置 0，避免 supertest 与 fake timers 冲突导致超时。
 */
describe('Task output files history backfill', () => {
  /** fetch mock，用于模拟 ComfyUI /history */
  const mockFetch = vi.fn();
  /** 保存原始 fetch，用例结束后恢复 */
  const originalFetch = globalThis.fetch;
  /** 生产默认重试间隔，用例结束后还原 */
  const defaultRetryDelayMs = outputHistoryBackfillConfig.retryDelayMs;
  let app: express.Express;
  let taskService: TaskService;
  let completedEmptyTaskId: string;
  let pendingEmptyTaskId: string;
  const promptId = 'prompt-backfill';

  beforeEach(() => {
    // 每个用例独立内存库，避免回填互相污染
    const ctx = createOutputFilesTestApp('http://localhost:8188');
    app = ctx.app;
    taskService = ctx.taskService;

    const completed = taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId,
    });
    taskService.updateStatus(completed.id, { status: 'completed' });
    completedEmptyTaskId = completed.id;

    const pending = taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'prompt-pending',
    });
    pendingEmptyTaskId = pending.id;

    // 测试中跳过真实 2s 等待，只验证重试次数与结果
    outputHistoryBackfillConfig.retryDelayMs = 0;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    outputHistoryBackfillConfig.retryDelayMs = defaultRetryDelayMs;
  });

  it('backfills from history on first attempt without second fetch', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => buildHistoryJson(promptId, true),
    });

    const res = await supertest(app)
      .get(`/api/tasks/${completedEmptyTaskId}/output-files`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].filename).toBe('history-out.png');
    expect(res.body.files[0].url).toContain('history-out.png');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 再次读取本地应已回填，无需再请求 history
    mockFetch.mockClear();
    const again = await supertest(app)
      .get(`/api/tasks/${completedEmptyTaskId}/output-files`);
    expect(again.status).toBe(200);
    expect(again.body.files).toHaveLength(1);
    expect(mockFetch).not.toHaveBeenCalled();

    const stored = taskService.getById(completedEmptyTaskId);
    expect(stored?.outputFiles).toContain('history-out.png');
  });

  it('retries once when first history response has no outputs', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => buildHistoryJson(promptId, false),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => buildHistoryJson(promptId, true),
      });

    const res = await supertest(app)
      .get(`/api/tasks/${completedEmptyTaskId}/output-files`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].filename).toBe('history-out.png');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns empty list after two empty history responses', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => buildHistoryJson(promptId, false),
    });

    const res = await supertest(app)
      .get(`/api/tasks/${completedEmptyTaskId}/output-files`);

    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not fetch history for pending tasks with empty output files', async () => {
    const res = await supertest(app)
      .get(`/api/tasks/${pendingEmptyTaskId}/output-files`);
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty list when both history fetches fail', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    const res = await supertest(app)
      .get(`/api/tasks/${completedEmptyTaskId}/output-files`);

    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('Task cancel endpoint', () => {
  let app: express.Express;
  let queuedTaskId: string;
  let pendingTaskId: string;
  let completedTaskId: string;
  let failedTaskId: string;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const db = drizzle(sqlite, { schema });
    const svc = new TaskService(db);
    const s = new SettingsService(db);
    s.set('comfyui_base_url', 'http://localhost:8188');
    s.set('auth_enabled', '0');

    db.insert(schema.workflows).values({
      id: 'wf-cancel', name: 'test', rawJson: '{}',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();

    // 创建 queued 任务
    const queued = svc.create({
      workflowId: 'wf-cancel', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: null,
    });
    // 手动设为 queued（create 默认设为 failed 当 promptId 为 null）
    svc.updateStatus(queued.id, { status: 'queued' });
    queuedTaskId = queued.id;

    // 创建 pending 任务
    const pending = svc.create({
      workflowId: 'wf-cancel', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: '{}',
      comfyuiResponse: null, promptId: 'prompt-cancel',
    });
    pendingTaskId = pending.id;

    // 创建 completed 任务
    const completed = svc.create({
      workflowId: 'wf-cancel', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'prompt-completed',
    });
    svc.updateStatus(completed.id, { status: 'completed' });
    completedTaskId = completed.id;

    // 创建 failed 任务
    const failed = svc.create({
      workflowId: 'wf-cancel', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: null,
    });
    failedTaskId = failed.id;

    const routeApp = express();
    routeApp.use(express.json());
    routeApp.use('/api/tasks', createTaskRoutes(db));
    app = routeApp;
  });

  it('POST /api/tasks/:taskId/cancel cancels a queued task', async () => {
    const res = await supertest(app)
      .post(`/api/tasks/${queuedTaskId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    // 验证任务已被标记为失败
    const detail = await supertest(app).get(`/api/tasks/${queuedTaskId}`);
    expect(detail.body.status).toBe('failed');
    expect(detail.body.errorMessage).toBe('Cancelled by user');
  });

  it('POST /api/tasks/:taskId/cancel cancels a pending task', async () => {
    const res = await supertest(app)
      .post(`/api/tasks/${pendingTaskId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    const detail = await supertest(app).get(`/api/tasks/${pendingTaskId}`);
    expect(detail.body.status).toBe('failed');
    expect(detail.body.errorMessage).toBe('Cancelled by user');
  });

  it('POST /api/tasks/:taskId/cancel returns 400 for completed task', async () => {
    const res = await supertest(app)
      .post(`/api/tasks/${completedTaskId}/cancel`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_status');
  });

  it('POST /api/tasks/:taskId/cancel returns 400 for failed task', async () => {
    const res = await supertest(app)
      .post(`/api/tasks/${failedTaskId}/cancel`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_status');
  });

  it('POST /api/tasks/:taskId/cancel returns 404 for non-existent task', async () => {
    const res = await supertest(app)
      .post('/api/tasks/nonexistent/cancel');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('task_not_found');
  });
});
