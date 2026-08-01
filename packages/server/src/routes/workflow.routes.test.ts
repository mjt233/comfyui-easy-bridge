import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import JSZip from 'jszip';
import * as schema from '../models/schema';
import { createWorkflowRoutes } from './workflow.routes';
import { createAuthRoutes } from './auth.routes';
import { createSettingsRoutes } from './settings.routes';
import { createTaskRoutes } from './task.routes';

// 使用临时目录作为 DATA_DIR，避免附件写入真实数据目录
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-routes-'));
process.env.DATA_DIR = tempDataDir;

describe('Workflow API', () => {
  let app: express.Express;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
      CREATE TABLE workflow_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        mimetype TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const db = drizzle(sqlite, { schema });

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));
    app.use('/api/workflows', createWorkflowRoutes(db));
    app.use('/api/settings', createSettingsRoutes(db));
    app.use('/api/tasks', createTaskRoutes(db));
  });

  afterAll(() => {
    // 清理临时数据目录
    fs.rmSync(tempDataDir, { recursive: true, force: true });
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

  it('PUT /api/workflows/:id with new ID updates workflow ID', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'old-id', name: 'Test', rawJson: '{}' });

    const res = await supertest(app)
      .put('/api/workflows/old-id')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'new-id', name: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('new-id');
    expect(res.body.name).toBe('Updated');
  });

  it('PUT /api/workflows/:id with conflicting ID returns 409', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'wf-a', name: 'A', rawJson: '{}' });

    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'wf-b', name: 'B', rawJson: '{}' });

    const res = await supertest(app)
      .put('/api/workflows/wf-a')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'wf-b' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('id_conflict');
  });

  it('POST /params with only defaultValue succeeds', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'wf-default', name: 'D', rawJson: '{}' });

    const res = await supertest(app)
      .post('/api/workflows/wf-default/params')
      .set('Authorization', `Bearer ${token}`)
      .send({ nodeId: '1', fieldName: 'value', defaultValue: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.alias).toBeNull();
    expect(res.body.defaultValue).toBe('hello');
    expect(res.body.paramType).toBe('text');
  });

  it('POST /params without alias and defaultValue returns 400', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'wf-empty-param', name: 'E', rawJson: '{}' });

    const res = await supertest(app)
      .post('/api/workflows/wf-empty-param/params')
      .set('Authorization', `Bearer ${token}`)
      .send({ nodeId: '1', fieldName: 'value' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('missing_parameter');
  });

  it('POST /api/workflows/:id/attachments uploads attachment', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'wf-att', name: 'Att', rawJson: '{}' });

    const res = await supertest(app)
      .post('/api/workflows/wf-att/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('attachment content'), '说明.txt');

    expect(res.status).toBe(201);
    expect(res.body.filename).toBe('说明.txt');
    expect(res.body.size).toBe('attachment content'.length);
    expect(res.body.workflowId).toBe('wf-att');
  });

  it('GET /api/workflows/:id/attachments lists attachments', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const res = await supertest(app)
      .get('/api/workflows/wf-att/attachments')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].filename).toBe('说明.txt');
  });

  it('GET /api/workflows/:id/attachments/:id/download downloads attachment', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const listRes = await supertest(app)
      .get('/api/workflows/wf-att/attachments')
      .set('Authorization', `Bearer ${token}`);
    const attachmentId = listRes.body[0].id as number;

    const res = await supertest(app)
      .get(`/api/workflows/wf-att/attachments/${attachmentId}/download`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Content-Disposition 应包含原始文件名（RFC 5987 编码）
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('filename');
    // 附件内容为 text/plain，supertest 解析到 res.text
    expect(res.text).toBe('attachment content');
  });

  it('DELETE /api/workflows/:id/attachments/:id deletes attachment', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const listRes = await supertest(app)
      .get('/api/workflows/wf-att/attachments')
      .set('Authorization', `Bearer ${token}`);
    const attachmentId = listRes.body[0].id as number;

    const res = await supertest(app)
      .delete(`/api/workflows/wf-att/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);

    const after = await supertest(app)
      .get('/api/workflows/wf-att/attachments')
      .set('Authorization', `Bearer ${token}`);
    expect(after.body).toHaveLength(0);
  });

  it('POST /api/workflows/export returns a ZIP with selected workflows', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const res = await supertest(app)
      .post('/api/workflows/export')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['wf-att'] })
      // 二进制响应：自定义解析得到原始 Buffer
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');

    // 解析 ZIP 校验 manifest
    const zip = await JSZip.loadAsync(res.body as Buffer);
    const manifestFile = zip.file('manifest.json');
    expect(manifestFile).toBeDefined();
    const manifest = JSON.parse(await manifestFile!.async('string')) as {
      workflows: Array<{ id: string }>;
    };
    expect(manifest.workflows).toHaveLength(1);
    expect(manifest.workflows[0].id).toBe('wf-att');
  });

  it('POST /api/workflows/import imports workflows from ZIP', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    // 构造一个含附件的工作流 ZIP
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      workflows: [{
        id: 'imported-flow',
        name: 'Imported',
        rawJson: '{}',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        params: [{ nodeId: '1', fieldName: 'v', alias: 'alias1', label: null, paramType: 'text', defaultValue: null }],
        attachments: [{ filename: 'data.bin', storedName: 'abc.bin', size: 4, mimetype: 'application/octet-stream' }],
      }],
    }));
    zip.file('attachments/abc.bin', Buffer.from('DATA'));
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const res = await supertest(app)
      .post('/api/workflows/import')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', zipBuffer, 'export.zip');

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.renamed).toHaveLength(0);

    // 导入后可通过 API 查询到工作流与附件
    const detail = await supertest(app)
      .get('/api/workflows/imported-flow')
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.params).toHaveLength(1);

    const atts = await supertest(app)
      .get('/api/workflows/imported-flow/attachments')
      .set('Authorization', `Bearer ${token}`);
    expect(atts.body).toHaveLength(1);
    expect(atts.body[0].filename).toBe('data.bin');
  });

  it('POST /api/workflows/import with invalid ZIP returns 400', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const zip = new JSZip();
    zip.file('random.txt', 'not a manifest');
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const res = await supertest(app)
      .post('/api/workflows/import')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', zipBuffer, 'bad.zip');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('missing_parameter');
  });

  it('GET /api/workflows/build-api.d.ts returns d.ts text', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const res = await supertest(app)
      .get('/api/workflows/build-api.d.ts')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('declare interface BuildContext');
  });

  it('PUT /api/workflows/:id/build-script saves script and enabled flag', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'build-flow', name: 'Build', rawJson: JSON.stringify({ '1': { inputs: { a: 1 }, class_type: 'Start' } }) });

    const res = await supertest(app)
      .put('/api/workflows/build-flow/build-script')
      .set('Authorization', `Bearer ${token}`)
      .send({ script: 'export default function build(ctx: any) { return ctx.workflow; }', enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.buildScript).toContain('export default');
    expect(res.body.buildScriptEnabled).toBe(true);

    const detail = await supertest(app)
      .get('/api/workflows/build-flow')
      .set('Authorization', `Bearer ${token}`);
    expect(detail.body.buildScriptEnabled).toBe(true);
  });

  it('POST /api/workflows/:id/build/simulate returns built json', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'sim-flow', name: 'Sim', rawJson: JSON.stringify({ '1': { inputs: { seed: 0 }, class_type: 'KSampler' } }) });

    const res = await supertest(app)
      .post('/api/workflows/sim-flow/build/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        script: `export default function build(ctx: any) { ctx.setInput('1', 'seed', 42); return ctx.workflow; }`,
        params: {},
      });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.json as string) as { '1': { inputs: { seed: number } } };
    expect(parsed['1'].inputs.seed).toBe(42);
  });

  it('POST simulate returns error for failing script', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'sim-bad', name: 'Bad', rawJson: '{}' });

    const res = await supertest(app)
      .post('/api/workflows/sim-bad/build/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({ script: `export default function build() { throw new Error('boom'); }`, params: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('build_script_error');
    expect(res.body.error).toContain('boom');
  });

  it('execute runs enabled build script before submitting', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    const rawJson = JSON.stringify({ '1': { inputs: { seed: 0 }, class_type: 'KSampler' } });
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'exec-flow', name: 'Exec', rawJson });
    await supertest(app)
      .put('/api/workflows/exec-flow/build-script')
      .set('Authorization', `Bearer ${token}`)
      .send({ script: `export default function build(ctx: any) { ctx.setInput('1', 'seed', 777); return ctx.workflow; }`, enabled: true });
    // 设置 ComfyUI base URL
    await supertest(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'comfyui_base_url', value: 'http://localhost:9999' });

    const res = await supertest(app).post('/api/workflows/exec-flow/execute').send({});
    // 提交会失败（ComfyUI 不可达），但任务日志中应含脚本修改后的 seed
    expect(res.status).toBe(200);
    expect(['failed', 'queued']).toContain(res.body.status);
    const tasks = await supertest(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);
    const task = (tasks.body as Array<{ comfyuiRequestBody: string | null; status: string }>)
      .find((t) => (t.comfyuiRequestBody ?? '').includes('777'));
    expect(task).toBeTruthy();
  });

  it('execute with failing build script marks task failed without submitting', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'exec-bad', name: 'ExecBad', rawJson: '{}' });
    await supertest(app)
      .put('/api/workflows/exec-bad/build-script')
      .set('Authorization', `Bearer ${token}`)
      .send({ script: `export default function build() { throw new Error('broken'); }`, enabled: true });
    await supertest(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'comfyui_base_url', value: 'http://localhost:9999' });

    const res = await supertest(app).post('/api/workflows/exec-bad/execute').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    const tasks = await supertest(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);
    const task = (tasks.body as Array<{ workflowId: string; status: string; errorMessage: string }>)
      .find((t) => t.workflowId === 'exec-bad');
    expect(task?.status).toBe('failed');
    expect(task?.errorMessage).toContain('Dynamic build failed');
    expect(task?.errorMessage).toContain('broken');
  });
});
