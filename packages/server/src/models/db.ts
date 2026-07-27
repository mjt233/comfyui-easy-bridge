import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';

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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS workflow_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    alias TEXT NOT NULL UNIQUE,
    label TEXT,
    param_type TEXT NOT NULL DEFAULT 'text'
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
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    progress INTEGER,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )
`);
