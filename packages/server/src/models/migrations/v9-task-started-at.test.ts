import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './runner';

describe('迁移 v9 任务开始执行时间列', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    runMigrations(sqlite);
  });

  it('task_logs 增加 started_at 列（可空）', () => {
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string; notnull: number }>;
    const col = cols.find((c) => c.name === 'started_at');
    expect(col).toBeTruthy();
    // 可空：排队中 / 历史任务无该列数据，按 null 处理
    expect(col?.notnull).toBe(0);
  });

  it('重复执行迁移幂等', () => {
    runMigrations(sqlite); // 再次执行不应报错
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'started_at')).toBe(true);
  });
});
