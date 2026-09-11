import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createWorkflowRoutes } from './workflow.routes';
import { createAuthRoutes } from './auth.routes';
import { createSettingsRoutes } from './settings.routes';
import { createTaskRoutes } from './task.routes';
import { createProvidersRoutes } from './providers.routes';
import { ProviderService, type ProviderRow } from '../services/providers/provider.service';
import { TaskService } from '../services/task.service';
import { startExecutionService } from '../services/execution.service';
import { healthCheckConfig } from '../services/providers/health.service';
import { dispatcherConfig } from '../services/dispatcher.service';

/** 临时数据目录（暂存文件与数据库隔离用） */
let tempDataDir = '';

/**
 * 打桩全局 fetch，模拟可用的 ComfyUI 执行端：
 * - /system_stats → 2xx（连通性探测通过）
 * - /prompt → 返回递增的 prompt_id
 * - /upload/image → 返回上传后的文件名（并记录调用）
 * - /history/{id} → 返回执行成功
 * - /queue → 空队列（中断确认用）
 * @returns 提交与上传调用记录
 */
function stubFetch(): { promptCalls: string[]; uploadCalls: string[] } {
  const promptCalls: string[] = [];
  const uploadCalls: string[] = [];
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/system_stats')) return new Response('{}', { status: 200 });
    if (url.endsWith('/prompt')) {
      promptCalls.push(url);
      return new Response(JSON.stringify({ prompt_id: `pid-${promptCalls.length}` }), { status: 200 });
    }
    if (url.endsWith('/upload/image')) {
      uploadCalls.push(url);
      return new Response(JSON.stringify({ name: 'uploaded-by-member.png' }), { status: 200 });
    }
    if (url.includes('/history/')) return new Response(JSON.stringify({}), { status: 200 });
    if (url.endsWith('/queue')) {
      return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch);
  return { promptCalls, uploadCalls };
}

