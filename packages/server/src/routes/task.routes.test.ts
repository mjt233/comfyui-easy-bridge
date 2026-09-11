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
import { ProviderService } from '../services/providers/provider.service';
import { TaskService } from '../services/task.service';
import { startExecutionService } from '../services/execution.service';

/**
 * 构造带 task_logs / providers / settings 的内存库与 Express 子应用，供输出文件接口测试复用。
 * @param baseUrl ComfyUI base URL；null 表示未配置提供商（无默认实例）
 */
function createOutputFilesTestApp(baseUrl: string | null): {
  app: express.Express;
  db: BetterSQLite3Database<typeof schema>;
  taskService: TaskService;
  providerService: ProviderService;
} {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, provider_id TEXT, provider_name TEXT, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, actual_provider_id TEXT, actual_provider_name TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  const db = drizzle(sqlite, { schema });
  const taskService = new TaskService(db);
  const settings = new SettingsService(db);
  const providerService = new ProviderService(db);
  // 替代旧的 comfyui_base_url 设置：配置了地址时创建 comfyui 实例并设为全局默认
  if (baseUrl) {
    const provider = providerService.create({
      name: 'test-comfyui', type: 'comfyui',
      config: { baseUrl },
    });
    providerService.setDefault(provider.id);
  }
  settings.set('auth_enabled', '0');
  settings.set('output_download_mode', 'proxy');

  db.insert(schema.workflows).values({
    id: 'wf1', name: 'test', rawJson: '{}',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();

  const routeApp = express();
  routeApp.use(express.json());
  routeApp.use('/api/tasks', createTaskRoutes(db));
  return { app: routeApp, db, taskService, providerService };
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
  /** fetch mock，用于模拟 ComfyUI /interrupt 与 /queue 接口 */
  const mockFetch = vi.fn();
  /** 保存原始 fetch，用例结束后恢复 */
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, provider_id TEXT, provider_name TEXT, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, actual_provider_id TEXT, actual_provider_name TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const db = drizzle(sqlite, { schema });
    const svc = new TaskService(db);
    const s = new SettingsService(db);
    // 用 comfyui 实例 + 全局默认替代旧的 comfyui_base_url 设置
    const providerService = new ProviderService(db);
    const provider = providerService.create({
      name: 'cancel-comfyui', type: 'comfyui',
      config: { baseUrl: 'http://localhost:8188' },
    });
    providerService.setDefault(provider.id);
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

  beforeEach(() => {
    // mock ComfyUI 接口，避免测试依赖真实服务：首次 /interrupt 成功，/queue 轮询返回空执行队列
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValue({ ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

/**
 * 任务按 provider_id 解析执行提供商（历史任务回退全局默认）。
 */
describe('Task output files provider resolution', () => {
  const originalFetch = globalThis.fetch;
  const defaultRetryDelayMs = outputHistoryBackfillConfig.retryDelayMs;
  let app: express.Express;
  let taskService: TaskService;
  let providerService: ProviderService;
  const promptId = 'prompt-provider';

  beforeEach(() => {
    const ctx = createOutputFilesTestApp('http://localhost:8188');
    app = ctx.app;
    taskService = ctx.taskService;
    providerService = ctx.providerService;
    // 测试中跳过真实 2s 等待，只验证回源 URL 与结果
    outputHistoryBackfillConfig.retryDelayMs = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    outputHistoryBackfillConfig.retryDelayMs = defaultRetryDelayMs;
  });

  it('backfills via runninghub proxy URL when task has provider_id', async () => {
    // 创建 runninghub 实例，任务显式引用它（应优先于全局默认的 comfyui 实例）
    const rh = providerService.create({
      name: 'rh-test', type: 'runninghub',
      config: { apiKey: 'sk-test-key', gpuSize: '24G' },
    });
    const task = taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: '', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId, providerId: rh.id,
    });
    taskService.updateStatus(task.id, { status: 'completed' });

    // stub 全局 fetch，捕获回源请求的 URL
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => buildHistoryJson(promptId, true),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await supertest(app)
      .get(`/api/tasks/${task.id}/output-files`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].filename).toBe('history-out.png');
    // 回源请求应打到 runninghub 推导出的 proxy 地址
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = String(mockFetch.mock.calls[0]?.[0] ?? '');
    expect(calledUrl).toContain(`/proxy/sk-test-key/history/${promptId}`);
  });

  it('download returns 502 when task provider_id is missing and no default provider', async () => {
    // 无任何可用提供商（任务引用实例不存在且无全局默认）时下载返回 502
    const ctx = createOutputFilesTestApp(null);
    const task = ctx.taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: '', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'prompt-missing', providerId: 'missing-provider',
    });
    const res = await supertest(ctx.app)
      .get(`/api/tasks/${task.id}/output-files/output.png`);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('comfyui_unreachable');
  });

  it('backfills via task provider even when the instance is disabled', async () => {
    // 创建 runninghub 实例后禁用：历史任务仍应按 task.providerId 引用原实例回源（不因禁用而回退默认）
    const rh = providerService.create({
      name: 'rh-disabled', type: 'runninghub',
      config: { apiKey: 'sk-test-key', gpuSize: '24G' },
    });
    providerService.update(rh.id, { enabled: false });

    const task = taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: '', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId, providerId: rh.id,
    });
    taskService.updateStatus(task.id, { status: 'completed' });

    // stub 全局 fetch，捕获回源请求的 URL
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => buildHistoryJson(promptId, true),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await supertest(app)
      .get(`/api/tasks/${task.id}/output-files`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].filename).toBe('history-out.png');
    // 即使实例已禁用，仍解析到该 runninghub 实例推导出的 proxy 地址（而非全局默认的 comfyui）
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = String(mockFetch.mock.calls[0]?.[0] ?? '');
    expect(calledUrl).toContain(`/proxy/sk-test-key/history/${promptId}`);
  });
});

