# SQLite 版本化迁移机制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为后端引入基于版本号的 SQLite 迁移机制，初始建表与后续 schema 变更统一走迁移引擎，旧库启动时自动幂等升级。

**Architecture:** 新增 `models/migrations/` 目录：`runner.ts`（引擎，`runMigrations(sqlite, list?)`）、`index.ts`（注册表）、`v1-initial-schema.ts`（迁移 1：5 张表建表 + 旧库缺列幂等补偿）。引擎建 `schema_migrations` 记录表 → 读最大已应用版本 → 未应用迁移逐个在独立事务中执行并记录。`db.ts` 删除全部裸 SQL，改为调用 `runMigrations(sqlite)`。删除原 `migrations.ts`（内容并入新目录）。

**Tech Stack:** TypeScript、better-sqlite3（事务）、vitest（测试）、Drizzle ORM（保持不变）

**Spec:** `docs/superpowers/specs/2026-08-03-sqlite-migrations-design.md`

---

## 文件结构

- **新增** `packages/server/src/models/migrations/runner.ts` — 迁移引擎：`Migration` 接口 + `runMigrations()`
- **新增** `packages/server/src/models/migrations/index.ts` — 迁移注册表（有序数组）
- **新增** `packages/server/src/models/migrations/v1-initial-schema.ts` — 迁移 1：初始建表 + 幂等补偿
- **重写** `packages/server/src/models/migrations.test.ts` — 引擎行为测试（原 `ensureWorkflowBuildColumns` 测试废弃）
- **删除** `packages/server/src/models/migrations.ts` — 旧兼容函数文件
- **修改** `packages/server/src/models/db.ts` — 移除裸 SQL，接入 `runMigrations`
- **修改** `AGENTS.md` — 更新「数据库」章节说明迁移机制

测试命令（Windows PowerShell）：
- 定向测试：`pnpm --filter server exec vitest run src/models/migrations.test.ts`
- 全量后端测试：`pnpm --filter server test`
- 类型检查：`pnpm --filter server exec tsc --noEmit`

---

### Task 1: 迁移引擎 + 注册表 + 迁移 1 + 引擎测试

**Files:**
- Rewrite: `packages/server/src/models/migrations.test.ts`
- Create: `packages/server/src/models/migrations/runner.ts`
- Create: `packages/server/src/models/migrations/index.ts`
- Create: `packages/server/src/models/migrations/v1-initial-schema.ts`
- Delete: `packages/server/src/models/migrations.ts`

- [ ] **Step 1: 重写测试文件（先红）**

用以下内容整体替换 `packages/server/src/models/migrations.test.ts`（原文件测试的是即将删除的 `ensureWorkflowBuildColumns`）：

```ts
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

    // workflows 含动态构建列
    const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['build_script', 'build_script_enabled']),
    );
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
      expect.arrayContaining(['build_script', 'build_script_enabled']),
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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/models/migrations.test.ts`
Expected: FAIL，报错 `Cannot find module './migrations/runner'`（引擎尚未创建）。

- [ ] **Step 3: 创建迁移引擎 `migrations/runner.ts`**

```ts
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
```

- [ ] **Step 4: 创建迁移 1 `migrations/v1-initial-schema.ts`**

```ts
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
```

- [ ] **Step 5: 创建注册表 `migrations/index.ts`**

```ts
import { v1 } from './v1-initial-schema';
import type { Migration } from './runner';

/** 迁移注册表：按 version 升序排列；新增迁移时在此追加 */
export const migrations: readonly Migration[] = [v1];
```

- [ ] **Step 6: 删除旧文件 `migrations.ts`**

Run: `git rm packages/server/src/models/migrations.ts`
（`ensureWorkflowBuildColumns` 逻辑已并入 `v1-initial-schema.ts`，删除旧文件避免与 `migrations/` 目录同名解析冲突。）

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter server exec vitest run src/models/migrations.test.ts`
Expected: 6 个用例全部 PASS。

- [ ] **Step 8: 类型检查**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误输出，退出码 0。

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/models/migrations/ packages/server/src/models/migrations.test.ts
git commit -m "feat: add versioned sqlite migration engine with initial schema"
```

---

### Task 2: 接入数据库初始化 `db.ts`

**Files:**
- Modify: `packages/server/src/models/db.ts`

- [ ] **Step 1: 替换 import 与初始化逻辑**

将 `packages/server/src/models/db.ts` 整体内容替换为（删除全部裸 SQL 与 `ensureWorkflowBuildColumns` 调用，改为 `runMigrations`）：

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';
import { runMigrations } from './migrations/runner';

// Schema source of truth: ./schema.ts
const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(path.join(dataDir, 'bridge.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// 版本化迁移：初始建表 + 后续 schema 变更统一入口
runMigrations(sqlite);

export const db = drizzle(sqlite, { schema });
```

（原文件中的 `import { ensureWorkflowBuildColumns } from './migrations';` 与 `db.run(...)` 全部建表语句、`ensureWorkflowBuildColumns(sqlite);` 一并删除。）

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误输出，退出码 0。

- [ ] **Step 3: 运行全量后端测试**

Run: `pnpm --filter server test`
Expected: 全部测试 PASS（既有测试不受影响，各测试文件均自行构造 `:memory:` 库，不经过 `db.ts`）。

- [ ] **Step 4: 手动验证现有磁盘库可正常升级**

Run: `pnpm --filter server exec tsx -e "import { db } from './src/models/db'; console.log('db ok'); process.exit(0)"`
（在 `packages/server` 目录下执行）
Expected: 输出 `db ok`；`data/bridge.db` 中新增 `schema_migrations` 表（可用 `pnpm --filter server exec tsx -e "import Database from 'better-sqlite3'; const s = new Database('data/bridge.db'); console.log(s.prepare('SELECT * FROM schema_migrations').all());"` 查看）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/models/db.ts
git commit -m "refactor: initialize database schema through migration runner"
```

---

### Task 3: 更新项目文档 `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新「数据库」章节**

将 `AGENTS.md` 中的「数据库」章节替换为：

```markdown
## 数据库

- SQLite 文件: `data/bridge.db` (已 gitignore)
- 初始建表与后续 schema 变更统一走**版本化迁移**：`packages/server/src/models/migrations/`（引擎 `runner.ts`、注册表 `index.ts`、迁移 `vN-xxx.ts`）
- 已应用迁移记录在 `schema_migrations` 表；每个迁移在独立事务中执行，失败自动回滚
- 旧库启动时自动补齐缺失列（迁移 1 幂等兼容），无需人工干预
- Drizzle schema 定义在 `schema.ts`（五表: `workflows`, `workflow_params`, `workflow_attachments`, `settings`, `task_logs`）
- 新增 schema 变更：在 `migrations/` 新建 `vN-xxx.ts` 并在 `index.ts` 注册表中追加，同步更新设计文档
- 测试使用 `:memory:` 数据库，不依赖磁盘文件
- 可以通过 `DATA_DIR` 环境变量覆盖数据库路径
```

（原章节中的 `CREATE TABLE IF NOT EXISTS` 描述与"三表"表述已过时，一并修正为迁移机制与五表。）

- [ ] **Step 2: 最终验证**

Run: `pnpm --filter server exec tsc --noEmit && pnpm --filter server test`
Expected: 类型检查无错误，全部测试 PASS。

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document versioned database migration mechanism"
```
