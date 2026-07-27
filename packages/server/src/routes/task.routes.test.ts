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
  let appUnreachable: express.Express;
  let taskId: string;
  let taskIdNoOutput: string;
  let unreachableTaskId: string;

  beforeAll(() => {
    function buildApp(baseUrl: string | null) {
      const sqlite = new Database(':memory:');
      sqlite.exec(`
        CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      const db = drizzle(sqlite, { schema });
      const svc = new TaskService(db);
      const s = new SettingsService(db);
      if (baseUrl) s.set('comfyui_base_url', baseUrl);
      s.set('auth_enabled', '0');
      s.set('output_download_mode', 'proxy');

      db.insert(schema.workflows).values({
        id: 'wf1', name: 'test', rawJson: '{}',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }).run();

      const task = svc.create({
        workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
        comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
        comfyuiResponse: null, promptId: 'prompt-abc',
      });
      svc.updateStatus(task.id, { status: 'completed' });
      svc.updateOutputFiles(task.id, [
        { filename: 'output.png', subfolder: '', type: 'output', nodeId: '9', fileType: 'image' },
      ]);

      const noOutputTask = svc.create({
        workflowId: 'wf1', workflowName: 'test', aliasValues: '{}',
        comfyuiUrl: 'http://localhost:8188', comfyuiRequestBody: null,
        comfyuiResponse: null, promptId: null,
      });

      const routeApp = express();
      routeApp.use(express.json());
      routeApp.use('/api/tasks', createTaskRoutes(db));
      return { app: routeApp, taskId: task.id, taskIdNoOutput: noOutputTask.id };
    }

    const main = buildApp('http://localhost:8188');
    app = main.app;
    taskId = main.taskId;
    taskIdNoOutput = main.taskIdNoOutput;

    const unreachable = buildApp(null);
    appUnreachable = unreachable.app;
    unreachableTaskId = unreachable.taskId;
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