describe('分组（自动分配）执行路由', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: express.Express;
  let providerService: ProviderService;
  let taskService: TaskService;
  let execution: { stop: () => void };
  let token = '';

  beforeAll(() => {
    // 暂存文件写入临时目录，避免污染仓库 data 目录
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-exec-test-'));
    process.env.DATA_DIR = tempDataDir;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 缩短巡检/兜底间隔，避免用例真实等待
    healthCheckConfig.sweepIntervalMs = 60000;
    dispatcherConfig.fallbackIntervalMs = 60000;

    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_params (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, field_name TEXT NOT NULL, alias TEXT UNIQUE, label TEXT, param_type TEXT NOT NULL DEFAULT 'text', default_value TEXT, candidates TEXT NOT NULL DEFAULT '[]', multiple INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE workflow_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, filename TEXT NOT NULL, stored_name TEXT NOT NULL, size INTEGER NOT NULL, mimetype TEXT, created_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, provider_id TEXT, provider_name TEXT, actual_provider_id TEXT, actual_provider_name TEXT, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, is_preset INTEGER NOT NULL DEFAULT 0, metadata_def TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_tags (workflow_id TEXT NOT NULL, tag_id TEXT NOT NULL, metadata_values TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (workflow_id, tag_id));
    `);
    db = drizzle(sqlite, { schema });
    providerService = new ProviderService(db);
    taskService = new TaskService(db);

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));
    app.use('/api/workflows', createWorkflowRoutes(db));
    app.use('/api/settings', createSettingsRoutes(db));
    app.use('/api/tasks', createTaskRoutes(db));
    app.use('/api/providers', createProvidersRoutes(db));

    // 登录拿 token（默认密码）并关闭鉴权，简化后续断言
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    token = loginRes.body.token as string;

    // 启动执行服务（健康巡检 + 分组调度器 + 成员跟踪器）
    execution = startExecutionService(db);
  });

  afterEach(() => {
    execution.stop();
    vi.unstubAllGlobals();
  });

  /**
   * 建一个 comfyui 成员实例。
   * @param name 展示名（同时作为 baseUrl 主机名）
   * @param concurrency 并发上限
   * @returns 实例行
   */
  function setupMember(name: string, concurrency = 1): ProviderRow {
    return providerService.create({
      name,
      type: 'comfyui',
      config: { baseUrl: `http://${name}:8188` },
      concurrency,
    });
  }

  /**
   * 建一个分组实例。
   * @param members 成员与权重
   * @returns 分组实例行
   */
  function setupGroup(members: Array<{ providerId: string; weight: number }>): ProviderRow {
    return providerService.create({
      name: 'G',
      type: 'group',
      config: { dispatchPolicy: 'priority', members },
    });
  }

  /**
   * 建一个执行指定提供商的工作流。
   * @param id 工作流 ID
   * @param providerId 指定的提供商实例 ID
   */
  async function setupWorkflow(id: string, providerId: string): Promise<void> {
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id, name: id, rawJson: '{}', providerId });
  }

  it('submits immediately to a group member when a slot is free', async () => {
    const { promptCalls } = stubFetch();
    const member = setupMember('m1');
    const group = setupGroup([{ providerId: member.id, weight: 1 }]);
    await setupWorkflow('wf-group', group.id);

    const res = await supertest(app)
      .post('/api/workflows/wf-group/execute')
      .send({ prompt: 'cat' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(promptCalls).toHaveLength(1);

    const task = taskService.getById(res.body.task_id as string)!;
    // providerId 记录用户选择的分组，actualProviderId 记录实际执行的成员
    expect(task.providerId).toBe(group.id);
    expect(task.providerName).toBe('G');
    expect(task.actualProviderId).toBe(member.id);
    expect(task.actualProviderName).toBe('m1');
    expect(task.promptId).toBe('pid-1');
  });

  it('rejects submission when the group has no assignable member', async () => {
    stubFetch();
    // 成员被停用 → 分组实际没有可分配成员
    const member = setupMember('disabled');
    providerService.update(member.id, { enabled: false });
    const group = setupGroup([{ providerId: member.id, weight: 1 }]);
    await setupWorkflow('wf-empty', group.id);

    const res = await supertest(app)
      .post('/api/workflows/wf-empty/execute')
      .send({ prompt: 'cat' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('provider_no_available_instance');
  });

  it('queues the task when every member slot is busy, then dispatches it after a slot frees up', async () => {
    const { promptCalls } = stubFetch();
    const member = setupMember('busy', 1);
    const group = setupGroup([{ providerId: member.id, weight: 1 }]);
    await setupWorkflow('wf-queued', group.id);

    // 先占用该成员唯一的并发槽位
    const occupying = taskService.create({
      workflowId: 'wf-queued',
      workflowName: 'wf',
      aliasValues: '{}',
      comfyuiUrl: 'http://busy:8188/prompt',
      comfyuiRequestBody: '{"prompt":{}}',
      comfyuiResponse: null,
      promptId: 'pid-busy',
      providerId: member.id,
      providerName: 'busy',
    });
    taskService.setActualProvider(occupying.id, {
      actualProviderId: member.id,
      actualProviderName: 'busy',
      promptId: 'pid-busy',
    });

    const res = await supertest(app)
      .post('/api/workflows/wf-queued/execute')
      .send({ prompt: 'cat' });

    // 成员无空闲并发 → 任务进入分组独立队列
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
    expect(promptCalls).toHaveLength(0);

    // 释放槽位后触发调度：排队任务被分配到该成员
    taskService.updateStatus(occupying.id, { status: 'completed' });
    await supertest(app)
      .post(`/api/tasks/${res.body.task_id}/submit`)
      .set('Authorization', `Bearer ${token}`);

    const after = taskService.getById(res.body.task_id as string)!;
    expect(after.status).toBe('pending');
    expect(after.actualProviderId).toBe(member.id);
    expect(promptCalls).toHaveLength(1);
  });

  it('serves group member slots through the providers list and health endpoint', async () => {
    stubFetch();
    const member = setupMember('m2', 2);
    const group = setupGroup([{ providerId: member.id, weight: 4 }]);

    const listRes = await supertest(app)
      .get('/api/providers')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const groupSummary = (listRes.body as Array<{ id: string }>).find((p) => p.id === group.id) as unknown as {
      dispatchPolicy: string;
      memberCount: number;
      availableSlots: number;
      members: Array<{ providerId: string; weight: number; availableSlots: number }>;
    };
    expect(groupSummary.dispatchPolicy).toBe('priority');
    expect(groupSummary.memberCount).toBe(1);
    expect(groupSummary.availableSlots).toBe(2);
    expect(groupSummary.members[0]).toMatchObject({ providerId: member.id, weight: 4, availableSlots: 2 });

    const healthRes = await supertest(app)
      .get(`/api/providers/${group.id}/health`)
      .set('Authorization', `Bearer ${token}`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.memberCount).toBe(1);
  });

  it('rejects execution when the workflow explicitly指定 a disabled provider', async () => {
    stubFetch();
    const disabled = setupMember('off');
    providerService.update(disabled.id, { enabled: false });
    // 另有一个可用默认实例，用于验证不会静默回退
    const fallback = setupMember('fallback');
    providerService.setDefault(fallback.id);
    await setupWorkflow('wf-off', disabled.id);

    const res = await supertest(app)
      .post('/api/workflows/wf-off/execute')
      .send({ prompt: 'cat' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('provider_not_configured');
  });

  it('executes a group task via an explicit providerId override', async () => {
    const { promptCalls } = stubFetch();
    const member = setupMember('m3');
    const group = setupGroup([{ providerId: member.id, weight: 1 }]);
    // 工作流本身未指定提供商（走默认），本次执行显式指定分组
    const def = setupMember('def');
    providerService.setDefault(def.id);
    await setupWorkflow('wf-override', def.id);

    const res = await supertest(app)
      .post('/api/workflows/wf-override/execute')
      .send({ prompt: 'cat', providerId: group.id });

    expect(res.status).toBe(200);
    const task = taskService.getById(res.body.task_id as string)!;
    expect(task.providerId).toBe(group.id);
    expect(task.actualProviderId).toBe(member.id);
    expect(promptCalls.some((u) => u.includes('m3:8188'))).toBe(true);
  });

  it('stages media locally and uploads it to the selected member before submitting', async () => {
    const { promptCalls, uploadCalls } = stubFetch();
    const member = setupMember('media-member');
    const group = setupGroup([{ providerId: member.id, weight: 1 }]);
    // 工作流含一个图片输入节点 + 一个暴露为 image 类型的参数
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({
        id: 'wf-media',
        name: 'MediaGroup',
        rawJson: JSON.stringify({ '1': { inputs: { image: 'placeholder.png' }, class_type: 'LoadImage' } }),
        providerId: group.id,
      });
    const paramRes = await supertest(app)
      .post('/api/workflows/wf-media/params')
      .set('Authorization', `Bearer ${token}`)
      .send({ nodeId: '1', fieldName: 'image', alias: 'image' });
    expect(paramRes.status).toBe(201);
    await supertest(app)
      .put(`/api/workflows/wf-media/params/${paramRes.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ paramType: 'image' });

    const res = await supertest(app)
      .post('/api/workflows/wf-media/execute')
      .set('Authorization', `Bearer ${token}`)
      .field('params', JSON.stringify({}))
      .attach('image', Buffer.from('fake-png-bytes'), 'demo.png');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');

    const task = taskService.getById(res.body.task_id as string)!;
    // 媒体上传到最终选定的成员实例（而非分组）
    expect(uploadCalls).toEqual(['http://media-member:8188/upload/image']);

    // 提交请求体中注入的应是暂存阶段生成的存储名，且上传完成后暂存目录被清理
    const body = JSON.parse(task.comfyuiRequestBody ?? '{}') as { prompt: Record<string, { inputs: { image: string } }> };
    const injected = body.prompt['1'].inputs.image;
    expect(injected).toMatch(/\.png$/);
    expect(injected).not.toBe('placeholder.png');
    expect(injected).not.toBe('uploaded-by-member.png');
    // 提交成功后异步清理暂存目录（fire-and-forget），等待其完成
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(tempDataDir, 'task-staging', task.id))).toBe(false);
    });
    expect(promptCalls).toHaveLength(1);
  });

  it('routes group task cancellation to the actual member instance', async () => {
    const { promptCalls } = stubFetch();
    const member = setupMember('cancel-member');
    const group = setupGroup([{ providerId: member.id, weight: 1 }]);
    await setupWorkflow('wf-cancel-group', group.id);

    const res = await supertest(app)
      .post('/api/workflows/wf-cancel-group/execute')
      .send({ prompt: 'cat' });
    const taskId = res.body.task_id as string;
    expect(taskService.getById(taskId)?.actualProviderId).toBe(member.id);

    // 中断：必须走 actualProviderId 指向的成员实例（分组本身没有 /interrupt 端点）
    const cancelRes = await supertest(app)
      .post(`/api/tasks/${taskId}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(cancelRes.status).toBe(200);
    expect(taskService.getById(taskId)?.status).toBe('failed');
    expect(promptCalls).toHaveLength(1);
  });
});
