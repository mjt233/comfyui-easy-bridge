# 基于版本号的 SQLite 数据表结构迁移机制设计

## 背景

当前数据库初始化逻辑集中在 `packages/server/src/models/db.ts`：使用裸 `CREATE TABLE IF NOT EXISTS` 语句创建 5 张表（`workflows`、`workflow_params`、`workflow_attachments`、`settings`、`task_logs`），并对旧库调用一次性兼容函数 `ensureWorkflowBuildColumns`（为 `workflows` 表补齐 `build_script` / `build_script_enabled` 列）。

这种方式存在明显问题：

1. **没有版本概念**：未来任何 schema 变更都没有标准入口，只能继续堆 `ensureXxxColumns` 这类一次性函数
2. **变更不可追溯**：无法知道某个库处于哪个 schema 版本，已应用过哪些变更
3. **无事务保护**：`ALTER TABLE` 类变更失败时可能留下半迁移状态
4. **测试困难**：每个兼容函数都要单独写测试，且无法验证"从旧版本升级"的整体流程

## 目标

为后端引入**基于版本号的 SQLite 迁移机制**：

1. 初始建表 + 后续所有 schema 变更统一走迁移，`db.ts` 不再包含任何裸 SQL
2. 版本号顺序递增，已应用的迁移记录在专用 `schema_migrations` 表中
3. 每个迁移在独立事务中执行，失败自动回滚，避免半迁移状态
4. 对**已有旧库**无缝兼容（视为 v0，通过幂等补偿补齐缺失列）
5. 提供清晰的新增迁移入口与测试模式

## 关键决策（已与用户确认）

| 决策点 | 结论 |
|--------|------|
| 覆盖范围 | **完全接管**：初始建表 + 后续变更都走迁移，`db.ts` 中裸 SQL 全部移除 |
| 迁移写法 | **代码函数（TS）**：每个迁移是导出函数，接收 sqlite 实例，可写逻辑、可单测 |
| 版本记录 | **专用 `schema_migrations` 表**：记录已应用迁移的版本号、名称、应用时间 |
| 旧库兼容 | **基线版本 + 幂等补偿**：现有库视为 v0，迁移 1 通过 `CREATE TABLE IF NOT EXISTS` + 列补齐实现幂等升级 |

## 方案选型

### 选定方案：顺序整数版本 + TS 函数迁移 + 专用记录表（方案 A）

- 版本号为递增整数（1、2、3…），迁移定义为 `{ version, name, up }`
- 引擎 `runMigrations(sqlite)` 统一驱动：建记录表 → 读已应用版本 → 逐个事务执行 → 写记录
- **迁移 1 = 现有全部建表 + 幂等补偿**，对旧库、新库都幂等
- 已排除：
  - **方案 B（时间戳版本）**：多分支并行不易冲突，但本项目单人开发收益低，排序/比较更复杂
  - **方案 C（版本号仅存 settings 表）**：实现最简，但无法审计已应用迁移，诊断/回滚不便

## 详细设计

### 1. 目录结构

```
packages/server/src/models/
  db.ts                 # 数据库实例创建 + 调用 runMigrations（删除所有裸 SQL）
  migrations/
    index.ts            # 迁移注册表（有序数组，供引擎消费）
    runner.ts           # 迁移引擎：Migration 类型 + runMigrations()
    v1-initial-schema.ts# 迁移 1：初始建表 + 幂等补偿
  migrations.test.ts    # 重写：测试引擎行为与迁移 1
```

> 注：原 `migrations.ts` 文件删除，`ensureWorkflowBuildColumns` 逻辑移入 `migrations/v1-initial-schema.ts` 内（作为迁移 1 的内部步骤），引擎移入 `migrations/runner.ts`。这样避免 `migrations.ts` 文件与 `migrations/` 目录同名导致的模块解析冲突。

### 2. 迁移引擎（`models/migrations/runner.ts`）

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
export function runMigrations(sqlite: Database, migrationList: readonly Migration[] = migrations): Migration[] { ... }
```

引擎流程：

1. `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
2. 查询 `schema_migrations` 中已应用的最大版本号（旧库无此表 → 最大版本视为 0）
3. 将注册表按 `version` 升序过滤出 `version > 已应用最大版本` 的迁移
4. 对每个迁移，用 `sqlite.transaction` 包裹：执行 `up(sqlite)` → `INSERT INTO schema_migrations`；成功后提交，失败抛出并回滚
5. 返回实际应用的迁移列表

