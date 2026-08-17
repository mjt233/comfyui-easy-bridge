import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/** 迁移 8：task_logs 增加 provider_name 列（记录实际执行提供商实例名称，供日志溯源） */
export const v8: Migration = {
  version: 8,
  name: 'task provider name',
  up: (sqlite: Database) => {
    // 幂等补齐：旧库重复执行时列已存在则跳过
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'provider_name')) {
      sqlite.exec('ALTER TABLE task_logs ADD COLUMN provider_name TEXT');
    }
  },
};