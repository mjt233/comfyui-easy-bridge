import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { WorkflowService } from './workflow.service';

describe('WorkflowService', () => {
  let service: WorkflowService;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_params (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        alias TEXT,
        label TEXT,
        param_type TEXT NOT NULL DEFAULT 'text',
        default_value TEXT,
        UNIQUE(workflow_id, alias)
      );
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
    `);
    const db = drizzle(sqlite, { schema });
    service = new WorkflowService(db);
  });

  it('creates and retrieves a workflow', () => {
    const wf = service.create({ id: 'my-flow', name: 'Test Flow', rawJson: '{}' });
    expect(wf.id).toBe('my-flow');
    expect(wf.name).toBe('Test Flow');

    const retrieved = service.getById('my-flow');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('Test Flow');
  });

  it('lists all workflows', () => {
    service.create({ id: 'wf1', name: 'WF1', rawJson: '{}' });
    service.create({ id: 'wf2', name: 'WF2', rawJson: '{}' });
    const list = service.list();
    expect(list).toHaveLength(2);
  });

  it('returns null for non-existent workflow', () => {
    expect(service.getById('nonexistent')).toBeNull();
  });

  it('updates a workflow', () => {
    service.create({ id: 'wf', name: 'Original', rawJson: '{}' });
    service.update('wf', { name: 'Updated' });
    const wf = service.getById('wf');
    expect(wf!.name).toBe('Updated');
  });

  it('deletes a workflow', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.delete('wf');
    expect(service.getById('wf')).toBeNull();
  });

  it('adds and lists params for a workflow', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '30:19',
      fieldName: 'value',
      alias: 'img_desc',
    });
    expect(param.alias).toBe('img_desc');

    const params = service.getParams('wf');
    expect(params).toHaveLength(1);
    expect(params[0].alias).toBe('img_desc');
  });

  it('deletes params when workflow is deleted', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'a' });
    service.delete('wf');
    const params = service.getParams('wf');
    expect(params).toHaveLength(0);
  });

  it('throws on duplicate alias within same workflow', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'dup' });
    expect(() => service.addParam({ workflowId: 'wf', nodeId: '2', fieldName: 'v', alias: 'dup' })).toThrow();
  });

  it('allows same alias across different workflows', () => {
    service.create({ id: 'wf1', name: 'WF1', rawJson: '{}' });
    service.create({ id: 'wf2', name: 'WF2', rawJson: '{}' });
    service.addParam({ workflowId: 'wf1', nodeId: '1', fieldName: 'v', alias: 'shared' });
    expect(() => service.addParam({ workflowId: 'wf2', nodeId: '1', fieldName: 'v', alias: 'shared' })).not.toThrow();
  });

  it('deletes a param', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'a' });
    service.deleteParam(p.id);
    expect(service.getParams('wf')).toHaveLength(0);
  });

  it('updates a param', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'a' });
    const updated = service.updateParam(p.id, { alias: 'b', label: '标签' });
    expect(updated.alias).toBe('b');
    expect(updated.label).toBe('标签');
  });

  it('updates workflow ID with cascade to params', () => {
    service.create({ id: 'old-id', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'old-id', nodeId: '1', fieldName: 'v', alias: 'a' });

    service.update('old-id', { id: 'new-id' });

    // 新 ID 可查询
    const wf = service.getById('new-id');
    expect(wf).not.toBeNull();
    expect(wf!.name).toBe('WF');

    // 旧 ID 不可查询
    expect(service.getById('old-id')).toBeNull();

    // 参数的 workflowId 已级联更新
    const params = service.getParams('new-id');
    expect(params).toHaveLength(1);
    expect(params[0].workflowId).toBe('new-id');
  });

  it('throws when updating to an existing ID', () => {
    service.create({ id: 'wf1', name: 'WF1', rawJson: '{}' });
    service.create({ id: 'wf2', name: 'WF2', rawJson: '{}' });

    expect(() => service.update('wf1', { id: 'wf2' })).toThrow();
  });

  it('updates name and rawJson without changing ID', () => {
    service.create({ id: 'test', name: 'Old', rawJson: '{"a":1}' });
    service.update('test', { name: 'New Name', rawJson: '{"b":2}' });

    const wf = service.getById('test');
    expect(wf!.name).toBe('New Name');
    expect(wf!.rawJson).toBe('{"b":2}');
  });

  it('updates ID along with name', () => {
    service.create({ id: 'old', name: 'Old Name', rawJson: '{}' });
    service.update('old', { id: 'new', name: 'New Name' });

    expect(service.getById('old')).toBeNull();
    const wf = service.getById('new');
    expect(wf!.name).toBe('New Name');
  });

  it('cascades ID update to task_logs', () => {
    service.create({ id: 'old-id', name: 'WF', rawJson: '{}' });
    // 直接插入 task_log 记录（模拟执行过的任务）
    const now = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO task_logs (id, workflow_id, workflow_name, alias_values, comfyui_url, status, created_at)
      VALUES ('log-1', 'old-id', 'WF', '{}', 'http://localhost:8188', 'completed', '${now}')
    `);

    service.update('old-id', { id: 'new-id' });

    // 验证 task_log 的 workflow_id 已级联更新
    const rows = sqlite.prepare('SELECT workflow_id FROM task_logs WHERE id = ?').all('log-1') as { workflow_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].workflow_id).toBe('new-id');
  });
});
