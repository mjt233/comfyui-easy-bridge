import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../models/schema';

/**
 * 构造 :memory: 测试库（providers / settings / workflows / task_logs 四表）。
 * 结构须与 Drizzle schema 保持一致（含迁移 v11 新增的 actual_provider_* 两列）。
 * @returns Drizzle 数据库实例与底层 sqlite 句柄（需要执行裸 SQL 时使用）
 */
export function buildTestDb(): {
  /** Drizzle 数据库实例 */
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** 底层 better-sqlite3 句柄 */
  sqlite: Database.Database;
} {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, provider_id TEXT, provider_name TEXT, actual_provider_id TEXT, actual_provider_name TEXT, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}
