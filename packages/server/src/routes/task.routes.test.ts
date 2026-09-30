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
import { ProviderService, type ProviderRow } from '../services/providers/provider.service';
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

/**
 * 构造 RunningHub 结果查询 V2 的成功响应体。
 * @param fileUrl 产出文件绝对地址
 * @param outputType 平台返回的文件类型标识（扩展名或 image/video/audio）
 */
function buildRunningHubSuccessJson(fileUrl: string, outputType = 'png'): unknown {
  return {
    taskId: 'prompt-provider',
    status: 'SUCCESS',
    errorCode: '',
    errorMessage: '',
    results: [{ url: fileUrl, outputType }],
    clientId: '',
    promptTips: '',
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
 * 平台产出（RunningHub 结果查询 V2）落库时携带绝对地址，
 * 列表与下载据此分流：proxy 模式由后端回源平台地址后转发，direct 模式直接给出绝对地址。
 */
describe('Task output files carrying platform absolute urls', () => {
  /** 保存原始 fetch，用例结束后恢复 */
  const originalFetch = globalThis.fetch;
  /** 平台产出的绝对地址 */
  const remoteUrl = 'https://rh-cdn.example.com/output/final.png';
  let app: express.Express;
  let settings: SettingsService;
  let taskId: string;
  /** 未配置任何提供商的应用：验证平台产出下载不依赖 provider */
  let appNoProvider: express.Express;
  let taskIdNoProvider: string;

  beforeEach(() => {
    const ctx = createOutputFilesTestApp('http://localhost:8188');
    app = ctx.app;
    settings = new SettingsService(ctx.db);
    const task = ctx.taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: '', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'task-platform',
    });
    ctx.taskService.updateStatus(task.id, { status: 'completed' });
    ctx.taskService.updateOutputFiles(task.id, [
      { filename: 'final.png', subfolder: '', type: 'output', nodeId: '', fileType: 'image', url: remoteUrl },
    ]);
    taskId = task.id;

    const noProvider = createOutputFilesTestApp(null);
    appNoProvider = noProvider.app;
    const orphan = noProvider.taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: '', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'task-platform-orphan',
    });
    noProvider.taskService.updateStatus(orphan.id, { status: 'completed' });
    noProvider.taskService.updateOutputFiles(orphan.id, [
      { filename: 'final.png', subfolder: '', type: 'output', nodeId: '', fileType: 'image', url: remoteUrl },
    ]);
    taskIdNoProvider = orphan.id;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it('keeps returning the backend proxy url in proxy mode', async () => {
    const res = await supertest(app)
      .get(`/api/tasks/${taskId}/output-files`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].filename).toBe('final.png');
    expect(res.body.files[0].url).toContain(`/api/tasks/${taskId}/output-files/final.png`);
    // proxy 模式不直接暴露平台地址
    expect(res.body.files[0].url).not.toBe(remoteUrl);
  });

  it('returns the platform absolute url in direct mode', async () => {
    settings.set('output_download_mode', 'direct');

    const res = await supertest(app)
      .get(`/api/tasks/${taskId}/output-files`);

    expect(res.status).toBe(200);
    expect(res.body.files[0].url).toBe(remoteUrl);
  });

  it('downloads by re-fetching the stored platform url', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('binary', {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await supertest(app)
      .get(`/api/tasks/${taskId}/output-files/final.png`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // 回源的是平台绝对地址，而不是执行端 /view
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe(remoteUrl);
  });

  it('downloads platform outputs even when no provider is configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('binary', { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await supertest(appNoProvider)
      .get(`/api/tasks/${taskIdNoProvider}/output-files/final.png`);

    expect(res.status).toBe(200);
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe(remoteUrl);
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

  it('backfills via runninghub query API when task has provider_id', async () => {
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

    // stub 全局 fetch：RunningHub 产出改走平台结果查询 V2
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => buildRunningHubSuccessJson('https://rh-cdn.example.com/output/final.png'),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await supertest(app)
      .get(`/api/tasks/${task.id}/output-files`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    // 文件名由平台地址末段推导
    expect(res.body.files[0].filename).toBe('final.png');
    expect(res.body.files[0].fileType).toBe('image');
    // 回源应打到平台结果查询接口，且带任务引用实例的 API Key
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://www.runninghub.cn/openapi/v2/query');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key');
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

    // stub 全局 fetch，捕获回源请求
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => buildRunningHubSuccessJson('https://rh-cdn.example.com/output/history-out.png'),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await supertest(app)
      .get(`/api/tasks/${task.id}/output-files`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].filename).toBe('history-out.png');
    // 即使实例已禁用，仍用该 runninghub 实例的 API Key 回源（而非全局默认的 comfyui）
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://www.runninghub.cn/openapi/v2/query');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key');
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

/** 待调度任务人工干预（改派执行目标 / 插队提交）的测试环境 */
interface ReassignEnv {
  /** Express 子应用 */
  app: express.Express;
  /** drizzle 数据库实例（供启动执行服务） */
  db: BetterSQLite3Database<typeof schema>;
  /** 任务服务 */
  taskService: TaskService;
  /** 提供商服务 */
  providerService: ProviderService;
  /** 具体实例（comfyui，并发 1） */
  instance: ProviderRow;
  /** 分组实例（成员为 instance 之外的独立成员） */
  group: ProviderRow;
  /** 分组的成员实例（comfyui，并发 1） */
  member: ProviderRow;
  /** 空分组（无任何可分配成员） */
  emptyGroup: ProviderRow;
  /** 已停用实例 */
  disabled: ProviderRow;
}

/**
 * 待调度任务人工干预测试：
 * 覆盖「修改执行实例」（PATCH /api/tasks/:id/provider，仅影响自动调度）
 * 与「立即提交」（POST /api/tasks/:id/submit，插队提交到指定具体实例）。
 */
describe('Task provider reassignment endpoints', () => {
  /** 保存原始 fetch，用例结束后恢复 */
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  /**
   * 构造测试环境：两个 comfyui 实例 + 一个有成员分组 + 一个空分组 + 一个停用实例。
   * @returns 测试环境
   */
  function createEnv(): ReassignEnv {
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
    settings.set('auth_enabled', '0');

    const instance = providerService.create({
      name: 'inst', type: 'comfyui', config: { baseUrl: 'http://inst:8188' },
    });
    const member = providerService.create({
      name: 'member', type: 'comfyui', config: { baseUrl: 'http://member:8188' },
    });
    const group = providerService.create({
      name: 'G', type: 'group',
      config: { dispatchPolicy: 'priority', members: [{ providerId: member.id, weight: 1 }] },
    });
    const emptyGroup = providerService.create({
      name: 'EmptyG', type: 'group',
      config: { dispatchPolicy: 'priority', members: [] },
    });
    const disabled = providerService.create({
      name: 'disabled', type: 'comfyui', config: { baseUrl: 'http://disabled:8188' },
    });
    providerService.update(disabled.id, { enabled: false });

    const routeApp = express();
    routeApp.use(express.json());
    routeApp.use('/api/tasks', createTaskRoutes(db));
    return { app: routeApp, db, taskService, providerService, instance, group, member, emptyGroup, disabled };
  }

  /**
   * 打桩 fetch，模拟可用的 ComfyUI 执行端。
   * @param options promptStatus 提交返回的状态码（非 200 用于模拟提交被拒）
   * @param options unreachableHost 该主机名的连通性探测失败（模拟实例不可达）
   * @returns 提交调用记录
   */
  function stubFetch(options?: { promptStatus?: number; unreachableHost?: string }): { promptCalls: string[] } {
    const promptCalls: string[] = [];
    const promptStatus = options?.promptStatus ?? 200;
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/system_stats')) {
        const unreachable = options?.unreachableHost ? url.includes(options.unreachableHost) : false;
        return new Response('{}', { status: unreachable ? 503 : 200 });
      }
      if (url.endsWith('/prompt')) {
        promptCalls.push(url);
        if (promptStatus !== 200) return new Response('rejected', { status: promptStatus });
        return new Response(JSON.stringify({ prompt_id: `pid-${promptCalls.length}` }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);
    return { promptCalls };
  }

  /**
   * 建一条排队中的任务。
   * @param env 测试环境
   * @param providerId 归属实例 ID
   * @param lockActual 是否锁定实际执行实例（具体实例目标为 true，分组为 false）
   * @returns 任务行
   */
  function createQueuedTask(env: ReassignEnv, providerId: string, lockActual: boolean) {
    const task = env.taskService.create({
      workflowId: 'wf-1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: '/prompt', comfyuiRequestBody: '{"prompt":{}}',
      comfyuiResponse: null, promptId: null,
      providerId, providerName: providerId,
    });
    env.taskService.updateStatus(task.id, { status: 'queued' });
    if (lockActual) {
      env.taskService.setActualProvider(task.id, {
        actualProviderId: providerId, actualProviderName: providerId, promptId: '',
      });
    }
    return env.taskService.getById(task.id)!;
  }

  it('PATCH /provider 改派到具体实例：锁定归属并投递（自动调度，非插队）', async () => {
    const { promptCalls } = stubFetch();
    const env = createEnv();
    // 初始目标为无成员空分组：任务不会被任何调度投递
    const task = createQueuedTask(env, env.emptyGroup.id, false);
    const svc = startExecutionService(env.db);
    try {
      const res = await supertest(env.app)
        .patch(`/api/tasks/${task.id}/provider`)
        .send({ providerId: env.instance.id });

      expect(res.status).toBe(200);
      expect(res.body.provider_id).toBe(env.instance.id);
      // 实例空闲：改派后立即被调度投递
      expect(res.body.status).toBe('pending');
      expect(promptCalls).toHaveLength(1);

      const after = env.taskService.getById(task.id)!;
      expect(after.providerId).toBe(env.instance.id);
      expect(after.providerName).toBe('inst');
      expect(after.actualProviderId).toBe(env.instance.id);
      // 提交地址随目标实例更新
      expect(after.comfyuiUrl).toBe('http://inst:8188/prompt');
    } finally {
      svc.stop();
    }
  });

  it('PATCH /provider 改派到分组：归属记为分组，实际执行实例由调度器选定', async () => {
    const { promptCalls } = stubFetch();
    const env = createEnv();
    const task = createQueuedTask(env, env.emptyGroup.id, false);
    const svc = startExecutionService(env.db);
    try {
      const res = await supertest(env.app)
        .patch(`/api/tasks/${task.id}/provider`)
        .send({ providerId: env.group.id });

      expect(res.status).toBe(200);
      expect(res.body.provider_id).toBe(env.group.id);
      // 分组有可用成员：改派后由分组调度投递到成员
      expect(res.body.status).toBe('pending');
      expect(promptCalls).toHaveLength(1);

      const after = env.taskService.getById(task.id)!;
      expect(after.providerId).toBe(env.group.id);
      expect(after.providerName).toBe('G');
      expect(after.actualProviderId).toBe(env.member.id);
      expect(after.actualProviderName).toBe('member');
    } finally {
      svc.stop();
    }
  });

  it('PATCH /provider 到无成员分组：允许保存但附带滞留警告', async () => {
    const { promptCalls } = stubFetch();
    const env = createEnv();
    const task = createQueuedTask(env, env.emptyGroup.id, false);
    const svc = startExecutionService(env.db);
    try {
      const res = await supertest(env.app)
        .patch(`/api/tasks/${task.id}/provider`)
        .send({ providerId: env.emptyGroup.id });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('queued');
      // 明确告知任务会滞留队列（不静默接受）
      expect(String(res.body.warning)).toContain('没有可参与自动分配的成员');
      expect(promptCalls).toHaveLength(0);

      const after = env.taskService.getById(task.id)!;
      expect(after.providerId).toBe(env.emptyGroup.id);
      // 分组目标下实际执行实例清空，待调度器选定成员后回填
      expect(after.actualProviderId).toBeNull();
    } finally {
      svc.stop();
    }
  });

  it('PATCH /provider 到具体实例但槽位已满：任务保持排队（改派不等于插队）', async () => {
    const { promptCalls } = stubFetch();
    const env = createEnv();
    const svc = startExecutionService(env.db);
    try {
      // 先用一条 pending 任务占满实例唯一槽位
      const occupying = env.taskService.create({
        workflowId: 'wf-1', workflowName: 'wf', aliasValues: '{}',
        comfyuiUrl: 'http://inst:8188/prompt', comfyuiRequestBody: '{"prompt":{}}',
        comfyuiResponse: null, promptId: 'pid-running',
        providerId: env.instance.id, providerName: 'inst',
      });
      env.taskService.setActualProvider(occupying.id, {
        actualProviderId: env.instance.id, actualProviderName: 'inst', promptId: 'pid-running',
      });
      const task = createQueuedTask(env, env.emptyGroup.id, false);

      const res = await supertest(env.app)
        .patch(`/api/tasks/${task.id}/provider`)
        .send({ providerId: env.instance.id });

      // 改派只改变调度归属：槽位满时仍留在队列等待，不立即提交
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('queued');
      expect(promptCalls).toHaveLength(0);
      expect(env.taskService.getById(task.id)?.actualProviderId).toBe(env.instance.id);
    } finally {
      svc.stop();
    }
  });

  it('PATCH /provider 校验：缺少参数 / 目标不可用 / 状态不符 / 任务不存在', async () => {
    stubFetch();
    const env = createEnv();
    const svc = startExecutionService(env.db);
    try {
      const task = createQueuedTask(env, env.emptyGroup.id, false);

      // 缺少 providerId
      const missing = await supertest(env.app).patch(`/api/tasks/${task.id}/provider`).send({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('missing_parameter');

      // 目标实例不存在
      const notFound = await supertest(env.app)
        .patch(`/api/tasks/${task.id}/provider`)
        .send({ providerId: 'no-such-provider' });
      expect(notFound.status).toBe(400);
      expect(notFound.body.code).toBe('provider_not_configured');

      // 目标实例已停用
      const disabled = await supertest(env.app)
        .patch(`/api/tasks/${task.id}/provider`)
        .send({ providerId: env.disabled.id });
      expect(disabled.status).toBe(400);
      expect(disabled.body.code).toBe('provider_not_configured');

      // 任务不存在
      const ghost = await supertest(env.app)
        .patch('/api/tasks/nonexistent/provider')
        .send({ providerId: env.instance.id });
      expect(ghost.status).toBe(404);
      expect(ghost.body.code).toBe('task_not_found');

      // 已提交（pending）的任务不可改派
      const pendingTask = env.taskService.create({
        workflowId: 'wf-1', workflowName: 'wf', aliasValues: '{}',
        comfyuiUrl: 'http://inst:8188/prompt', comfyuiRequestBody: '{"prompt":{}}',
        comfyuiResponse: null, promptId: 'pid-x',
        providerId: env.instance.id, providerName: 'inst',
      });
      const wrongStatus = await supertest(env.app)
        .patch(`/api/tasks/${pendingTask.id}/provider`)
        .send({ providerId: env.instance.id });
      expect(wrongStatus.status).toBe(400);
      expect(wrongStatus.body.code).toBe('invalid_status');

      // 校验失败均不改写原有归属
      expect(env.taskService.getById(task.id)?.providerId).toBe(env.emptyGroup.id);
    } finally {
      svc.stop();
    }
  });

  it('POST /submit 插队：无视并发上限提交到指定具体实例并改写归属', async () => {
    const { promptCalls } = stubFetch();
    const env = createEnv();
    const svc = startExecutionService(env.db);
    try {
      // 占满实例唯一并发槽位，证明插队不受并发限制
      const occupying = env.taskService.create({
        workflowId: 'wf-1', workflowName: 'wf', aliasValues: '{}',
        comfyuiUrl: 'http://inst:8188/prompt', comfyuiRequestBody: '{"prompt":{}}',
        comfyuiResponse: null, promptId: 'pid-running',
        providerId: env.instance.id, providerName: 'inst',
      });
      env.taskService.setActualProvider(occupying.id, {
        actualProviderId: env.instance.id, actualProviderName: 'inst', promptId: 'pid-running',
      });
      const task = createQueuedTask(env, env.emptyGroup.id, false);

      const res = await supertest(env.app)
        .post(`/api/tasks/${task.id}/submit`)
        .send({ providerId: env.instance.id });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(promptCalls).toHaveLength(1);

      // 插队即改道：归属与实际执行实例都改为选定实例
      const after = env.taskService.getById(task.id)!;
      expect(after.providerId).toBe(env.instance.id);
      expect(after.actualProviderId).toBe(env.instance.id);
      expect(after.promptId).toBe('pid-1');
    } finally {
      svc.stop();
    }
  });

  it('POST /submit 目标实例不可达：保持排队并返回 502（可改选实例重试）', async () => {
    const { promptCalls } = stubFetch({ unreachableHost: 'inst:8188' });
    const env = createEnv();
    const svc = startExecutionService(env.db);
    try {
      const task = createQueuedTask(env, env.emptyGroup.id, false);

      const res = await supertest(env.app)
        .post(`/api/tasks/${task.id}/submit`)
        .send({ providerId: env.instance.id });

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('comfyui_unreachable');
      expect(promptCalls).toHaveLength(0);

      // 任务保持待调度（不置失败），用户可改选其他实例
      const after = env.taskService.getById(task.id)!;
      expect(after.status).toBe('queued');
      expect(after.providerId).toBe(env.instance.id);
    } finally {
      svc.stop();
    }
  });

  it('POST /submit 参数校验：必须显式选择具体实例（分组不可直接提交）', async () => {
    stubFetch();
    const env = createEnv();
    const svc = startExecutionService(env.db);
    try {
      const task = createQueuedTask(env, env.emptyGroup.id, false);

      // 缺少 providerId：必须显式选择目标实例
      const missing = await supertest(env.app).post(`/api/tasks/${task.id}/submit`).send({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('missing_parameter');

      // 分组无自有提交端点：拒绝插队到分组
      const toGroup = await supertest(env.app)
        .post(`/api/tasks/${task.id}/submit`)
        .send({ providerId: env.group.id });
      expect(toGroup.status).toBe(400);
      expect(toGroup.body.code).toBe('provider_not_configured');

      // 已提交的任务不能重复插队
      const pendingTask = env.taskService.create({
        workflowId: 'wf-1', workflowName: 'wf', aliasValues: '{}',
        comfyuiUrl: 'http://inst:8188/prompt', comfyuiRequestBody: '{"prompt":{}}',
        comfyuiResponse: null, promptId: 'pid-x',
        providerId: env.instance.id, providerName: 'inst',
      });
      const wrongStatus = await supertest(env.app)
        .post(`/api/tasks/${pendingTask.id}/submit`)
        .send({ providerId: env.instance.id });
      expect(wrongStatus.status).toBe(400);
      expect(wrongStatus.body.code).toBe('invalid_status');
    } finally {
      svc.stop();
    }
  });
});
