import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';
import { ensureWorkflowBuildColumns } from './migrations';

// Schema source of truth: ./schema.ts
const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(path.join(dataDir, 'bridge.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

db.run(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    build_script TEXT NOT NULL DEFAULT '',
    build_script_enabled INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
// 兼容已有库：为 workflows 表补齐动态构建相关列
ensureWorkflowBuildColumns(sqlite);
db.run(`
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
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS workflow_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mimetype TEXT,
    created_at TEXT NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);
db.run(`
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
  )
`);