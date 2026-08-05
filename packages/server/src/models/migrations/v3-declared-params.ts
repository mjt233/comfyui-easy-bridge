import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/** 迁移 3：workflows 增加 declared_params 列（动态字段静态声明，JSON 数组） */
export const v3: Migration = {
  version: 3,
  name: 'declared params',
  up: (sqlite: Database) => {
    // 幂等补齐：旧库重复执行时列已存在则跳过
    const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'declared_params')) {
      sqlite.exec("ALTER TABLE workflows ADD COLUMN declared_params TEXT NOT NULL DEFAULT '[]'");
    }
  },
};
