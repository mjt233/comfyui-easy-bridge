import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from './task.service';

describe('TaskService.updateOutputFiles', () => {
  let service: TaskService;
  let taskId: string;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
    `);
    const db = drizzle(sqlite, { schema });
    service = new TaskService(db);

    db.insert(schema.workflows).values({
      id: 'wf1', name: 'test', rawJson: '{}', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();

    const task = service.create({
      workflowId: 'wf1',
      workflowName: 'test',
      aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188',
      comfyuiRequestBody: null,
      comfyuiResponse: null,
      promptId: 'prompt-123',
    });
    taskId = task.id;
  });

  it('stores and retrieves output files', () => {
    const files: OutputFile[] = [
      { filename: 'output.png', subfolder: '', type: 'output', nodeId: '9', fileType: 'image' },
    ];
    service.updateOutputFiles(taskId, files);
    const task = service.getById(taskId);
    expect(task).not.toBeNull();
    expect(JSON.parse(task!.outputFiles!)).toEqual(files);
  });

  it('replaces previous output files on second call', () => {
    const files: OutputFile[] = [
      { filename: 'new.png', subfolder: '', type: 'output', nodeId: '10', fileType: 'image' },
    ];
    service.updateOutputFiles(taskId, files);
    const task = service.getById(taskId);
    expect(JSON.parse(task!.outputFiles!)).toEqual(files);
  });

  it('returns null outputFiles for task with no output files', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
    `);
    const db = drizzle(sqlite, { schema });
    const svc = new TaskService(db);
    db.insert(schema.workflows).values({
      id: 'wf2', name: 'test', rawJson: '{}', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
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
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
    `);
    const db = drizzle(sqlite, { schema });
    const svc = new TaskService(db);
    db.insert(schema.workflows).values({
      id: 'wf3', name: 'test', rawJson: '{}', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
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
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
    `);
    const db = drizzle(sqlite, { schema });
    const svc = new TaskService(db);
    expect(svc.getByPromptId('nonexistent')).toBeNull();
  });
});
