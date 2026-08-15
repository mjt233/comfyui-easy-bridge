import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const db = drizzle(sqlite, { schema });
    service = new AuthService(db);
  });

  it('initializes default password on first access', () => {
    expect(service.verifyPassword('0d000721')).toBe(true);
  });

  it('rejects wrong password', () => {
    expect(service.verifyPassword('wrong')).toBe(false);
  });

  it('generates a valid JWT token', () => {
    const token = service.login('0d000721');
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
  });

  it('rejects login with wrong password', () => {
    expect(() => service.login('wrong')).toThrow('Invalid password');
  });

  it('verifies a valid token', () => {
    const token = service.login('0d000721');
    const payload = service.verifyToken(token);
    expect(payload).toHaveProperty('role', 'admin');
  });

  it('rejects an invalid token', () => {
    expect(() => service.verifyToken('bad-token')).toThrow();
  });

  it('changes password with correct old password', () => {
    service.changePassword('0d000721', 'newpass123');
    expect(service.verifyPassword('newpass123')).toBe(true);
    expect(service.verifyPassword('0d000721')).toBe(false);
  });

  it('rejects change password with wrong old password', () => {
    expect(() => service.changePassword('wrong', 'newpass123')).toThrow('Invalid password');
  });

  it('rejects too-short new password', () => {
    expect(() => service.changePassword('0d000721', '123')).toThrow('New password too short');
  });

  it('revokes old tokens after password change', () => {
    const oldToken = service.login('0d000721');
    service.changePassword('0d000721', 'newpass123');
    // 旧 token 因密码指纹变化而失效
    expect(() => service.verifyToken(oldToken)).toThrow();
    // 新密码登录签发的新 token 可正常验证
    const newToken = service.login('newpass123');
    expect(service.verifyToken(newToken)).toHaveProperty('role', 'admin');
  });
});
