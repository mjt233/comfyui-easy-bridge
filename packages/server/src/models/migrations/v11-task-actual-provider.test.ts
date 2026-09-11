import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './runner';

describe('迁移 v11 任务实际执行实例列', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    runMigrations(sqlite);
  });

  it('task_logs 增加 actual_provider_id 与 actual_provider_name 列', () => {
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'actual_provider_id')).toBe(true);
    expect(cols.some((c) => c.name === 'actual_provider_name')).toBe(true);
  });

  it('两列均可为空（历史任务与普通实例任务不写实际执行实例）', () => {
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string; notnull: number }>;
    const idCol = cols.find((c) => c.name === 'actual_provider_id');
    const nameCol = cols.find((c) => c.name === 'actual_provider_name');
    expect(idCol?.notnull).toBe(0);
    expect(nameCol?.notnull).toBe(0);
  });

  it('重复执行迁移幂等', () => {
    runMigrations(sqlite); // 再次执行不应报错
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'actual_provider_id')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'actual_provider_name')).toHaveLength(1);
  });
});
