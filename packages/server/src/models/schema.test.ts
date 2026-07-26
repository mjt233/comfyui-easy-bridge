import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';

describe('schema', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_params (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, node_id TEXT NOT NULL, field_name TEXT NOT NULL, alias TEXT NOT NULL UNIQUE, label TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  });

  it('inserts and queries workflows', () => {
    const db = drizzle(sqlite, { schema });
    db.insert(schema.workflows).values({
      id: 'test-flow',
      name: 'Test',
      rawJson: '{}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    const result = db.select().from(schema.workflows).all();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('test-flow');
    expect(result[0].name).toBe('Test');
  });

  it('inserts and queries settings', () => {
    const db = drizzle(sqlite, { schema });
    db.insert(schema.settings).values({ key: 'test_key', value: 'test_value' }).run();
    const result = db.select().from(schema.settings).all();
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('test_key');
  });

  it('cascades delete from workflows to workflow_params', () => {
    const db = drizzle(sqlite, { schema });
    db.insert(schema.workflows).values({
      id: 'wf1', name: 'WF1', rawJson: '{}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    db.insert(schema.workflowParams).values({
      workflowId: 'wf1', nodeId: '1', fieldName: 'v', alias: 'a',
    }).run();

    db.delete(schema.workflows).where(eq(schema.workflows.id, 'wf1')).run();
    const params = db.select().from(schema.workflowParams).all();
    expect(params).toHaveLength(0);
  });

  it('enforces unique alias constraint', () => {
    const db = drizzle(sqlite, { schema });
    db.insert(schema.workflows).values({
      id: 'wf1', name: 'WF1', rawJson: '{}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    db.insert(schema.workflowParams).values({
      workflowId: 'wf1', nodeId: '1', fieldName: 'v', alias: 'dup',
    }).run();
    expect(() => {
      db.insert(schema.workflowParams).values({
        workflowId: 'wf1', nodeId: '2', fieldName: 'v', alias: 'dup',
      }).run();
    }).toThrow();
  });
});
