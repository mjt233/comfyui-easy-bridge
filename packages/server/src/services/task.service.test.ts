import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from './task.service';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
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
