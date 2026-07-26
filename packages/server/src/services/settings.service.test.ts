import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  let service: SettingsService;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const db = drizzle(sqlite, { schema });
    service = new SettingsService(db);
  });

  it('returns null for non-existent key', () => {
    expect(service.get('nonexistent')).toBeNull();
  });

  it('sets and gets a value', () => {
    service.set('comfyui_base_url', 'http://localhost:8188');
    expect(service.get('comfyui_base_url')).toBe('http://localhost:8188');
  });

  it('overwrites existing value', () => {
    service.set('key', 'value1');
    service.set('key', 'value2');
    expect(service.get('key')).toBe('value2');
  });

  it('returns all settings', () => {
    service.set('key1', 'val1');
    service.set('key2', 'val2');
    const all = service.getAll();
    expect(all).toEqual({ key1: 'val1', key2: 'val2' });
  });
});
