import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createWorkflowRoutes } from './workflow.routes';
import { createAuthRoutes } from './auth.routes';
import { createSettingsRoutes } from './settings.routes';

describe('Workflow API', () => {
  let app: express.Express;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_params (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, node_id TEXT NOT NULL, field_name TEXT NOT NULL, alias TEXT NOT NULL UNIQUE, label TEXT, param_type TEXT NOT NULL DEFAULT 'text');
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const db = drizzle(sqlite, { schema });

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));
    app.use('/api/workflows', createWorkflowRoutes(db));
    app.use('/api/settings', createSettingsRoutes(db));
  });

  it('POST /api/workflows with auth creates a workflow', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const res = await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'test-flow', name: 'Test', rawJson: '{}' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('test-flow');
  });

  it('GET /api/workflows returns list', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const res = await supertest(app)
      .get('/api/workflows')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/workflows/:id/execute without auth returns 400 (no base URL)', async () => {
    const res = await supertest(app)
      .post('/api/workflows/test-flow/execute')
      .send({ img_desc: 'cat' });
    expect(res.status).toBe(400);
  });

  it('GET /api/workflows without auth returns 401', async () => {
    const res = await supertest(app)
      .get('/api/workflows');
    expect(res.status).toBe(401);
  });

  it('GET /api/workflows/:id returns workflow with params', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'wf-detail', name: 'Detail Test', rawJson: JSON.stringify({ '1': { 'inputs': { 'v': 'x' }, 'class_type': 'T', '_meta': { 'title': 'T' } } }) });

    const res = await supertest(app)
      .get('/api/workflows/wf-detail')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.params).toBeDefined();
  });

  it('PUT /api/workflows/:id updates workflow', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const res = await supertest(app)
      .put('/api/workflows/test-flow')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
  });

  it('DELETE /api/workflows/:id deletes workflow', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const res = await supertest(app)
      .delete('/api/workflows/test-flow')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
  });

  it('PUT /api/settings with auth updates setting', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const res = await supertest(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'comfyui_base_url', value: 'http://localhost:8188' });
    expect(res.status).toBe(200);
  });
});
