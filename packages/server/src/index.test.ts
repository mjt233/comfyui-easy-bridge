import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import app from './index';

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const res = await supertest(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('安全响应头（CSP）', () => {
  it('允许 blob: 与执行端绝对地址作为图片来源（产物预览）', async () => {
    const res = await supertest(app).get('/api/health');
    const csp = res.headers['content-security-policy'] ?? '';
    // proxy 模式预览使用 blob: 临时地址；direct 模式直连执行端/平台绝对地址
    expect(csp).toContain("img-src 'self' data: blob: http: https:");
    expect(csp).toContain("media-src 'self' blob: http: https:");
    // 脚本与表单提交仍限制为同源（未因放宽媒体来源而整体放开）
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("form-action 'self'");
  });
});
