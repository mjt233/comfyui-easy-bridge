import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from './task.service';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, provider_id TEXT, provider_name TEXT, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, actual_provider_id TEXT, actual_provider_name TEXT);
  `);
  return drizzle(sqlite, { schema });
}

function createWorkflow(db: ReturnType<typeof createTestDb>, id: string) {
  db.insert(schema.workflows).values({
    id, name: 'test', rawJson: '{}', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
}

describe('TaskService.updateOutputFiles', () => {
  it('stores and retrieves output files', () => {
    const db = createTestDb();
    createWorkflow(db, 'wf1');
    const svc = new TaskService(db);
    const task = svc.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'prompt-123',
    });
    const files: OutputFile[] = [
      { filename: 'output.png', subfolder: '', type: 'output', nodeId: '9', fileType: 'image' },
    ];
    svc.updateOutputFiles(task.id, files);
    const updated = svc.getById(task.id);
    expect(JSON.parse(updated!.outputFiles!)).toEqual(files);
  });

  it('replaces previous output files on second call', () => {
    const db = createTestDb();
    createWorkflow(db, 'wf1');
    const svc = new TaskService(db);
    const task = svc.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'prompt-123',
    });
    svc.updateOutputFiles(task.id, [
      { filename: 'old.png', subfolder: '', type: 'output', nodeId: '9', fileType: 'image' },
    ]);
    svc.updateOutputFiles(task.id, [
      { filename: 'new.png', subfolder: '', type: 'output', nodeId: '10', fileType: 'image' },
    ]);
    const updated = svc.getById(task.id);
    expect(JSON.parse(updated!.outputFiles!)).toEqual([
      { filename: 'new.png', subfolder: '', type: 'output', nodeId: '10', fileType: 'image' },
    ]);
  });

  it('returns null outputFiles for task with no output files', () => {
    const db = createTestDb();
    createWorkflow(db, 'wf2');
    const svc = new TaskService(db);
    const task = svc.create({
      workflowId: 'wf2', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: null,
    });
    expect(task.outputFiles).toBeNull();
  });
});

describe('TaskService.getByPromptId', () => {
  it('finds task by promptId', () => {
    const db = createTestDb();
    createWorkflow(db, 'wf3');
    const svc = new TaskService(db);
    const task = svc.create({
      workflowId: 'wf3', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'find-me',
    });
    const found = svc.getByPromptId('find-me');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(task.id);
  });

  it('returns null for unknown promptId', () => {
    const db = createTestDb();
    const svc = new TaskService(db);
    expect(svc.getByPromptId('nonexistent')).toBeNull();
  });
});

describe('TaskService provider support', () => {
  let db: ReturnType<typeof createTestDb>;
  let service: TaskService;

  beforeEach(() => {
    db = createTestDb();
    service = new TaskService(db);
  });

  it('stores providerId on create', () => {
    const task = service.create({
      workflowId: 'w1',
      workflowName: 'wf',
      aliasValues: '{}',
      comfyuiUrl: 'http://x/prompt',
      comfyuiRequestBody: null,
      comfyuiResponse: null,
      promptId: null,
      providerId: 'p1',
      providerName: '我的提供商',
    });
    expect(task.providerId).toBe('p1');
    expect(task.providerName).toBe('我的提供商');
    expect(task.status).toBe('failed');
  });

  it('stores null providerName when not provided', () => {
    const task = service.create({
      workflowId: 'w1',
      workflowName: 'wf',
      aliasValues: '{}',
      comfyuiUrl: 'http://x/prompt',
      comfyuiRequestBody: null,
      comfyuiResponse: null,
      promptId: null,
    });
    expect(task.providerId).toBeNull();
    expect(task.providerName).toBeNull();
  });

  it('filters pending by providerId', () => {
    // p1 有两个任务：一个 queued、一个 pending（用于验证状态与提供商联合过滤）
    const t1 = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: null, providerId: 'p1',
    });
    // promptId 非空 → 状态为 pending
    const t3 = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: 'pt3', providerId: 'p1',
    });
    service.updateStatus(t1.id, { status: 'queued' });

    // 带 providerId 的 pending 查询只返回该提供商的 pending 任务
    expect(service.listPending('p1').map((t) => t.id)).toEqual([t3.id]);
    expect(service.listPending().map((t) => t.id)).toHaveLength(1);
  });

  it('listQueuedByTarget 同时按「锁定的实际执行实例」与「分组归属」匹配排队任务', () => {
    // 具体实例目标：入队时已锁定 actual_provider_id（调度器据此消费实例队列）
    const locked = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: null, providerId: 'inst-1', providerName: 'inst-1',
    });
    service.updateStatus(locked.id, { status: 'queued' });
    service.setActualProvider(locked.id, { actualProviderId: 'inst-1', actualProviderName: 'inst-1', promptId: '' });

    // 分组目标：provider_id 为分组、actual_provider_id 为空（由调度器挑选成员）
    const grouped = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: null, providerId: 'group-1', providerName: 'group-1',
    });
    service.updateStatus(grouped.id, { status: 'queued' });

    // 队列按 createdAt 升序：两条任务都归属各自目标，互不串台
    expect(service.listQueuedByTarget('inst-1').map((t) => t.id)).toEqual([locked.id]);
    expect(service.listQueuedByTarget('group-1').map((t) => t.id)).toEqual([grouped.id]);
    // 无排队任务的目标返回空列表
    expect(service.listQueuedByTarget('nothing')).toEqual([]);
  });

  it('setTargetProvider 改写归属：具体实例同时锁定实际执行实例，分组则清空', () => {
    const task = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: null, providerId: 'group-old', providerName: 'G',
    });
    service.updateStatus(task.id, { status: 'queued' });
    // 先由分组调度到成员，验证改道前的状态
    service.updateActualProvider(task.id, { actualProviderId: 'member-a', actualProviderName: 'A', promptId: 'pid' });
    service.updateStatus(task.id, { status: 'queued' });

    // 改到具体实例：两个字段对都指向新实例
    service.setTargetProvider(task.id, {
      providerId: 'inst-2',
      providerName: 'Inst2',
      actualProviderId: 'inst-2',
      actualProviderName: 'Inst2',
      comfyuiUrl: 'http://inst2:8188/prompt',
    });
    const toInstance = service.getById(task.id)!;
    expect(toInstance.providerId).toBe('inst-2');
    expect(toInstance.providerName).toBe('Inst2');
    expect(toInstance.actualProviderId).toBe('inst-2');
    expect(toInstance.actualProviderName).toBe('Inst2');
    expect(toInstance.comfyuiUrl).toBe('http://inst2:8188/prompt');
    // 改道不改变任务状态（仍为待调度）
    expect(toInstance.status).toBe('queued');

    // 改到分组：归属记为分组，实际执行实例清空待调度器回填
    service.setTargetProvider(task.id, {
      providerId: 'group-2',
      providerName: 'G2',
      actualProviderId: null,
      actualProviderName: null,
      comfyuiUrl: '/prompt',
    });
    const toGroup = service.getById(task.id)!;
    expect(toGroup.providerId).toBe('group-2');
    expect(toGroup.providerName).toBe('G2');
    expect(toGroup.actualProviderId).toBeNull();
    expect(toGroup.actualProviderName).toBeNull();
  });
});

describe('TaskService startedAt / completedAt 语义', () => {
  let db: ReturnType<typeof createTestDb>;
  let service: TaskService;

  beforeEach(() => {
    db = createTestDb();
    createWorkflow(db, 'w1');
    service = new TaskService(db);
  });

  it('create 带 promptId 时写入 startedAt，completedAt 为空', () => {
    const task = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: 'p-ok',
    });
    expect(task.status).toBe('pending');
    expect(task.startedAt).toBeTruthy();
    expect(task.completedAt).toBeNull();
  });

  it('create 无 promptId 时无 startedAt，有 completedAt', () => {
    const task = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: null,
    });
    expect(task.status).toBe('failed');
    expect(task.startedAt).toBeNull();
    expect(task.completedAt).toBeTruthy();
  });

  it('updateStatus(queued) 清空 completedAt 且不写 startedAt', () => {
    // create 无 promptId → failed + completedAt；再改为 queued 应清空完成时间
    const task = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: '{}', comfyuiResponse: null,
      promptId: null,
    });
    const queued = service.updateStatus(task.id, { status: 'queued' });
    expect(queued.status).toBe('queued');
    expect(queued.startedAt).toBeNull();
    expect(queued.completedAt).toBeNull();
  });

  it('queued → pending 首次写入 startedAt；再次 pending 不覆盖', async () => {
    const task = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: '{}', comfyuiResponse: null,
      promptId: null,
    });
    service.updateStatus(task.id, { status: 'queued' });

    const pending1 = service.updateStatus(task.id, {
      status: 'pending',
      promptId: 'prompt-1',
    });
    expect(pending1.startedAt).toBeTruthy();
    expect(pending1.completedAt).toBeNull();
    const firstStarted = pending1.startedAt!;

    // 稍等保证时间戳可能变化，再更新仍应保留首次 startedAt
    await new Promise((r) => setTimeout(r, 5));
    const pending2 = service.updateStatus(task.id, { status: 'pending' });
    expect(pending2.startedAt).toBe(firstStarted);
  });

  it('pending → completed 保留 startedAt 并写入 completedAt', () => {
    const task = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: 'prompt-done',
    });
    const started = task.startedAt;
    expect(started).toBeTruthy();

    const done = service.updateStatus(task.id, { status: 'completed' });
    expect(done.startedAt).toBe(started);
    expect(done.completedAt).toBeTruthy();
    expect(done.status).toBe('completed');
  });
});
