import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Migration } from './runner';

/**
 * 迁移 4：执行提供商实例。
 * 新建 providers 表；workflows / task_logs 增加 provider_id 列；
 * 由旧设置 comfyui_base_url 迁移出一个默认 ComfyUI 实例并设为全局默认。
 */
export const v4: Migration = {
  version: 4,
  name: 'execution providers',
  up: (sqlite: Database) => {
    // ① providers 表（幂等）
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        concurrency INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // ② workflows / task_logs 补列（幂等）
    const wfCols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
    if (!wfCols.some((c) => c.name === 'provider_id')) {
      sqlite.exec('ALTER TABLE workflows ADD COLUMN provider_id TEXT');
    }
    const tlCols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    if (!tlCols.some((c) => c.name === 'provider_id')) {
      sqlite.exec('ALTER TABLE task_logs ADD COLUMN provider_id TEXT');
    }

    // ③ 数据迁移：已有默认实例则跳过
    const settings = sqlite.prepare("SELECT value FROM settings WHERE key = 'default_provider_id'").get() as
      | { value: string }
      | undefined;
    if (settings && settings.value) return;

    const now = new Date().toISOString();
    const legacyUrl = (sqlite.prepare("SELECT value FROM settings WHERE key = 'comfyui_base_url'").get() as
      | { value: string }
      | undefined)?.value ?? '';
    const id = randomUUID();
    const config = JSON.stringify({ baseUrl: legacyUrl });
    sqlite
      .prepare('INSERT INTO providers (id, name, type, config, concurrency, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)')
      .run(id, 'ComfyUI 原生', 'comfyui', config, now, now);
    sqlite.prepare("INSERT INTO settings (key, value) VALUES ('default_provider_id', ?)").run(id);

    // ④ 历史任务回填默认实例
    sqlite.prepare("UPDATE task_logs SET provider_id = ? WHERE provider_id IS NULL").run(id);
  },
};