/** cancel 触发队列调度的测试环境（独立 :memory: 库 + Express 子应用 + 两条任务） */
interface CancelDrainEnv {
  /** Express 子应用 */
  app: express.Express;
  /** drizzle 数据库实例（供启动执行服务） */
  db: BetterSQLite3Database<typeof schema>;
  /** 任务服务 */
  taskService: TaskService;
  /** 正在执行（占用唯一并发槽位）的任务 */
  running: { id: string };
  /** 排队中的任务 */
  queued: { id: string };
}

/**
 * 手动中断后队列自动调度测试：
 * 启动真实执行服务（:memory: 库 + 打桩 fetch），验证 cancel pending 任务后，
 * 同一提供商实例下排队中的任务会被自动提交（不再依赖 WebSocket 事件的时序竞态）。
 */
describe('Task cancel triggers queue drain', () => {
  /** 原始全局 fetch，用例结束后恢复 */
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  /**
   * 构造独立测试环境：1 个 comfyui 实例（并发 1）+ 1 个 pending 任务（占满槽位）+ 1 个 queued 任务。
   * @returns 测试环境
   */
  function createEnv(): CancelDrainEnv {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, provider_id TEXT, provider_name TEXT, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, actual_provider_id TEXT, actual_provider_name TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const db = drizzle(sqlite, { schema });
    const taskService = new TaskService(db);
    const settings = new SettingsService(db);
    const providerService = new ProviderService(db);
    const provider = providerService.create({
      name: 'cancel-drain', type: 'comfyui',
      config: { baseUrl: 'http://localhost:8188' },
    });
    providerService.setDefault(provider.id);
    settings.set('auth_enabled', '0');

    // 正在执行的任务：占满并发上限（promptId 非空 → create 直接落 pending）
    const running = taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: '{"prompt":{}}',
      comfyuiResponse: null, promptId: 'pid-running',
      providerId: provider.id, providerName: provider.name,
    });
    // 等价于迁移 v11 的回填：升级前已在执行的 pending 任务没有 actual_provider_id，
    // 而并发统计按实际执行实例口径计数，不回填会导致运行中任务不占槽位
    sqlite.prepare(`
      UPDATE task_logs SET actual_provider_id = provider_id, actual_provider_name = provider_name
       WHERE status = 'pending' AND actual_provider_id IS NULL AND provider_id IS NOT NULL
    `).run();
    // 排队任务：超出并发上限（create 后手动置为 queued）
    const queued = taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: '{"prompt":{}}',
      comfyuiResponse: null, promptId: null,
      providerId: provider.id, providerName: provider.name,
    });
    taskService.updateStatus(queued.id, { status: 'queued' });
    // 普通实例任务的执行实例即其 providerId：跟踪器与并发统计按实际执行实例口径
    taskService.setActualProvider(queued.id, {
      actualProviderId: provider.id,
      actualProviderName: provider.name,
      promptId: '',
    });

    const routeApp = express();
    routeApp.use(express.json());
    routeApp.use('/api/tasks', createTaskRoutes(db));
    return { app: routeApp, db, taskService, running, queued };
  }

  /**
   * 打桩全局 fetch：/prompt 返回新 prompt_id，/queue 报告目标已停止，其余返回成功空响应。
   * @param options interruptOk 为 false 时 /interrupt 返回 500（模拟无法确认中断）
   */
  function stubFetch(options?: { interruptOk?: boolean }): void {
    const interruptOk = options?.interruptOk ?? true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      // 队列调度提交排队任务 → 返回新的 prompt_id
      if (url.endsWith('/prompt')) {
        return new Response(JSON.stringify({ prompt_id: 'pid-queued' }), { status: 200 });
      }
      // 中断确认轮询 → 目标 prompt 已离开执行队列
      if (url.endsWith('/queue')) {
        return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), { status: 200 });
      }
      // 中断请求：可模拟失败（无法确认停止）
      if (url.endsWith('/interrupt')) {
        return new Response('{}', { status: interruptOk ? 200 : 500 });
      }
      // /history 等 → 成功空响应
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('auto-submits the queued task of the same provider after cancelling a pending task', async () => {
    const env = createEnv();
    stubFetch();
    // 启动执行服务：init drain 时槽位已被 running 占满，queued 不会被提交
    const svc = startExecutionService(env.db);
    try {
      const res = await supertest(env.app).post(`/api/tasks/${env.running.id}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');

      // 中断触发的 drain 是 fire-and-forget：等待排队任务被提交
      await vi.waitFor(() => {
        const queued = env.taskService.getById(env.queued.id);
        expect(queued?.status).toBe('pending');
        expect(queued?.promptId).toBe('pid-queued');
      });
    } finally {
      svc.stop();
    }
  });

  it('keeps the task pending and returns 502 when the interruption cannot be confirmed', async () => {
    const env = createEnv();
    // /interrupt 返回非 2xx → 无法确认执行端已停止
    stubFetch({ interruptOk: false });
    const svc = startExecutionService(env.db);
    try {
      const res = await supertest(env.app).post(`/api/tasks/${env.running.id}/cancel`);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('interrupt_unconfirmed');

      // 任务保持 pending，交由跟踪器收敛；槽位未释放，排队任务也不应被提交
      expect(env.taskService.getById(env.running.id)?.status).toBe('pending');
      expect(env.taskService.getById(env.queued.id)?.status).toBe('queued');
    } finally {
      svc.stop();
    }
  });
});
