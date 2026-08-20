import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/** 迁移 9：task_logs 增加 started_at 列（记录实际开始执行时间，供执行耗时计算） */
export const v9: Migration = {
  version: 9,
  name: 'task started at',
  up: (sqlite: Database) => {
    // 幂等补齐：旧库重复执行时列已存在则跳过
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'started_at')) {
      sqlite.exec('ALTER TABLE task_logs ADD COLUMN started_at TEXT');
    }
  },
};
