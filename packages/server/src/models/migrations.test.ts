import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, type Migration } from './migrations/runner';
import { migrations } from './migrations';

describe('runMigrations', () => {
  it('creates all business tables and schema_migrations on a fresh database', () => {
    const sqlite = new Database(':memory:');

    const applied = runMigrations(sqlite);
    expect(applied).toHaveLength(migrations.length);

    // 5 张业务表 + 版本记录表齐全
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'workflows',
        'workflow_params',
        'workflow_attachments',
        'settings',
        'task_logs',
        'schema_migrations',
      ]),
    );

    // workflows 含动态构建列与动态字段声明列
    const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['build_script', 'build_script_enabled', 'declared_params']),
    );

    // task_logs 含原始请求表单列
    const taskCols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    expect(taskCols.map((c) => c.name)).toEqual(expect.arrayContaining(['original_form']));
  });

  it('upgrades an old database by adding missing columns and keeping data', () => {
    const sqlite = new Database(':memory:');
    // 模拟旧库：workflows 表无 build_script / build_script_enabled 列，且已有数据
    sqlite.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO workflows (id, name, raw_json, created_at, updated_at)
        VALUES ('w1', 'test', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    const applied = runMigrations(sqlite);
    expect(applied).toHaveLength(migrations.length);

    // 缺列被补齐
    const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['build_script', 'build_script_enabled', 'declared_params']),
    );

    // 原有数据保留
    const row = sqlite
      .prepare('SELECT id, name FROM workflows WHERE id = ?')
      .get('w1') as { id: string; name: string };
    expect(row).toEqual({ id: 'w1', name: 'test' });
  });

  it('is idempotent when run twice', () => {
    const sqlite = new Database(':memory:');

    const first = runMigrations(sqlite);
    const second = runMigrations(sqlite);
    expect(first).toHaveLength(migrations.length);
    expect(second).toHaveLength(0);

    // 记录表仅写入一次
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    expect(count.n).toBe(migrations.length);
  });

  it('rolls back a failing migration and does not record it', () => {
    const sqlite = new Database(':memory:');
    const bad: Migration = {
      version: 999,
      name: 'failing migration',
      up: (db) => {
        db.exec('CREATE TABLE should_rollback (id INTEGER)');
        throw new Error('boom');
      },
    };

    expect(() => runMigrations(sqlite, [bad])).toThrow('boom');

    // 副作用被回滚，记录未写入
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain('should_rollback');
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it('keeps previously applied migrations when a later one fails', () => {
    const sqlite = new Database(':memory:');
    const good: Migration = {
      version: 1,
      name: 'good',
      up: (db) => db.exec('CREATE TABLE good_table (id INTEGER)'),
    };
    const bad: Migration = {
      version: 2,
      name: 'bad',
      up: (db) => {
        db.exec('CREATE TABLE bad_table (id INTEGER)');
        throw new Error('boom');
      },
    };

    expect(() => runMigrations(sqlite, [good, bad])).toThrow('boom');

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('good_table');
    expect(names).not.toContain('bad_table');

    // 仅成功迁移被记录
    const rows = sqlite.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual([{ version: 1, name: 'good' }]);
  });

  it('records applied migrations with version and name', () => {
    const sqlite = new Database(':memory:');

    runMigrations(sqlite);

    const rows = sqlite.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows).toHaveLength(migrations.length);
    expect(rows[0]).toEqual({ version: 1, name: migrations[0].name });
  });

  it('throws when migration versions are duplicated', () => {
    const sqlite = new Database(':memory:');
    const dup: Migration = {
      version: 1,
      name: 'dup',
      up: (db) => db.exec('CREATE TABLE dup_table (id INTEGER)'),
    };

    expect(() => runMigrations(sqlite, [dup, dup])).toThrow(/duplicated/);
  });

  it('includes version and name in the failure error message', () => {
    const sqlite = new Database(':memory:');
    const bad: Migration = {
      version: 7,
      name: 'bad migration',
      up: () => {
        throw new Error('underlying failure');
      },
    };

    expect(() => runMigrations(sqlite, [bad])).toThrow(
      /Migration v7 \(bad migration\) failed: underlying failure/,
    );
  });
});

describe('v4 execution providers migration', () => {
  /** 构造只有 settings / workflows / task_logs 的最小旧库 */
  function buildLegacyDb(): Database.Database {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
      INSERT INTO settings (key, value) VALUES ('comfyui_base_url', 'http://localhost:8188');
      INSERT INTO workflows (id, name, raw_json, created_at, updated_at) VALUES ('w1', 'wf', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO task_logs (id, workflow_id, workflow_name, alias_values, comfyui_url, status, created_at) VALUES ('t1', 'w1', 'wf', '{}', 'http://localhost:8188/prompt', 'pending', '2026-01-01T00:00:00.000Z');
    `);
    return sqlite;
  }

  it('creates providers table and migrates legacy comfyui_base_url', () => {
    const sqlite = buildLegacyDb();
    runMigrations(sqlite);
    const provider = sqlite.prepare('SELECT * FROM providers').get() as { id: string; type: string; config: string };
    expect(provider.type).toBe('comfyui');
    expect(JSON.parse(provider.config)).toEqual({ baseUrl: 'http://localhost:8188' });
    const def = sqlite.prepare("SELECT value FROM settings WHERE key = 'default_provider_id'").get() as { value: string };
    expect(def.value).toBe(provider.id);
    const task = sqlite.prepare('SELECT provider_id FROM task_logs WHERE id = ?').get('t1') as { provider_id: string };
    expect(task.provider_id).toBe(provider.id);
    // workflows 列存在
    const wf = sqlite.prepare('SELECT provider_id FROM workflows WHERE id = ?').get('w1') as { provider_id: string | null };
    expect(wf.provider_id).toBeNull();
  });

  it('is idempotent across two runs', () => {
    const sqlite = buildLegacyDb();
    runMigrations(sqlite);
    runMigrations(sqlite);
    const count = sqlite.prepare('SELECT COUNT(*) AS c FROM providers').get() as { c: number };
    expect(count.c).toBe(1);
  });
});
