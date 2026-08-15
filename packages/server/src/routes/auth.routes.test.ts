import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createAuthRoutes } from './auth.routes';
import { SettingsService } from '../services/settings.service';
import { errorHandler } from '../middleware/errorHandler';

describe('POST /api/auth/login', () => {
  let app: express.Express;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const db = drizzle(sqlite, { schema });

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));
  });

  it('returns token with valid password', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('returns 401 with invalid password', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when password is missing', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/status', () => {
  it('returns authEnabled: true by default', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const db = drizzle(sqlite, { schema });

    const app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));

    const res = await supertest(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authEnabled: true });
  });

  it('returns authEnabled: false when setting is 0', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const db = drizzle(sqlite, { schema });

    const settings = new SettingsService(db);
    settings.set('auth_enabled', '0');

    const app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));

    const res = await supertest(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authEnabled: false });
  });
});

describe('POST /api/auth/change-password', () => {
  /**
   * 构造带 errorHandler 的独立测试应用。
   * 每个用例使用独立的内存库，避免改密后密码状态互相影响。
   */
  function createApp(): express.Express {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const db = drizzle(sqlite, { schema });

    const app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /** 用默认密码登录并返回 token */
  async function loginToken(app: express.Express): Promise<string> {
    const res = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    return res.body.token as string;
  }

  it('returns 401 without token', async () => {
    const app = createApp();
    const res = await supertest(app)
      .post('/api/auth/change-password')
      .send({ oldPassword: '0d000721', newPassword: 'newpass123' });
    expect(res.status).toBe(401);
  });

  it('changes password with valid token and correct old password', async () => {
    const app = createApp();
    const token = await loginToken(app);

    const res = await supertest(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: '0d000721', newPassword: 'newpass123' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // 旧密码登录失败，新密码登录成功
    const oldLogin = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await supertest(app).post('/api/auth/login').send({ password: 'newpass123' });
    expect(newLogin.status).toBe(200);
  });

  it('revokes the old token after password change', async () => {
    const app = createApp();
    const token = await loginToken(app);

    const res = await supertest(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: '0d000721', newPassword: 'newpass123' });
    expect(res.status).toBe(200);

    // 修改前的 token 因密码指纹变化立即失效
    const revoked = await supertest(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'newpass123', newPassword: 'another123' });
    expect(revoked.status).toBe(401);
  });

  it('returns 401 with wrong old password', async () => {
    const app = createApp();
    const token = await loginToken(app);

    const res = await supertest(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'wrong', newPassword: 'newpass123' });
    expect(res.status).toBe(401);
  });

  it('returns 400 with too-short new password', async () => {
    const app = createApp();
    const token = await loginToken(app);

    const res = await supertest(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: '0d000721', newPassword: '123' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when parameters are missing', async () => {
    const app = createApp();
    const token = await loginToken(app);

    const res = await supertest(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
