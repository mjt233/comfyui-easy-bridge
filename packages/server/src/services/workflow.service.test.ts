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
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_params (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, node_id TEXT NOT NULL, field_name TEXT NOT NULL, alias TEXT NOT NULL UNIQUE, label TEXT);
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

  it('throws on duplicate alias', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'dup' });
    expect(() => service.addParam({ workflowId: 'wf', nodeId: '2', fieldName: 'v', alias: 'dup' })).toThrow();
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
});
