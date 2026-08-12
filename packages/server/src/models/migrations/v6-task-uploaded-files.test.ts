import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './runner';

describe('迁移 v6 任务上传文件列', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    runMigrations(sqlite);
  });

  it('task_logs 增加 uploaded_files 列且默认空数组', () => {
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === 'uploaded_files');
    expect(col).toBeTruthy();
    // 默认值为 '[]'，旧任务无上传文件时按空数组处理
    expect(col?.dflt_value).toBe("'[]'");
  });

  it('重复执行迁移幂等', () => {
    runMigrations(sqlite); // 再次执行不应报错
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'uploaded_files')).toBe(true);
  });
});
