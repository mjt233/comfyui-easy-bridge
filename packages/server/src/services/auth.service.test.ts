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
});
