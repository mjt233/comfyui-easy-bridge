import type { Database } from 'better-sqlite3';

/**
 * 确保 workflows 表包含动态构建相关列。
 * 项目无迁移框架，对已有库执行幂等的 ALTER TABLE 兼容升级。
 * @param sqlite better-sqlite3 实例
 */
export function ensureWorkflowBuildColumns(sqlite: Database): void {
  const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
  const has = (name: string): boolean => cols.some((c) => c.name === name);

  if (!has('build_script')) {
    sqlite.exec('ALTER TABLE workflows ADD COLUMN build_script TEXT NOT NULL DEFAULT \'\'');
  }
  if (!has('build_script_enabled')) {
    sqlite.exec('ALTER TABLE workflows ADD COLUMN build_script_enabled INTEGER NOT NULL DEFAULT 0');
  }
}
