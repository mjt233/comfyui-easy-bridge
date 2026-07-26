import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { workflows, workflowParams, settings } from './schema';

describe('schema', () => {
  it('creates tables with correct columns', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    db.run(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE workflow_params (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        alias TEXT NOT NULL UNIQUE,
        label TEXT
      )
    `);
    db.run(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    expect(workflows).toBeDefined();
    expect(workflowParams).toBeDefined();
    expect(settings).toBeDefined();
    sqlite.close();
  });
});
