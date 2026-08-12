import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/** 迁移 6：task_logs 增加 uploaded_files 列（记录本次上传到执行端的资产文件名，供终态后自动清理） */
export const v6: Migration = {
  version: 6,
  name: 'task uploaded files',
  up: (sqlite: Database) => {
    // 幂等补齐：旧库重复执行时列已存在则跳过
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'uploaded_files')) {
      sqlite.exec('ALTER TABLE task_logs ADD COLUMN uploaded_files TEXT NOT NULL DEFAULT \'[]\'');
    }
  },
};
