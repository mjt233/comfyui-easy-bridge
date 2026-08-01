import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureWorkflowBuildColumns } from './migrations';

describe('ensureWorkflowBuildColumns', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    // 模拟旧版本库：workflows 表没有 build_script / build_script_enabled 列
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
  });

  it('adds build_script and build_script_enabled columns to an old table', () => {
    ensureWorkflowBuildColumns(sqlite);
    const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('build_script');
    expect(names).toContain('build_script_enabled');
  });

  it('is idempotent when called twice', () => {
    ensureWorkflowBuildColumns(sqlite);
    ensureWorkflowBuildColumns(sqlite);
    const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'build_script')).toHaveLength(1);
  });
});