### 3. 迁移 1：初始建表（`models/migrations/v1-initial-schema.ts`）

- 把 `db.ts` 中 5 张表的 `CREATE TABLE IF NOT EXISTS` 语句原样移入 `up` 函数（语句保持 `IF NOT EXISTS` 以兼容"部分表已存在"的旧库）
- 在建表后调用幂等补偿逻辑（继承现有 `ensureWorkflowBuildColumns` 行为）：读取 `PRAGMA table_info(workflows)`，若缺 `build_script` / `build_script_enabled` 则 `ALTER TABLE ADD COLUMN`
- 迁移 1 对全新库、已有旧库都幂等可执行

### 4. 数据库初始化（`models/db.ts`）

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

- 删除 `ensureWorkflowBuildColumns` 导入与调用、删除全部裸 SQL
- 迁移在 `drizzle` 包装**之前**执行，保证任何 Drizzle 查询都发生在完整 schema 就绪之后

### 5. 错误处理

- 单个迁移抛错 → 该迁移事务整体回滚，`schema_migrations` 不写入记录，数据库停留在迁移前状态
- `runMigrations` 向上抛出原始错误，`db.ts` 模块加载失败 → 服务启动失败
- 服务端启动日志中透出迁移名称与版本号，便于定位是哪个迁移失败

### 6. 新增迁移的约定（后续使用）

```ts
// packages/server/src/models/migrations/v2-xxx.ts
import type { Database } from 'better-sqlite3';

export const v2 = {
  version: 2,
  name: 'xxx 变更描述',
  up: (sqlite: Database) => {
    // ...执行 SQL 变更（建议用 IF NOT EXISTS / 条件判断保证幂等）
  },
};
```

在 `migrations/index.ts` 的数组中追加，并同步更新 `docs/superpowers/specs` 与 AGENTS.md 中的说明。

### 7. 已落地迁移

- **迁移 1** `v1-initial-schema.ts`：5 张业务表建表 + 旧库缺列幂等补偿
- **迁移 2** `v2-task-original-form.ts`：`task_logs` 新增 `original_form` 列，记录用户原始请求表单 JSON（参数 + 上传文件元数据：表单 key / 文件名 / 大小；旧任务为 null）

## 测试

重写 `migrations.test.ts`，覆盖：

1. **全新库**：`runMigrations` 后 5 张业务表 + `schema_migrations` 表齐全，`workflows` 含 `build_script` 列
2. **旧库升级**：模拟缺 `build_script` / `build_script_enabled` 列的旧 `workflows` 表 + 其余表，迁移后列补齐、原有数据保留
3. **幂等**：`runMigrations` 连续执行两次，第二次返回空数组（无重复应用），表结构不变
4. **事务回滚**：注入一个必然失败的迁移（向注册表临时追加），验证该迁移失败后 `schema_migrations` 无其记录、库中无其副作用
5. **版本记录**：迁移后 `schema_migrations` 中记录数、版本号、名称正确

测试使用 `:memory:` 数据库，不依赖磁盘文件；引擎测试通过局部注入自定义迁移数组完成（不触碰真实注册表）。

## 影响范围

- **删除文件**：`models/migrations.ts`（内容并入 `migrations/` 目录）
- **改动文件**：`models/db.ts`、`models/migrations.test.ts`
- **新增文件**：`models/migrations/index.ts`、`models/migrations/runner.ts`、`models/migrations/v1-initial-schema.ts`
- **不涉及**：controllers / services / routes / 前端；Drizzle schema（`schema.ts`）不变
- **兼容性**：现有磁盘库（`data/bridge.db`）启动时自动升级，无需人工干预；`:memory:` 测试库路径不受影响

> **迁移 2 追加说明（2026-08-04）**：新增 `v2-task-original-form.ts`（`task_logs.original_form`），Drizzle schema（`schema.ts`）、`TaskService.create`、execute 控制器同步更新，前端任务详情「提交参数」页签新增左侧子页签（原始表单 / 提交参数）。
