import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createTaskRoutes } from './task.routes';
import { SettingsService } from '../services/settings.service';
import { TaskService } from '../services/task.service';

describe('Task output files endpoints', () => {
  let app: express.Express;
  let taskId: string;
  let taskService: TaskService;
  let settingsService: SettingsService;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const db = drizzle(sqlite, { schema });
    taskService = new TaskService(db);
    settingsService = new SettingsService(db);
    settingsService.set('comfyui_base_url', 'http://localhost:8188');
    settingsService.set('output_download_mode', 'proxy');
    settingsService.set('auth_enabled', '0');

    db.insert(schema.workflows).values({
      id: 'wf1', name: 'test', rawJson: '{}',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();

    const task = taskService.create({
      workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: 'prompt-abc',
    });
    taskId = task.id;

    taskService.updateStatus(taskId, { status: 'completed' });
    taskService.updateOutputFiles(taskId, [
      { filename: 'output.png', subfolder: '', type: 'output', nodeId: '9', fileType: 'image' },
    ]);

    app = express();
    app.use(express.json());
    app.use('/api/tasks', createTaskRoutes(db));
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
    const sqlite2 = new Database(':memory:');
    sqlite2.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const db2 = drizzle(sqlite2, { schema });
    const svc = new TaskService(db2);
    new SettingsService(db2).set('auth_enabled', '0');
    db2.insert(schema.workflows).values({
      id: 'wf2', name: 'test', rawJson: '{}',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
    const t = svc.create({
      workflowId: 'wf2', workflowName: 'test', aliasValues: '{}',
      comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
      comfyuiResponse: null, promptId: null,
    });

    const app2 = express();
    app2.use(express.json());
    app2.use('/api/tasks', createTaskRoutes(db2));

    const res = await supertest(app2)
      .get(`/api/tasks/${t.id}/output-files`);
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
  });
});
