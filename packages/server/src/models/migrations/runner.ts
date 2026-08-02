import type { Database } from 'better-sqlite3';
import { migrations } from './index';

/** 单个数据库迁移 */
export interface Migration {
  /** 版本号，正整数且严格递增 */
  version: number;
  /** 迁移名称（简短描述，仅用于记录/日志） */
  name: string;
  /** 迁移执行体；在独立事务中运行，抛错则整体回滚 */
  up: (sqlite: Database) => void;
}

/**
 * 执行所有未应用的数据库迁移。
 * - 自动创建 schema_migrations 记录表
 * - 对每个未应用迁移开启独立事务：执行 up → 写入记录 → 提交
 * - 返回本次实际应用的迁移列表（未应用的为空数组）
 * @param sqlite better-sqlite3 实例
 * @param migrationList 迁移列表；默认使用注册表 migrations，测试可注入自定义列表
 * @throws 任一迁移失败时抛出错误（该迁移已回滚，数据库保持迁移前状态）
 */
export function runMigrations(
  sqlite: Database,
  migrationList: readonly Migration[] = migrations,
): Migration[] {
  // 1. 创建版本记录表（不在事务内，幂等）
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  // 2. 读取已应用的最大版本号（旧库无记录 → 0）
  const row = sqlite
    .prepare('SELECT COALESCE(MAX(version), 0) AS maxVersion FROM schema_migrations')
    .get() as { maxVersion: number };

  // 3. 按版本升序过滤出未应用的迁移
  const pending = [...migrationList]
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > row.maxVersion);

  // 4. 每个迁移在独立事务中执行并写入记录
  const insertRecord = sqlite.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  const runOne = sqlite.transaction((m: Migration) => {
    m.up(sqlite);
    insertRecord.run(m.version, m.name, new Date().toISOString());
  });
  for (const m of pending) {
    runOne(m);
  }

  return pending;
}
