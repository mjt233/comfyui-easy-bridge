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
