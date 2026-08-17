import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from './task.service';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, provider_id TEXT, provider_name TEXT, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
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

  it('filters queued and pending by providerId', () => {
    // p1 有两个任务：一个 queued、一个 pending（用于验证状态与提供商联合过滤）
    const t1 = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: null, providerId: 'p1',
    });
    const t2 = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: null, providerId: 'p2',
    });
    // promptId 非空 → 状态为 pending
    const t3 = service.create({
      workflowId: 'w1', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null,
      promptId: 'pt3', providerId: 'p1',
    });
    service.updateStatus(t1.id, { status: 'queued' });
    service.updateStatus(t2.id, { status: 'queued' });

    // 带 providerId 时只返回该提供商且状态为 queued 的任务（t3 是 pending，必须被排除）
    expect(service.listQueued('p1').map((t) => t.id)).toEqual([t1.id]);
    // 不带参数保持向后兼容：返回全部 queued 任务
    expect(service.listQueued().map((t) => t.id)).toHaveLength(2);
    // 带 providerId 的 pending 查询
    expect(service.listPending('p1').map((t) => t.id)).toEqual([t3.id]);
    expect(service.listPending().map((t) => t.id)).toHaveLength(1);
    // countByStatus 同样支持按提供商过滤
    expect(service.countByStatus('queued', 'p1')).toBe(1);
    expect(service.countByStatus('queued')).toBe(2);
    expect(service.countByStatus('pending', 'p1')).toBe(1);
  });
});
