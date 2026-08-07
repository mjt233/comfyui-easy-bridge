import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from '../models/migrations/runner';
import * as schema from '../models/schema';
import { createAuthRoutes } from './auth.routes';
import { createTagsRoutes } from './tags.routes';

// 注：认证中间件默认密码 0d000721（见 AGENTS.md）；此处按 workflow.routes.test.ts 现有做法构造已登录请求
describe('标签管理 API', () => {
  let app: express.Express;
  let db: BetterSQLite3Database<typeof schema>;
  let token: string;

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    runMigrations(sqlite);
    db = drizzle(sqlite, { schema });
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));
    app.use('/api/tags', createTagsRoutes(db));
  });

  beforeAll(async () => {
    // 登录获取 token（密码 0d000721）
    const sqlite = new Database(':memory:');
    runMigrations(sqlite);
    const authDb = drizzle(sqlite, { schema });
    const authApp = express();
    authApp.use(express.json());
    authApp.use('/api/auth', createAuthRoutes(authDb));
    const res = await request(authApp).post('/api/auth/login').send({ password: '0d000721' });
    token = res.body.token;
  });

  it('GET /api/tags 返回标签树', async () => {
    const res = await request(app).get('/api/tags').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const tree = res.body as Array<{ id: string; name: string; children: Array<{ id: string; name: string }> }>;
    const i2v = tree.find((t) => t.id === 'image-to-video');
    expect(i2v?.children.map((c) => c.id)).toContain('reference');
    expect(i2v?.children.map((c) => c.id)).toContain('first-frame');
  });

  it('POST /api/tags 新建自定义标签', async () => {
    const res = await request(app)
      .post('/api/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '自定义', parentId: null, metadataDef: [] });
    expect(res.status).toBe(201);
    expect(res.body.isPreset).toBe(0);
  });

  it('POST /api/tags 同层级重名返回 409 tag_conflict', async () => {
    await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`).send({ name: '重复' });
    const res = await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`).send({ name: '重复' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('tag_conflict');
  });

  it('PUT /api/tags/:id 编辑自定义标签', async () => {
    const created = await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`).send({ name: '旧名' });
    const res = await request(app)
      .put(`/api/tags/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '新名' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('新名');
  });

  it('PUT /api/tags/:id 编辑预设标签返回 403', async () => {
    const res = await request(app)
      .put('/api/tags/text-to-image')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '改名' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('tag_preset_readonly');
  });

  it('DELETE /api/tags/:id 删除自定义标签', async () => {
    const created = await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`).send({ name: '待删' });
    const res = await request(app).delete(`/api/tags/${created.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
  });

  it('DELETE /api/tags/:id 删除预设标签返回 403', async () => {
    const res = await request(app).delete('/api/tags/text-to-image').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('PUT /api/tags/:id 不存在的标签返回 404 tag_not_found', async () => {
    const res = await request(app)
      .put('/api/tags/nonexistent')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('tag_not_found');
  });

  it('DELETE /api/tags/:id 不存在的标签返回 404 tag_not_found', async () => {
    const res = await request(app)
      .delete('/api/tags/nonexistent')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('tag_not_found');
  });
});
