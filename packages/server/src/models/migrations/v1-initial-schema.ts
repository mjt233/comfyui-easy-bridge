import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/** 迁移 1：初始 schema（5 张业务表）+ 旧库缺列幂等补偿 */
export const v1: Migration = {
  version: 1,
  name: 'initial schema',
  up: (sqlite: Database) => {
    // 建表语句保持 IF NOT EXISTS：兼容"部分表已存在"的旧库
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        build_script TEXT NOT NULL DEFAULT '',
        build_script_enabled INTEGER NOT NULL DEFAULT 0,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_params (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        alias TEXT,
        label TEXT,
        param_type TEXT NOT NULL DEFAULT 'text',
        default_value TEXT,
        UNIQUE(workflow_id, alias)
      );
      CREATE TABLE IF NOT EXISTS workflow_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        mimetype TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_logs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        workflow_name TEXT NOT NULL,
        prompt_id TEXT,
        alias_values TEXT NOT NULL,
        comfyui_url TEXT NOT NULL,
        comfyui_request_body TEXT,
        comfyui_response TEXT,
        output_files TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        progress INTEGER,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);

    // 兼容已有旧库：为 workflows 表补齐动态构建相关列（幂等）
    const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
    const has = (name: string): boolean => cols.some((c) => c.name === name);
    if (!has('build_script')) {
      sqlite.exec("ALTER TABLE workflows ADD COLUMN build_script TEXT NOT NULL DEFAULT ''");
    }
    if (!has('build_script_enabled')) {
      sqlite.exec('ALTER TABLE workflows ADD COLUMN build_script_enabled INTEGER NOT NULL DEFAULT 0');
    }
  },
};
