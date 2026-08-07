import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import JSZip from 'jszip';
import * as schema from '../models/schema';
import { createWorkflowRoutes } from './workflow.routes';
import { createAuthRoutes } from './auth.routes';
import { createSettingsRoutes } from './settings.routes';
import { createTaskRoutes } from './task.routes';
import { nodeInfoServiceConfig, clearNodeInfoCache } from '../services/node-info.service';
import { SettingsService } from '../services/settings.service';
import { ProviderService } from '../services/providers/provider.service';

// 使用临时目录作为 DATA_DIR，避免附件写入真实数据目录
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-routes-'));
process.env.DATA_DIR = tempDataDir;

describe('Workflow API', () => {
  let app: express.Express;
  let db: BetterSQLite3Database<typeof schema>;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, workflow_name TEXT NOT NULL, provider_id TEXT, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    db = drizzle(sqlite, { schema });

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));
    app.use('/api/workflows', createWorkflowRoutes(db));
    app.use('/api/settings', createSettingsRoutes(db));
    app.use('/api/tasks', createTaskRoutes(db));
  });

  beforeEach(() => {
    clearNodeInfoCache();
    // 清空 comfyui_base_url 与 default_provider_id，保证静态 d.ts 用例不受测试顺序污染
    new SettingsService(db).set('comfyui_base_url', '');
    new SettingsService(db).set('default_provider_id', '');
    // 清空提供商，避免 node-info/build-api 用例互相污染
    db.delete(schema.providers).run();
    // 恢复默认 fetch 实现（部分用例会覆盖它）
    nodeInfoServiceConfig.fetchImpl = async (url: string, init?: { signal?: AbortSignal }) => {
      const res = await fetch(url, init);
      return res;
    };
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

  it('POST /api/workflows/:id/execute without auth returns 400 (no provider)', async () => {
    const res = await supertest(app)
      .post('/api/workflows/test-flow/execute')
      .send({ img_desc: 'cat' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('provider_not_configured');
  });

  it('GET /api/workflows without auth returns 401', async () => {
    const res = await supertest(app)
      .get('/api/workflows');
    expect(res.status).toBe(401);
  });
  it('POST /api/workflows/:id/duplicate clones workflow with auth', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    // 先创建源工作流
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'dup-src', name: '源', rawJson: '{"1":{"inputs":{}}}' });

    const res = await supertest(app)
      .post('/api/workflows/dup-src/duplicate')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe('dup-src');
    expect(res.body.name).toBe('源 (copy)');

    // 复制出的工作流可通过 GET 查询
    const getRes = await supertest(app)
      .get(`/api/workflows/${res.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.params).toHaveLength(0);
  });

  it('POST /api/workflows/:id/duplicate without auth returns 401', async () => {
    const res = await supertest(app)
      .post('/api/workflows/dup-src/duplicate');
    expect(res.status).toBe(401);
  });

  it('POST /api/workflows/:id/duplicate with unknown id returns 404', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const res = await supertest(app)
      .post('/api/workflows/nonexistent/duplicate')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
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

  it('GET /api/workflows/build-api.d.ts returns dynamic dts with node classes when object_info available', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    // 创建 comfyui 提供商并设为默认，注入假 object_info
    const provider = new ProviderService(db).create({
      name: 'local comfy',
      type: 'comfyui',
      config: { baseUrl: 'http://comfy:8188' },
    });
    new ProviderService(db).setDefault(provider.id);
    nodeInfoServiceConfig.fetchImpl = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          KSampler: {
            input: { required: { seed: ['INT', {}] } },
            display_name: 'KSampler',
            output: ['LATENT'],
          },
        });
      },
    }) as unknown as Response;

    const res = await supertest(app)
      .get('/api/workflows/build-api.d.ts')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('declare type ComfyClassType = keyof ComfyNodeInputs;');
    expect(res.text).toContain('"KSampler": {');
    expect(res.text).toContain('addNode<K extends ComfyClassType>');
  });

  it('GET /api/workflows/build-api.d.ts falls back to static dts when no base url', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    // 确保无 comfyui 提供商（beforeEach 已清空，此处显式再清一次）
    db.delete(schema.providers).run();
    new SettingsService(db).set('default_provider_id', '');

    const res = await supertest(app)
      .get('/api/workflows/build-api.d.ts')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('declare interface BuildContext');
    expect(res.text).not.toContain('ComfyClassType');
  });

  it('GET /api/workflows/node-info returns sorted node reference list', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    // 创建 comfyui 提供商并设为默认，注入假 object_info
    const provider = new ProviderService(db).create({
      name: 'local comfy',
      type: 'comfyui',
      config: { baseUrl: 'http://comfy:8188' },
    });
    new ProviderService(db).setDefault(provider.id);
    nodeInfoServiceConfig.fetchImpl = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          SaveVideo: {
            input: { required: { format: ['COMBO', { options: ['auto', 'mp4'] }] } },
            display_name: 'Save Video',
            category: 'image',
            output: ['VIDEO'],
            output_name: ['video'],
          },
          KSampler: {
            input: {
              required: { seed: ['INT', {}] },
              optional: { denoise: ['FLOAT', {}] },
            },
            display_name: 'KSampler',
            category: 'sampling',
            output: ['LATENT'],
            output_name: ['LATENT'],
          },
        });
      },
    }) as unknown as Response;

    const res = await supertest(app)
      .get('/api/workflows/node-info')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // 按类名字母序排序
    expect(res.body.nodes.map((n: { name: string }) => n.name)).toEqual(['KSampler', 'SaveVideo']);
    const ks = res.body.nodes[0] as {
      display_name: string;
      category: string | null;
      required_inputs: Array<{ name: string; type: string; options?: string[] }>;
      optional_inputs: Array<{ name: string; type: string; options?: string[] }>;
      outputs: string[];
    };
    expect(ks.display_name).toBe('KSampler');
    expect(ks.category).toBe('sampling');
    expect(ks.required_inputs).toEqual([{ name: 'seed', type: 'INT' }]);
    expect(ks.optional_inputs).toEqual([{ name: 'denoise', type: 'FLOAT' }]);
    expect(ks.outputs).toEqual(['LATENT']);
    const saveVideo = res.body.nodes[1] as { required_inputs: Array<{ name: string; type: string; options?: string[] }> };
    expect(saveVideo.required_inputs).toEqual([{ name: 'format', type: 'COMBO', options: ['auto', 'mp4'] }]);
  });

  it('GET /api/workflows/node-info without auth returns 401', async () => {
    const res = await supertest(app).get('/api/workflows/node-info');
    expect(res.status).toBe(401);
  });

  it('GET /api/workflows/node-info returns 503 when no base url', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    // 确保无 comfyui 提供商
    db.delete(schema.providers).run();
    new SettingsService(db).set('default_provider_id', '');

    const res = await supertest(app)
      .get('/api/workflows/node-info')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('comfyui_unreachable');
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
    // 响应应包含 params 数组（无参数工作流为空数组），与 getById / WorkflowDetail 结构一致
    expect(Array.isArray(res.body.params)).toBe(true);

    const detail = await supertest(app)
      .get('/api/workflows/build-flow')
      .set('Authorization', `Bearer ${token}`);
    expect(detail.body.buildScriptEnabled).toBe(true);
  });

  it('PUT /api/workflows/:id/declared-params saves declarations', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'dp-flow', name: 'DP', rawJson: '{}' });

    const res = await supertest(app)
      .put('/api/workflows/dp-flow/declared-params')
      .set('Authorization', `Bearer ${token}`)
      .send({
        params: [
          { alias: 'input_image', label: '输入图片', paramType: 'image' },
          { alias: 'steps', label: '步数', paramType: 'number', defaultValue: '20' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.declaredParams).toEqual([
      { alias: 'input_image', label: '输入图片', paramType: 'image', defaultValue: null },
      { alias: 'steps', label: '步数', paramType: 'number', defaultValue: '20' },
    ]);
    expect(Array.isArray(res.body.params)).toBe(true);

    // getById 应返回同一份声明
    const detail = await supertest(app)
      .get('/api/workflows/dp-flow')
      .set('Authorization', `Bearer ${token}`);
    expect(detail.body.declaredParams).toEqual(res.body.declaredParams);
  });

  it('PUT declared-params validates input', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'dp-validate', name: 'DP', rawJson: '{}' });

    // 非数组
    const nonArray = await supertest(app)
      .put('/api/workflows/dp-validate/declared-params')
      .set('Authorization', `Bearer ${token}`)
      .send({ params: { alias: 'a' } });
    expect(nonArray.status).toBe(400);
    expect(nonArray.body.code).toBe('missing_parameter');

    // 空 alias
    const emptyAlias = await supertest(app)
      .put('/api/workflows/dp-validate/declared-params')
      .set('Authorization', `Bearer ${token}`)
      .send({ params: [{ alias: '  ' }] });
    expect(emptyAlias.status).toBe(400);
    expect(emptyAlias.body.code).toBe('missing_parameter');

    // 重复 alias
    const dup = await supertest(app)
      .put('/api/workflows/dp-validate/declared-params')
      .set('Authorization', `Bearer ${token}`)
      .send({ params: [{ alias: 'a' }, { alias: 'a' }] });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('alias_conflict');
  });

  it('PUT declared-params returns 404 for missing workflow and 401 without auth', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const missing = await supertest(app)
      .put('/api/workflows/no-such/declared-params')
      .set('Authorization', `Bearer ${token}`)
      .send({ params: [] });
    expect(missing.status).toBe(404);

    const noAuth = await supertest(app)
      .put('/api/workflows/no-such/declared-params')
      .send({ params: [] });
    expect(noAuth.status).toBe(401);
  });

  it('POST /api/workflows/:id/build/simulate returns built json', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'sim-flow', name: 'Sim', rawJson: JSON.stringify({ '1': { inputs: { seed: 0 }, class_type: 'KSampler' } }) });
    // simulate 需先配置执行提供商（媒体上传与 URL 解析均来自提供商）
    const provider = new ProviderService(db).create({
      name: 'Test Comfy',
      type: 'comfyui',
      config: { baseUrl: 'http://comfy:8188' },
    });
    new ProviderService(db).setDefault(provider.id);

    const res = await supertest(app)
      .post('/api/workflows/sim-flow/build/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        script: 'export default function build(ctx: any) { ctx.setInput(\'1\', \'seed\', 42); return { workflow: ctx.workflow, params: [] }; }',
        params: {},
      });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.json as string) as { '1': { inputs: { seed: number } } };
    expect(parsed['1'].inputs.seed).toBe(42);
    // simulate 返回 { json, params }
    expect(Array.isArray(res.body.params)).toBe(true);
  });

  it('POST simulate returns error for failing script', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'sim-bad', name: 'Bad', rawJson: '{}' });
    // simulate 需先配置执行提供商（提供商解析在脚本执行之前）
    const provider = new ProviderService(db).create({
      name: 'Test Comfy',
      type: 'comfyui',
      config: { baseUrl: 'http://comfy:8188' },
    });
    new ProviderService(db).setDefault(provider.id);

    const res = await supertest(app)
      .post('/api/workflows/sim-bad/build/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({ script: 'export default function build() { throw new Error(\'boom\'); }', params: {} });
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
      .send({ script: 'export default function build(ctx: any) { ctx.setInput(\'1\', \'seed\', 777); return { workflow: ctx.workflow, params: [] }; }', enabled: true });
    // 创建 comfyui 提供商并设为默认（execute 通过 ProviderService 解析）
    const provider = new ProviderService(db).create({
      name: 'Test Comfy',
      type: 'comfyui',
      config: { baseUrl: 'http://comfy:8188' },
    });
    new ProviderService(db).setDefault(provider.id);

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
      .send({ script: 'export default function build() { throw new Error(\'broken\'); }', enabled: true });
    // 创建 comfyui 提供商并设为默认（execute 通过 ProviderService 解析）
    const provider = new ProviderService(db).create({
      name: 'Test Comfy',
      type: 'comfyui',
      config: { baseUrl: 'http://comfy:8188' },
    });
    new ProviderService(db).setDefault(provider.id);

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

  it('POST execute returns provider_not_configured when no provider exists', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'exec-no-provider', name: 'NoProvider', rawJson: '{}' });

    // 无任何提供商实例（beforeEach 已清空），执行应返回 provider_not_configured
    const res = await supertest(app)
      .post('/api/workflows/exec-no-provider/execute')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('provider_not_configured');
  });

  it('execute records original request form with file metadata', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    const rawJson = JSON.stringify({ '1': { inputs: { image: '' }, class_type: 'LoadImage' } });
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'exec-form', name: 'ExecForm', rawJson });
    // 创建 comfyui 提供商并设为默认（execute 通过 ProviderService 解析）
    const provider = new ProviderService(db).create({
      name: 'Test Comfy',
      type: 'comfyui',
      config: { baseUrl: 'http://comfy:8188' },
    });
    new ProviderService(db).setDefault(provider.id);

    const res = await supertest(app)
      .post('/api/workflows/exec-form/execute')
      .field('params', JSON.stringify({ width: 1280, prompt: 'hello' }))
      .attach('frame_0', Buffer.from('fake-image-bytes'), 'frame0.png');
    // 提交会失败（ComfyUI 不可达），但任务日志应记录用户原始请求表单
    expect(res.status).toBe(200);
    expect(['failed', 'queued']).toContain(res.body.status);

    const tasks = await supertest(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);
    const task = (tasks.body as Array<{ workflowId: string; originalForm: string | null }>)
      .find((t) => t.workflowId === 'exec-form');
    expect(task).toBeTruthy();
    const form = JSON.parse(task!.originalForm as string) as {
      params: Record<string, unknown>;
      files: Array<{ alias: string; filename: string; size: number }>;
    };
    // 原始表单保留用户提交的非文件参数
    expect(form.params.width).toBe(1280);
    expect(form.params.prompt).toBe('hello');
    // 上传文件记录表单 key / 原始文件名 / 大小
    expect(form.files).toHaveLength(1);
    expect(form.files[0].alias).toBe('frame_0');
    expect(form.files[0].filename).toBe('frame0.png');
    expect(form.files[0].size).toBe(Buffer.byteLength('fake-image-bytes'));
  });

  it('simulate with multipart media upload returns json and params', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'sim-multi', name: 'SimMulti', rawJson: JSON.stringify({ '1': { inputs: { image: '' }, class_type: 'LoadImage' } }) });
    // 创建 comfyui 提供商并设为默认（simulate 通过 ProviderService 解析）
    const provider = new ProviderService(db).create({
      name: 'Test Comfy',
      type: 'comfyui',
      config: { baseUrl: 'http://comfy:8188' },
    });
    new ProviderService(db).setDefault(provider.id);

    // 模拟 ComfyUI 上传成功（返回确定文件名），避免依赖网络可达性
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ name: 'uploaded-ref.png' }),
    })) as unknown as typeof fetch;
    try {
      const res = await supertest(app)
        .post('/api/workflows/sim-multi/build/simulate')
        .set('Authorization', `Bearer ${token}`)
        .field('script', `
          export default function build(ctx: any) {
            return {
              workflow: ctx.workflow,
              params: [{ nodeId: '1', fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: 0 }],
            };
          }
        `)
        .field('params', JSON.stringify({}))
        .attach('ref_images', Buffer.from('fakeimage'), 'photo.png');
      // 脚本声明配置生效：simulate 返回 { json, params }
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.params)).toBe(true);
      expect(res.body.params[0]).toMatchObject({ nodeId: '1', alias: 'ref_images', paramType: 'image' });
      // 上传的文件名已注入到脚本声明的媒体参数对应节点
      const built = JSON.parse(res.body.json as string) as { '1': { inputs: { image: string } } };
      expect(built['1'].inputs.image).toBe('uploaded-ref.png');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
