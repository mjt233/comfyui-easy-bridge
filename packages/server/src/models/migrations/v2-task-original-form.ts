import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/** 迁移 2：task_logs 增加 original_form 列（记录用户原始请求表单，含上传文件元数据） */
export const v2: Migration = {
  version: 2,
  name: 'task original form',
  up: (sqlite: Database) => {
    // 幂等补齐：旧库重复执行时列已存在则跳过
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'original_form')) {
      sqlite.exec('ALTER TABLE task_logs ADD COLUMN original_form TEXT');
    }
  },
};
