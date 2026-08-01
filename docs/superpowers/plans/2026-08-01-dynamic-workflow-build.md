# 动态工作流构建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户通过 TypeScript 脚本在提交执行时动态调整 ComfyUI 工作流（增删节点、改连线、改参数），支持 Monaco 编辑器编写、模拟构建预览，并在真实执行链路（文件上传后、参数替换前）运行脚本。

**Architecture:** 后端 `workflows` 表新增 `build_script`/`build_script_enabled` 两列；新增 `build-script-api.ts`（类型 + d.ts 单一来源）、`build.worker.ts`（内嵌 JS worker 源码）、`build.service.ts`（主线程转译 + worker 超时硬杀）。前端新增 Monaco 编辑页签 + 两步模拟构建对话框，模拟结果含节点表/画布/JSON。真实执行在 `controller.execute` 中 `processMediaParams` 之后、`applyAliases` 之前插入构建。

**Tech Stack:** Express + TypeScript + Drizzle ORM (SQLite)、worker_threads、typescript.transpileModule、Vue 3 + Vuetify + Vite、monaco-editor

---

## 前置已验证事实（实现时可直接依赖）

- `new Worker(source, { eval: true })` 中**内建模块**（`fs`/`os`/`path`/`worker_threads`）可用，但**第三方包（如 `typescript`）不可解析**（require stack 显示 `[worker eval]`）。因此转译必须在**主线程**完成，worker 只接收转译后的 JS 字符串。
- 主线程 `import ts from 'typescript'` 可用（`tsconfig.base.json` 已开 `esModuleInterop`，`typescript` 在 server devDependencies）。
- 完整流程已验证：主线程 `transpileModule`（CommonJS + ES2022）→ worker 写 `os.tmpdir()` 下的 `.cjs` 临时文件 → `require` → 取 `mod.default` → `await buildFn(ctx)` → `postMessage` 回传，异步默认导出可正常工作。
- `vite-env.d.ts` 已 `/// <reference types="vite/client" />`，Monaco 的 `?worker` 导入可通过类型检查。
- `noUnusedLocals`/`noUnusedParameters` 已开启：代码不得有未使用导入/参数（未使用参数用 `_` 前缀）。

---

## 任务清单总览

| Task | 内容 | 关键文件 |
|------|------|----------|
| 1 | 数据模型：新增两列 + 兼容迁移 + 测试建表同步 | `schema.ts`、新 `migrations.ts`、`db.ts`、7 个测试文件 |
| 2 | `WorkflowService.updateBuildScript` + rename 保留新列 | `workflow.service.ts` + 测试 |
| 3 | 脚本契约：`build-script-api.ts`（类型 + d.ts 常量） | 新 `build-script-api.ts` + 测试 |
| 4 | 执行引擎：`build.worker.ts` + `build.service.ts` | 两个新文件 + 测试 |
| 5 | 后端 API：controller + routes + execute 集成 | `workflow.controller.ts`、`workflow.routes.ts` + 测试 |
| 6 | 前端类型 + API 封装 | `types/index.ts`、`api/workflows.ts` |
| 7 | 前端 Monaco 编辑页签 | 新 `monaco.ts`、`BuildScriptEditor.vue`、`WorkflowDetailPage.vue` |
| 8 | 前端模拟构建对话框 | 新 `BuildSimulateDialog.vue` |
| 9 | 全量验证 + 回归 | 全部 |

---

## Task 1: 数据模型 — 新增 `build_script` / `build_script_enabled` 列 + 兼容迁移

**Files:**
- Modify: `packages/server/src/models/schema.ts`
- Create: `packages/server/src/models/migrations.ts`
- Create: `packages/server/src/models/migrations.test.ts`
- Modify: `packages/server/src/models/db.ts`
- Modify: `packages/server/src/models/schema.test.ts:13`
- Modify: `packages/server/src/routes/workflow.routes.test.ts:26`
- Modify: `packages/server/src/routes/task.routes.test.ts:24` 和 `:290`
- Modify: `packages/server/src/services/attachment.service.test.ts:23`
- Modify: `packages/server/src/services/task.service.test.ts:10`
- Modify: `packages/server/src/services/workflow-io.service.test.ts:20`
- Modify: `packages/server/src/services/workflow.service.test.ts:15`

- [ ] **Step 1: 修改 `schema.ts`，给 `workflows` 表新增两列**

在 `packages/server/src/models/schema.ts` 的 `workflows` 定义中，`rawJson` 之后、`createdAt` 之前插入：

```ts
export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rawJson: text('raw_json').notNull(),
  /** 动态构建脚本源码；空串表示未配置 */
  buildScript: text('build_script').notNull().default(''),
  /** 是否启用动态构建（0/1） */
  buildScriptEnabled: integer('build_script_enabled').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

- [ ] **Step 2: 新建 `migrations.ts`**

创建 `packages/server/src/models/migrations.ts`：

```ts
import type { Database } from 'better-sqlite3';

/**
 * 确保 workflows 表包含动态构建相关列。
 * 项目无迁移框架，对已有库执行幂等的 ALTER TABLE 兼容升级。
 * @param sqlite better-sqlite3 实例
 */
export function ensureWorkflowBuildColumns(sqlite: Database): void {
  const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
  const has = (name: string): boolean => cols.some((c) => c.name === name);

  if (!has('build_script')) {
    sqlite.exec(`ALTER TABLE workflows ADD COLUMN build_script TEXT NOT NULL DEFAULT ''`);
  }
  if (!has('build_script_enabled')) {
    sqlite.exec(`ALTER TABLE workflows ADD COLUMN build_script_enabled INTEGER NOT NULL DEFAULT 0`);
  }
}
```

- [ ] **Step 3: 新建 `migrations.test.ts`（先写测试）**

创建 `packages/server/src/models/migrations.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureWorkflowBuildColumns } from './migrations';

describe('ensureWorkflowBuildColumns', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    // 模拟旧版本库：workflows 表没有 build_script / build_script_enabled 列
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
  });

  it('adds build_script and build_script_enabled columns to an old table', () => {
    ensureWorkflowBuildColumns(sqlite);
    const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('build_script');
    expect(names).toContain('build_script_enabled');
  });

  it('is idempotent when called twice', () => {
    ensureWorkflowBuildColumns(sqlite);
    ensureWorkflowBuildColumns(sqlite);
    const cols = sqlite.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'build_script')).toHaveLength(1);
  });
});
```

- [ ] **Step 4: 运行迁移测试，确认通过**

Run: `pnpm --filter server exec vitest run src/models/migrations.test.ts`
Expected: 2 tests pass。

- [ ] **Step 5: 修改 `db.ts` 调用迁移**

在 `packages/server/src/models/db.ts` 顶部 import 区加：

```ts
import { ensureWorkflowBuildColumns } from './migrations';
```

并在 `db.run(\`CREATE TABLE IF NOT EXISTS workflows ...\`)` 语句**之后**、`workflow_params` 建表之前调用：

```ts
// 兼容已有库：为 workflows 表补齐动态构建相关列
ensureWorkflowBuildColumns(sqlite);
```

- [ ] **Step 6: 同步 7 个测试文件的 workflows 建表语句**

以下文件中所有 `CREATE TABLE workflows (...)` 语句，把 `raw_json TEXT NOT NULL,` 后追加 `build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0,`，最终形如：

```sql
CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

涉及文件与行（每个文件内所有匹配处都要改）：
- `packages/server/src/models/schema.test.ts`（1 处）
- `packages/server/src/routes/workflow.routes.test.ts`（1 处）
- `packages/server/src/routes/task.routes.test.ts`（2 处）
- `packages/server/src/services/attachment.service.test.ts`（1 处）
- `packages/server/src/services/task.service.test.ts`（1 处）
- `packages/server/src/services/workflow-io.service.test.ts`（1 处）
- `packages/server/src/services/workflow.service.test.ts`（1 处）

（`task.routes.test.ts` 与 `workflow.routes.test.ts` 中可能有对齐排版的多行建表语句，保持缩进风格一致即可。）

- [ ] **Step 7: 运行后端全部测试 + 类型检查**

Run: `pnpm --filter server test`
Run: `pnpm --filter server exec tsc --noEmit`
Expected: 全部通过（schema 增列后，所有测试的建表已同步）。

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/models packages/server/src/routes packages/server/src/services
git commit -m "feat: add build_script columns to workflows with migration"
```

---

## Task 2: `WorkflowService` — `updateBuildScript` + rename 保留新列

**Files:**
- Modify: `packages/server/src/services/workflow.service.ts`
- Modify: `packages/server/src/services/workflow.service.test.ts`

- [ ] **Step 1: 加 `UpdateBuildScriptInput` 接口**

在 `packages/server/src/services/workflow.service.ts` 中，`UpdateParamInput` 接口定义之后追加：

```ts
/**
 * 保存动态构建脚本的输入
 */
interface UpdateBuildScriptInput {
  /** 脚本源码 */
  script: string;
  /** 是否启用 */
  enabled: boolean;
}
```

- [ ] **Step 2: 新增 `updateBuildScript` 方法**

在 `WorkflowService` 类中、`updateParam` 方法之后追加：

```ts
  /**
   * 保存动态构建脚本与启用状态
   * @param id 工作流 ID
   * @param input 脚本与启用状态
   * @returns 更新后的工作流行
   */
  updateBuildScript(id: string, input: UpdateBuildScriptInput) {
    this.db.update(schema.workflows)
      .set({
        buildScript: input.script,
        buildScriptEnabled: input.enabled ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflows.id, id))
      .run();
    return this.getById(id);
  }
```

- [ ] **Step 3: 修复 `update()` 改名路径，保留新列**

`workflow.service.ts` 的 `update()` 方法中，改名分支（`input.id && input.id !== id`）的 INSERT 语句，在 `rawJson: input.rawJson ?? existing.rawJson,` 之后插入两行：

```ts
        this.db.insert(schema.workflows).values({
          id: input.id!,
          name: input.name ?? existing.name,
          rawJson: input.rawJson ?? existing.rawJson,
          buildScript: existing.buildScript,
          buildScriptEnabled: existing.buildScriptEnabled,
          createdAt: existing.createdAt,
          updatedAt: now,
        }).run();
```

- [ ] **Step 4: 写 `workflow.service.test.ts` 的测试**

在 `packages/server/src/services/workflow.service.test.ts` 中追加用例（复用该文件已有的建表与 setup 模式，通过 `new WorkflowService(db)` 实例）：

```ts
  it('updateBuildScript saves script and enabled flag', () => {
    const service = new WorkflowService(db);
    service.create({ id: 'wf-build', name: 'Build', rawJson: '{}' });

    const updated = service.updateBuildScript('wf-build', { script: 'export default function build(ctx) { return ctx.workflow; }', enabled: true });

    expect(updated?.buildScript).toContain('export default');
    expect(updated?.buildScriptEnabled).toBe(1);

    const disabled = service.updateBuildScript('wf-build', { script: '', enabled: false });
    expect(disabled?.buildScript).toBe('');
    expect(disabled?.buildScriptEnabled).toBe(0);
  });

  it('update with id rename preserves build script columns', () => {
    const service = new WorkflowService(db);
    service.create({ id: 'wf-old', name: 'Old', rawJson: '{}' });
    service.updateBuildScript('wf-old', { script: '// keep me', enabled: true });

    const renamed = service.update('wf-old', { id: 'wf-new' });

    expect(renamed?.id).toBe('wf-new');
    expect(renamed?.buildScript).toBe('// keep me');
    expect(renamed?.buildScriptEnabled).toBe(1);
  });
```

（注意：该测试文件 beforeEach 中 `db` 的构造方式，需与文件内已有用例一致；若文件用 `const db = drizzle(sqlite, { schema })` 的局部变量，则改为在每个用例内构造或按文件既有模式处理。）

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter server exec vitest run src/services/workflow.service.test.ts`
Expected: 全部通过（含新增 2 个用例）。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/workflow.service.ts packages/server/src/services/workflow.service.test.ts
git commit -m "feat: add updateBuildScript to WorkflowService, preserve columns on rename"
```

---

## Task 3: 脚本契约 — `build-script-api.ts`（类型 + d.ts 单一来源）

**Files:**
- Create: `packages/server/src/services/build-script-api.ts`
- Create: `packages/server/src/services/build-script-api.test.ts`

- [ ] **Step 1: 创建 `build-script-api.ts`**

创建 `packages/server/src/services/build-script-api.ts`：

```ts
/**
 * 动态构建脚本 API：编辑器类型声明（d.ts 文本）的单一事实来源。
 * 运行时辅助函数实现在 build.worker.ts 内（随 worker 源码字符串下发执行），
 * 其行为必须与本文件导出的类型声明保持一致，由 build.service.test.ts 锁定。
 */

/** ComfyUI API 工作流节点 */
export interface ComfyNode {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: { title?: string };
}

/** ComfyUI API 工作流（节点 ID → 节点） */
export type ComfyWorkflow = Record<string, ComfyNode>;

/**
 * Monaco 编辑器注册的脚本 API 类型声明文本。
 * 由 GET /api/workflows/build-api.d.ts 下发，前端 addExtraLib 注册。
 */
export const BUILD_SCRIPT_API_DTS = `
/** ComfyUI API 工作流节点 */
declare interface ComfyNode {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: { title?: string };
}

/** ComfyUI API 工作流（节点 ID → 节点） */
declare type ComfyWorkflow = Record<string, ComfyNode>;

/** 构建上下文：脚本默认导出函数的唯一入参 */
declare interface BuildContext {
  /** 原始工作流（深拷贝，可直接修改） */
  workflow: ComfyWorkflow;
  /** 用户提交的参数（别名字段 + 自由添加字段） */
  params: Record<string, unknown>;
  /** 新增节点；节点 ID 已存在时抛错 */
  addNode(nodeId: string, classType: string, inputs?: Record<string, unknown>): void;
  /** 删除节点；自动清理指向它的连线 */
  removeNode(nodeId: string): void;
  /** 连接：source 节点的第 sourceSlot 个输出 → target 节点的 targetField 输入 */
  connect(sourceNodeId: string, sourceSlot: number, targetNodeId: string, targetField: string): void;
  /** 断开 targetField 上的连线，并设置回退值 */
  disconnect(targetNodeId: string, targetField: string, fallbackValue?: unknown): void;
  /** 设置节点字段值 */
  setInput(nodeId: string, field: string, value: unknown): void;
  /** 读取节点字段值 */
  getInput(nodeId: string, field: string): unknown;
  /** 按 class_type 查找节点 ID 列表 */
  findNodesByClass(classType: string): string[];
  /** 获取节点引用（不存在返回 undefined） */
  getNode(nodeId: string): ComfyNode | undefined;
  /** 设置节点标题（_meta.title） */
  setTitle(nodeId: string, title: string): void;
}
`;

/**
 * 编辑器"默认导出模板"片段：一键插入到脚本中。
 */
export const DEFAULT_BUILD_SCRIPT_TEMPLATE = `export default async function build(ctx: BuildContext): Promise<ComfyWorkflow> {
  const { workflow, params } = ctx;
  // 在这里根据 params 动态调整工作流。
  // 示例：
  // if (params.mode === 'upscale') {
  //   ctx.addNode('9', 'UpscaleModelLoader', { model_name: '4x-UltraSharp.pth' });
  //   ctx.connect('9', 0, '4', 'model');
  // }
  return workflow;
}
`;
```

- [ ] **Step 2: 创建 `build-script-api.test.ts`**

创建 `packages/server/src/services/build-script-api.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { BUILD_SCRIPT_API_DTS, DEFAULT_BUILD_SCRIPT_TEMPLATE } from './build-script-api';

describe('build-script-api', () => {
  it('exports a d.ts containing all helper declarations', () => {
    for (const decl of [
      'declare interface ComfyNode',
      'declare type ComfyWorkflow',
      'declare interface BuildContext',
      'addNode(nodeId: string, classType: string',
      'removeNode(nodeId: string)',
      'connect(sourceNodeId: string',
      'disconnect(targetNodeId: string',
      'setInput(nodeId: string',
      'getInput(nodeId: string',
      'findNodesByClass(classType: string)',
      'getNode(nodeId: string)',
      'setTitle(nodeId: string',
    ]) {
      expect(BUILD_SCRIPT_API_DTS).toContain(decl);
    }
  });

  it('default template references BuildContext and ComfyWorkflow', () => {
    expect(DEFAULT_BUILD_SCRIPT_TEMPLATE).toContain('BuildContext');
    expect(DEFAULT_BUILD_SCRIPT_TEMPLATE).toContain('ComfyWorkflow');
    expect(DEFAULT_BUILD_SCRIPT_TEMPLATE).toContain('export default async function build');
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `pnpm --filter server exec vitest run src/services/build-script-api.test.ts`
Expected: 2 tests pass。

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/build-script-api.ts packages/server/src/services/build-script-api.test.ts
git commit -m "feat: add build script api type declarations (single source of truth)"
```

---

## Task 4: 执行引擎 — `build.worker.ts` + `build.service.ts`

**Files:**
- Create: `packages/server/src/services/build.worker.ts`
- Create: `packages/server/src/services/build.service.ts`
- Create: `packages/server/src/services/build.service.test.ts`

- [ ] **Step 1: 创建 `build.worker.ts`（内嵌 JS worker 源码字符串）**

创建 `packages/server/src/services/build.worker.ts`：

```ts
/**
 * 动态构建脚本执行 worker 的源码。
 * 以纯 JS 字符串内嵌（无 import/export），经 eval:true 模式运行，
 * 仅依赖 Node 内建模块（worker 内无法解析第三方包，转译在主线程完成）。
 * 辅助函数实现必须与 build-script-api.ts 的 d.ts 声明保持一致。
 */
export const BUILD_WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 判断值是否为 ComfyUI 连线引用 [nodeId, slot] */
function isConnection(value) {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}

/** 深拷贝工作流 */
function cloneWorkflow(workflow) {
  return JSON.parse(JSON.stringify(workflow));
}

/**
 * 创建构建上下文：深拷贝 workflow + 辅助函数。
 * @param {object} workflow 原始工作流
 * @param {object} params 用户提交参数
 * @returns {object} BuildContext
 */
function createContext(workflow, params) {
  const wf = cloneWorkflow(workflow);
  return {
    workflow: wf,
    params,
    addNode(nodeId, classType, inputs) {
      if (Object.prototype.hasOwnProperty.call(wf, nodeId)) {
        throw new Error('addNode: node "' + nodeId + '" already exists');
      }
      wf[nodeId] = { inputs: Object.assign({}, inputs || {}), class_type: classType };
    },
    removeNode(nodeId) {
      if (!wf[nodeId]) throw new Error('removeNode: node "' + nodeId + '" not found');
      for (const node of Object.values(wf)) {
        for (const [field, value] of Object.entries(node.inputs)) {
          if (isConnection(value) && value[0] === nodeId) {
            node.inputs[field] = null;
          }
        }
      }
      delete wf[nodeId];
    },
    connect(sourceNodeId, sourceSlot, targetNodeId, targetField) {
      if (!wf[sourceNodeId]) throw new Error('connect: source node "' + sourceNodeId + '" not found');
      if (!wf[targetNodeId]) throw new Error('connect: target node "' + targetNodeId + '" not found');
      wf[targetNodeId].inputs[targetField] = [sourceNodeId, sourceSlot];
    },
    disconnect(targetNodeId, targetField, fallbackValue) {
      if (!wf[targetNodeId]) throw new Error('disconnect: node "' + targetNodeId + '" not found');
      wf[targetNodeId].inputs[targetField] = fallbackValue === undefined ? null : fallbackValue;
    },
    setInput(nodeId, field, value) {
      if (!wf[nodeId]) throw new Error('setInput: node "' + nodeId + '" not found');
      wf[nodeId].inputs[field] = value;
    },
    getInput(nodeId, field) {
      const node = wf[nodeId];
      return node ? node.inputs[field] : undefined;
    },
    findNodesByClass(classType) {
      return Object.keys(wf).filter((id) => wf[id].class_type === classType);
    },
    getNode(nodeId) {
      return wf[nodeId];
    },
    setTitle(nodeId, title) {
      const node = wf[nodeId];
      if (!node) throw new Error('setTitle: node "' + nodeId + '" not found');
      if (!node._meta) node._meta = {};
      node._meta.title = title;
    },
  };
}

/** 运行用户脚本并回传结果 */
async function run() {
  try {
    const { jsCode, params, workflow } = workerData;
    const tmpFile = path.join(
      os.tmpdir(),
      'comfy-build-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.cjs',
    );
    fs.writeFileSync(tmpFile, jsCode, 'utf8');
    let buildFn = null;
    try {
      const mod = require(tmpFile);
      buildFn = typeof mod.default === 'function' ? mod.default : (typeof mod === 'function' ? mod : null);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (err) { /* 忽略清理失败 */ }
    }
    if (typeof buildFn !== 'function') {
      parentPort.postMessage({ ok: false, error: '脚本必须通过 export default 导出一个构建函数' });
      return;
    }
    const ctx = createContext(workflow, params);
    const result = await buildFn(ctx);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      parentPort.postMessage({ ok: false, error: '构建函数必须返回工作流对象' });
      return;
    }
    parentPort.postMessage({ ok: true, workflow: result });
  } catch (err) {
    const msg = (err && err.message) ? err.message + '\\n' + (err.stack || '') : String(err);
    parentPort.postMessage({ ok: false, error: msg });
  }
}

run();
`;
```

- [ ] **Step 2: 创建 `build.service.ts`**

创建 `packages/server/src/services/build.service.ts`：

```ts
import { Worker } from 'worker_threads';
import ts from 'typescript';
import { BUILD_WORKER_SOURCE } from './build.worker';
import type { ComfyWorkflow } from './build-script-api';

/** 构建脚本最大结果体积（字节） */
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

/** 构建结果 */
export interface BuildScriptResult {
  /** 是否成功 */
  ok: boolean;
  /** 构建后的工作流对象（ok=true 时） */
  workflow?: ComfyWorkflow;
  /** 错误信息（ok=false 时） */
  error?: string;
  /** 错误码 */
  code?: 'build_script_error' | 'build_script_timeout';
}

/**
 * 运行动态构建脚本。
 * 主线程转译 TS → JS 后交给 worker 线程执行（worker 内无法解析第三方包）。
 * 超时后 terminate() 硬杀 worker，不影响服务进程。
 * @param script 用户 TS 脚本源码
 * @param params 用户提交参数
 * @param workflow 原始工作流对象（将被深拷贝）
 * @param timeoutMs 超时毫秒数，默认 5000
 * @returns 构建结果
 */
export function runBuildScript(
  script: string,
  params: Record<string, unknown>,
  workflow: ComfyWorkflow,
  timeoutMs = 5000,
): Promise<BuildScriptResult> {
  return new Promise<BuildScriptResult>((resolve) => {
    let settled = false;

    // 主线程转译（typescript 包在 worker 内不可解析）
    let jsCode: string;
    try {
      jsCode = ts.transpileModule(script, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
    } catch (err) {
      resolve({
        ok: false,
        code: 'build_script_error',
        error: err instanceof Error ? err.message : 'Transpile failed',
      });
      return;
    }

    const worker = new Worker(BUILD_WORKER_SOURCE, {
      eval: true,
      workerData: { jsCode, params, workflow },
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => undefined);
      resolve({ ok: false, code: 'build_script_timeout', error: 'Script execution timed out' });
    }, timeoutMs);

    worker.on('message', (msg: { ok: boolean; workflow?: ComfyWorkflow; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!msg.ok) {
        resolve({ ok: false, code: 'build_script_error', error: msg.error ?? 'Unknown build error' });
        return;
      }
      // 结果体积限制
      try {
        if (JSON.stringify(msg.workflow).length > MAX_RESULT_BYTES) {
          resolve({ ok: false, code: 'build_script_error', error: 'Build result too large' });
          return;
        }
      } catch {
        resolve({ ok: false, code: 'build_script_error', error: 'Build result is not serializable' });
        return;
      }
      resolve({ ok: true, workflow: msg.workflow });
    });

    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: 'build_script_error', error: err.message });
    });

    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: 'build_script_error', error: `Worker exited with code ${code}` });
    });
  });
}
```

- [ ] **Step 3: 创建 `build.service.test.ts`（先写测试）**

创建 `packages/server/src/services/build.service.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { runBuildScript } from './build.service';
import type { ComfyWorkflow } from './build-script-api';

/** 基础工作流：KSampler(4) 的 model 输入连到 CheckpointLoader(1) */
const baseWorkflow: ComfyWorkflow = {
  '1': { inputs: { ckpt_name: 'model.safetensors' }, class_type: 'CheckpointLoaderSimple', _meta: { title: '模型' } },
  '4': { inputs: { seed: 0, model: ['1', 0] }, class_type: 'KSampler', _meta: { title: '采样器' } },
};

describe('runBuildScript', () => {
  it('builds a workflow with addNode/connect/setInput', async () => {
    const script = `
      export default function build(ctx: any) {
        ctx.setInput('4', 'seed', 123);
        ctx.addNode('9', 'UpscaleModelLoader', { model_name: '4x.pth' });
        ctx.connect('9', 0, '4', 'model');
        return ctx.workflow;
      }
    `;
    const result = await runBuildScript(script, {}, baseWorkflow);
    expect(result.ok).toBe(true);
    expect(result.workflow?.['4'].inputs.seed).toBe(123);
    expect(result.workflow?.['4'].inputs.model).toEqual(['9', 0]);
    expect(result.workflow?.['9'].class_type).toBe('UpscaleModelLoader');
  });

  it('supports async default export and reads params', async () => {
    const script = `
      export default async function build(ctx: any) {
        await new Promise((r) => setTimeout(r, 10));
        ctx.removeNode('1');
        if (ctx.params.mode === 'short') {
          ctx.setInput('4', 'steps', 10);
        }
        return ctx.workflow;
      }
    `;
    const result = await runBuildScript(script, { mode: 'short' }, baseWorkflow);
    expect(result.ok).toBe(true);
    expect(result.workflow?.['1']).toBeUndefined();
    expect(result.workflow?.['4'].inputs.steps).toBe(10);
    // removeNode 清理了指向 1 的连线
    expect(result.workflow?.['4'].inputs.model).toBeNull();
  });

  it('does not mutate the input workflow (deep copy)', async () => {
    const script = `export default function build(ctx: any) { ctx.setInput('4', 'seed', 999); return ctx.workflow; }`;
    const result = await runBuildScript(script, {}, baseWorkflow);
    expect(result.ok).toBe(true);
    expect(baseWorkflow['4'].inputs.seed).toBe(0);
  });

  it('reports syntax errors', async () => {
    const result = await runBuildScript('export default function build( {', {}, baseWorkflow);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_error');
    expect(result.error).toBeTruthy();
  });

  it('reports runtime errors with message', async () => {
    const script = `export default function build(ctx: any) { ctx.addNode('4', 'X'); return ctx.workflow; }`;
    const result = await runBuildScript(script, {}, baseWorkflow);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_error');
    expect(result.error).toContain('already exists');
  });

  it('kills infinite loops via timeout', async () => {
    const script = `export default function build() { while (true) {} }`;
    const result = await runBuildScript(script, {}, baseWorkflow, 1000);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_timeout');
  });

  it('allows open Node capabilities (require fs)', async () => {
    const script = `
      const fs = require('fs');
      export default function build(ctx: any) {
        ctx.setInput('4', 'seed', fs.readFileSync(require('path').join('x', 'y'), 'utf8').length);
        return ctx.workflow;
      }
    `;
    // 文件不存在会抛错 → 说明 require('fs') 可用（错误来自文件不存在而非 require 失败）
    const result = await runBuildScript(script, {}, baseWorkflow);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('rejects non-object returns', async () => {
    for (const bad of ['null', '[]', '"str"']) {
      const script = `export default function build() { return ${bad}; }`;
      const result = await runBuildScript(script, {}, baseWorkflow);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('build_script_error');
    }
  });

  it('connect to missing node throws', async () => {
    const script = `export default function build(ctx: any) { ctx.connect('nope', 0, '4', 'model'); return ctx.workflow; }`;
    const result = await runBuildScript(script, {}, baseWorkflow);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter server exec vitest run src/services/build.service.test.ts`
Expected: 全部通过。若 `while(true)` 用例偶发不稳定，可把超时放宽到 1500ms。

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/build.worker.ts packages/server/src/services/build.service.ts packages/server/src/services/build.service.test.ts
git commit -m "feat: add dynamic build script execution engine (worker + timeout)"
```

---

## Task 5: 后端 API — controller + routes + execute 集成

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`
- Modify: `packages/server/src/routes/workflow.routes.ts`
- Modify: `packages/server/src/routes/workflow.routes.test.ts`

- [ ] **Step 1: controller 增加 import**

`packages/server/src/controllers/workflow.controller.ts` 的 import 区追加：

```ts
import { runBuildScript } from '../services/build.service';
import { BUILD_SCRIPT_API_DTS, type ComfyWorkflow } from '../services/build-script-api';
```

- [ ] **Step 2: 新增三个 handler**

在 `workflow.controller.ts` 的返回对象中、`list` 之前插入 `getBuildApiTypes`，在 `getById` 之后插入 `saveBuildScript` 与 `simulateBuild`：

```ts
    /** 返回动态构建脚本 API 的 d.ts 文本（供 Monaco 注册类型提示） */
    getBuildApiTypes(_req: Request, res: Response): void {
      res.type('text/plain').send(BUILD_SCRIPT_API_DTS);
    },
```

```ts
    /** 保存动态构建脚本与启用状态 */
    saveBuildScript(req: Request, res: Response): void {
      const id = req.params.id as string;
      const existing = workflowService.getById(id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const body = req.body as { script?: unknown; enabled?: unknown };
      if (typeof body.script !== 'string') {
        res.status(400).json({ error: 'script is required', code: 'missing_parameter' });
        return;
      }
      const wf = workflowService.updateBuildScript(id, {
        script: body.script,
        enabled: body.enabled === true,
      });
      res.json({ ...wf, buildScriptEnabled: wf.buildScriptEnabled === 1 });
    },

    /** 模拟构建：脚本构建 + 应用已保存参数配置，返回最终 JSON 字符串 */
    async simulateBuild(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const id = req.params.id as string;
        const wf = workflowService.getById(id);
        if (!wf) {
          res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
          return;
        }
        const body = req.body as { script?: unknown; params?: unknown };
        if (typeof body.script !== 'string' || body.script.trim() === '') {
          res.status(400).json({ error: 'script is required', code: 'missing_parameter' });
          return;
        }
        const aliasParams = (body.params && typeof body.params === 'object' && !Array.isArray(body.params))
          ? body.params as Record<string, unknown>
          : {};

        // 脚本构建（作用于 rawJson 的深拷贝）
        const buildResult = await runBuildScript(body.script, aliasParams, JSON.parse(wf.rawJson) as ComfyWorkflow);
        if (!buildResult.ok) {
          res.status(400).json({ error: buildResult.error, code: buildResult.code });
          return;
        }
        // 应用已保存参数配置（与真实执行顺序一致）
        const workflowParams = workflowService.getParams(id);
        const finalJson = applyAliases(JSON.stringify(buildResult.workflow), workflowParams, aliasParams);
        res.json({ json: finalJson });
      } catch (err) {
        next(err);
      }
    },
```

同时把 `getById` 的返回改为布尔化 `buildScriptEnabled`（保持前端类型干净）：

```ts
    getById(req: Request, res: Response): void {
      const id = req.params.id as string;
      const wf = workflowService.getById(id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const params = workflowService.getParams(id);
      res.json({ ...wf, buildScriptEnabled: wf.buildScriptEnabled === 1, params });
    },
```

- [ ] **Step 3: 修改 `execute` 集成动态构建**

`workflow.controller.ts` 的 `execute` 中，在 `const finalAliasValues = await processMediaParams(...)` 之后、`const modifiedJson = applyAliases(...)` 之前插入：

```ts
        // 【动态构建】上传完成后、别名替换前执行脚本（仅当已保存且启用）
        let buildSource = wf.rawJson;
        if (wf.buildScriptEnabled && wf.buildScript) {
          const buildResult = await runBuildScript(
            wf.buildScript,
            finalAliasValues,
            JSON.parse(wf.rawJson) as ComfyWorkflow,
          );
          if (!buildResult.ok) {
            // 构建失败：记录 failed 任务，不提交 ComfyUI
            const failedTask = taskService.create({
              workflowId: wf.id,
              workflowName: wf.name,
              aliasValues: JSON.stringify(finalAliasValues),
              comfyuiUrl: `${baseUrl}/prompt`,
              comfyuiRequestBody: null,
              comfyuiResponse: null,
              promptId: null,
            });
            taskService.updateStatus(failedTask.id, {
              status: 'failed',
              errorMessage: `Dynamic build failed: ${buildResult.error}`,
            });
            res.json({ task_id: failedTask.id, status: 'failed', comfyui_response: null });
            return;
          }
          buildSource = JSON.stringify(buildResult.workflow);
        }

        // 将别名值注入工作流 JSON（现有，作用于构建后的 JSON）
        const modifiedJson = applyAliases(buildSource, params, finalAliasValues);
```

并把紧随其后的排队分支与直接执行分支中的 `wf.rawJson` 替换为 `buildSource`：
- 排队分支：`comfyuiRequestBody: JSON.stringify({ prompt: JSON.parse(modifiedJson) })` 无需改（用的已是 modifiedJson）。
- 直接执行分支：`const result = await executeWorkflow(wf.rawJson, params, finalAliasValues, baseUrl);` → 改为 `const result = await executeWorkflow(buildSource, params, finalAliasValues, baseUrl);`

- [ ] **Step 4: 修改 `workflow.routes.ts` 挂载路由**

在 `packages/server/src/routes/workflow.routes.ts` 中，把静态路径区改为（`build-api.d.ts` 必须在 `/:id` 之前注册）：

```ts
  // 静态路径（build-api.d.ts / export / import）需在 :id 动态路由之前注册
  router.get('/build-api.d.ts', auth, controller.getBuildApiTypes);
  router.post('/export', auth, controller.exportWorkflows);
  router.post('/import', auth, upload.single('file'), controller.importWorkflows);

  router.post('/:id/execute', upload.any(), controller.execute);
  router.put('/:id/build-script', auth, controller.saveBuildScript);
  router.post('/:id/build/simulate', auth, controller.simulateBuild);
```

- [ ] **Step 5: 写路由集成测试**

在 `packages/server/src/routes/workflow.routes.test.ts` 的 `describe('Workflow API')` 内追加用例（复用该文件已有的 `app`、登录获取 `token` 的模式）：

```ts
  it('GET /api/workflows/build-api.d.ts returns d.ts text', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    const res = await supertest(app)
      .get('/api/workflows/build-api.d.ts')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('declare interface BuildContext');
  });

  it('PUT /api/workflows/:id/build-script saves script and enabled flag', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'build-flow', name: 'Build', rawJson: JSON.stringify({ '1': { inputs: { a: 1 }, class_type: 'Start' } }) });

    const res = await supertest(app)
      .put('/api/workflows/build-flow/build-script')
      .set('Authorization', `Bearer ${token}`)
      .send({ script: 'export default function build(ctx: any) { return ctx.workflow; }', enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.buildScript).toContain('export default');
    expect(res.body.buildScriptEnabled).toBe(true);

    const detail = await supertest(app)
      .get('/api/workflows/build-flow')
      .set('Authorization', `Bearer ${token}`);
    expect(detail.body.buildScriptEnabled).toBe(true);
  });

  it('POST /api/workflows/:id/build/simulate returns built json', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'sim-flow', name: 'Sim', rawJson: JSON.stringify({ '1': { inputs: { seed: 0 }, class_type: 'KSampler' } }) });

    const res = await supertest(app)
      .post('/api/workflows/sim-flow/build/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        script: `export default function build(ctx: any) { ctx.setInput('1', 'seed', 42); return ctx.workflow; }`,
        params: {},
      });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.json as string) as { '1': { inputs: { seed: number } } };
    expect(parsed['1'].inputs.seed).toBe(42);
  });

  it('POST simulate returns error for failing script', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'sim-bad', name: 'Bad', rawJson: '{}' });

    const res = await supertest(app)
      .post('/api/workflows/sim-bad/build/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({ script: `export default function build() { throw new Error('boom'); }`, params: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('build_script_error');
    expect(res.body.error).toContain('boom');
  });

  it('execute runs enabled build script before submitting', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    const rawJson = JSON.stringify({ '1': { inputs: { seed: 0 }, class_type: 'KSampler' } });
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'exec-flow', name: 'Exec', rawJson });
    await supertest(app)
      .put('/api/workflows/exec-flow/build-script')
      .set('Authorization', `Bearer ${token}`)
      .send({ script: `export default function build(ctx: any) { ctx.setInput('1', 'seed', 777); return ctx.workflow; }`, enabled: true });
    // 设置 ComfyUI base URL
    await supertest(app)
      .post('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'comfyui_base_url', value: 'http://localhost:9999' });

    const res = await supertest(app).post('/api/workflows/exec-flow/execute').send({});
    // 提交会失败（ComfyUI 不可达），但任务日志中应含脚本修改后的 seed
    expect(res.status).toBe(200);
    expect(['failed', 'queued']).toContain(res.body.status);
    const tasks = await supertest(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);
    const task = (tasks.body as Array<{ comfyuiRequestBody: string | null; status: string }>)
      .find((t) => (t.comfyuiRequestBody ?? '').includes('777'));
    expect(task).toBeTruthy();
  });

  it('execute with failing build script marks task failed without submitting', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'exec-bad', name: 'ExecBad', rawJson: '{}' });
    await supertest(app)
      .put('/api/workflows/exec-bad/build-script')
      .set('Authorization', `Bearer ${token}`)
      .send({ script: `export default function build() { throw new Error('broken'); }`, enabled: true });
    await supertest(app)
      .post('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'comfyui_base_url', value: 'http://localhost:9999' });

    const res = await supertest(app).post('/api/workflows/exec-bad/execute').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    const tasks = await supertest(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);
    const task = (tasks.body as Array<{ workflowId: string; status: string; errorMessage: string }>)
      .find((t) => t.workflowId === 'exec-bad');
    expect(task?.status).toBe('failed');
    expect(task?.errorMessage).toContain('Dynamic build failed');
    expect(task?.errorMessage).toContain('broken');
  });
```

（若该测试文件没有挂载 `/api/tasks` 路由，则在 beforeAll 的 app 上追加 `app.use('/api/tasks', createTaskRoutes(db));` 并 import `createTaskRoutes`。execute 会真实尝试请求 `http://localhost:9999/prompt` 并失败，因此 status 为 failed 且 comfyuiRequestBody 已写入 DB，可被任务列表查到。）

- [ ] **Step 6: 运行路由测试**

Run: `pnpm --filter server exec vitest run src/routes/workflow.routes.test.ts`
Expected: 全部通过（含既有用例 + 新增 6 个用例）。

- [ ] **Step 7: 类型检查 + 全量测试**

Run: `pnpm --filter server exec tsc --noEmit`
Run: `pnpm --filter server test`
Expected: 全部通过。

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/controllers/workflow.controller.ts packages/server/src/routes/workflow.routes.ts packages/server/src/routes/workflow.routes.test.ts
git commit -m "feat: add build-script endpoints and integrate dynamic build into execute"
```

---

## Task 6: 前端类型 + API 封装

**Files:**
- Modify: `packages/client/src/types/index.ts`
- Modify: `packages/client/src/api/workflows.ts`

- [ ] **Step 1: 扩展 `types/index.ts`**

在 `WorkflowDetail` 接口中追加字段：

```ts
export interface WorkflowDetail extends Workflow {
  params: WorkflowParam[];
  /** 动态构建脚本源码 */
  buildScript: string;
  /** 是否启用动态构建 */
  buildScriptEnabled: boolean;
}
```

在文件末尾追加：

```ts
/**
 * 模拟构建结果
 */
export interface SimulateResult {
  /** 构建并应用参数后的最终工作流 JSON 字符串 */
  json: string;
}
```

- [ ] **Step 2: 扩展 `api/workflows.ts`**

在 `executeWorkflow` 函数之后追加（复用 `client` 与 `WorkflowDetail`、`SimulateResult`）：

```ts
/** 拉取动态构建脚本 API 类型声明（d.ts 文本） */
export async function getBuildApiTypes(): Promise<string> {
  const res = await client.get<string>('/workflows/build-api.d.ts');
  return res.data;
}

/**
 * 保存动态构建脚本与启用状态
 * @param workflowId 工作流 ID
 * @param data 脚本与启用状态
 * @returns 更新后的工作流详情
 */
export async function saveBuildScript(
  workflowId: string,
  data: { script: string; enabled: boolean },
): Promise<WorkflowDetail> {
  const res = await client.put<WorkflowDetail>(`/workflows/${workflowId}/build-script`, data);
  return res.data;
}

/**
 * 模拟构建：脚本 + 参数 → 构建后的最终 JSON
 * @param workflowId 工作流 ID
 * @param data 脚本源码与参数
 * @returns 模拟结果
 */
export async function simulateBuild(
  workflowId: string,
  data: { script: string; params: Record<string, unknown> },
): Promise<SimulateResult> {
  const res = await client.post<SimulateResult>(`/workflows/${workflowId}/build/simulate`, data);
  return res.data;
}
```

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/types/index.ts packages/client/src/api/workflows.ts
git commit -m "feat: add client types and api for dynamic workflow build"
```

---

## Task 7: 前端 Monaco 编辑页签

**Files:**
- Modify: `packages/client/package.json`（新增 monaco-editor 依赖）
- Create: `packages/client/src/components/build-script/monaco.ts`
- Create: `packages/client/src/components/build-script/BuildScriptEditor.vue`
- Modify: `packages/client/src/pages/WorkflowDetailPage.vue`

- [ ] **Step 1: 安装 monaco-editor**

Run: `pnpm --filter client add monaco-editor`
Expected: package.json 出现 `"monaco-editor": "^0.x"`。

- [ ] **Step 2: 创建 `monaco.ts`（worker 配置 + 类型注册）**

创建 `packages/client/src/components/build-script/monaco.ts`：

```ts
import * as monaco from 'monaco-editor';
import type { Environment } from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Vite worker 配置：Monaco 依赖 Web Worker 提供语法高亮与 TypeScript 语言服务
const env: Environment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'typescript' || label === 'javascript') {
      return new tsWorker();
    }
    return new editorWorker();
  },
};
(globalThis as unknown as { MonacoEnvironment?: Environment }).MonacoEnvironment = env;

/** 动态构建脚本 API 类型声明在编辑器中的文件名（同名覆盖） */
const BUILD_API_LIB_FILENAME = 'comfy-build-api.d.ts';

/**
 * 注册/更新动态构建脚本 API 类型声明到 Monaco（幂等，重复调用覆盖）。
 * @param dts 服务端下发的 d.ts 文本
 */
export function registerBuildApiTypes(dts: string): void {
  monaco.languages.typescript.typescriptDefaults.addExtraLib(dts, BUILD_API_LIB_FILENAME);
}

export { monaco };
```

- [ ] **Step 3: 创建 `BuildScriptEditor.vue`**

创建 `packages/client/src/components/build-script/BuildScriptEditor.vue`：

```vue
<template>
  <div>
    <!-- 工具栏 -->
    <div class="d-flex align-center ga-3 mb-2 flex-wrap">
      <v-switch
        v-model="enabled"
        label="启用动态构建"
        density="compact"
        hide-details
        color="primary"
      />
      <span class="text-caption text-grey">
        保存后需启用，才会在真实执行时运行脚本
      </span>
      <v-spacer />
      <v-btn size="small" variant="tonal" @click="insertTemplate">
        插入模板
      </v-btn>
      <v-btn size="small" variant="tonal" @click="resetToSaved">
        重置
      </v-btn>
      <v-btn
        color="primary"
        variant="flat"
        :loading="saving"
        :disabled="!dirty"
        @click="save"
      >
        保存
      </v-btn>
      <v-btn color="secondary" variant="flat" @click="simulateOpen = true">
        模拟构建
      </v-btn>
    </div>

    <!-- Monaco 编辑器 -->
    <div ref="editorHost" class="build-script-editor" />

    <!-- 未保存提示 -->
    <div v-if="dirty" class="text-caption text-warning mt-1">
      有未保存的更改
    </div>

    <!-- 模拟构建对话框 -->
    <BuildSimulateDialog
      v-model="simulateOpen"
      :workflow="workflow"
      :script="editorValue"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import type { WorkflowDetail } from '@/types';
import { getBuildApiTypes, saveBuildScript } from '@/api/workflows';
import { monaco, registerBuildApiTypes } from './monaco';
import { DEFAULT_BUILD_SCRIPT_TEMPLATE } from './buildScriptTemplate';
import BuildSimulateDialog from './BuildSimulateDialog.vue';

/** 组件 props：完整工作流详情（含 params 与 buildScript） */
const props = defineProps<{
  workflow: WorkflowDetail;
}>();

/** 组件事件：保存成功后上抛最新工作流详情 */
const emit = defineEmits<{
  saved: [workflow: WorkflowDetail];
}>();

/** 启用开关 */
const enabled = ref(props.workflow.buildScriptEnabled);
/** 编辑器当前内容 */
const editorValue = ref(props.workflow.buildScript);
/** 保存的脚本（用于重置与脏检查） */
const savedScript = ref(props.workflow.buildScript);
/** 是否有未保存更改 */
const dirty = ref(false);
/** 保存中 */
const saving = ref(false);
/** 模拟构建对话框开关 */
const simulateOpen = ref(false);

/** 编辑器宿主元素 */
const editorHost = ref<HTMLDivElement | null>(null);
/** Monaco 编辑器实例 */
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

/** 插入默认模板（追加到当前内容尾部） */
function insertTemplate(): void {
  if (!editor) return;
  const current = editor.getValue();
  const next = current.trim() === '' ? DEFAULT_BUILD_SCRIPT_TEMPLATE : `${current}\n\n${DEFAULT_BUILD_SCRIPT_TEMPLATE}`;
  editor.setValue(next);
  dirty.value = true;
}

/** 重置为已保存内容 */
function resetToSaved(): void {
  if (!editor) return;
  editor.setValue(savedScript.value);
  enabled.value = props.workflow.buildScriptEnabled;
  dirty.value = false;
}

/** 保存脚本与启用状态 */
async function save(): Promise<void> {
  if (!editor) return;
  saving.value = true;
  try {
    const updated = await saveBuildScript(props.workflow.id, {
      script: editor.getValue(),
      enabled: enabled.value,
    });
    savedScript.value = updated.buildScript;
    editorValue.value = updated.buildScript;
    dirty.value = false;
    emit('saved', updated);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  // 拉取并注册脚本 API 类型声明（服务端单一来源）
  try {
    const dts = await getBuildApiTypes();
    registerBuildApiTypes(dts);
  } catch {
    // 类型声明拉取失败不阻塞编辑（仅缺失提示）
  }

  if (!editorHost.value) return;
  editor = monaco.editor.create(editorHost.value, {
    value: props.workflow.buildScript,
    language: 'typescript',
    theme: 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    scrollBeyondLastLine: false,
    tabSize: 2,
  });
  editor.onDidChangeModelContent(() => {
    editorValue.value = editor?.getValue() ?? '';
    dirty.value = editorValue.value !== savedScript.value;
  });
});

onBeforeUnmount(() => {
  editor?.dispose();
  editor = null;
});

// 父组件刷新 workflow 后同步已保存脚本
watch(
  () => props.workflow.buildScript,
  (val) => {
    savedScript.value = val;
    if (editor && !dirty.value) {
      editor.setValue(val);
    }
  },
);
</script>

<style scoped>
.build-script-editor {
  width: 100%;
  height: 520px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  overflow: hidden;
}
</style>
```

- [ ] **Step 4: 创建 `buildScriptTemplate.ts`**

创建 `packages/client/src/components/build-script/buildScriptTemplate.ts`（内容与服务端 `DEFAULT_BUILD_SCRIPT_TEMPLATE` 保持一致）：

```ts
/**
 * 编辑器"默认导出模板"片段。
 * 与服务端 build-script-api.ts 中的 DEFAULT_BUILD_SCRIPT_TEMPLATE 保持一致。
 */
export const DEFAULT_BUILD_SCRIPT_TEMPLATE = `export default async function build(ctx: BuildContext): Promise<ComfyWorkflow> {
  const { workflow, params } = ctx;
  // 在这里根据 params 动态调整工作流。
  // 示例：
  // if (params.mode === 'upscale') {
  //   ctx.addNode('9', 'UpscaleModelLoader', { model_name: '4x-UltraSharp.pth' });
  //   ctx.connect('9', 0, '4', 'model');
  // }
  return workflow;
}
`;
```

- [ ] **Step 5: `WorkflowDetailPage.vue` 增加页签**

在 `<v-tab value="canvas">画布</v-tab>` 之后加：

```html
        <v-tab value="build">
          动态构建脚本
        </v-tab>
```

在 `<v-window-item value="config">` 之前加（画布 window item 之后）：

```html
        <v-window-item value="build">
          <v-card-text>
            <!-- 仅 Build 页签激活时挂载编辑器，避免隐藏挂载的布局问题 -->
            <BuildScriptEditor
              v-if="workflow && section === 'build'"
              :workflow="workflow"
              @saved="handleBuildScriptSaved"
            />
          </v-card-text>
        </v-window-item>
```

`<script setup>` 中 import 区加：

```ts
import BuildScriptEditor from '@/components/build-script/BuildScriptEditor.vue';
```

并新增处理函数（放在 `clearAllOrphans` 附近）：

```ts
/**
 * 动态构建脚本保存成功后刷新本地工作流
 * @param updated 保存返回的最新工作流详情
 */
function handleBuildScriptSaved(updated: WorkflowDetail): void {
  workflow.value = updated;
}
```

（`WorkflowDetail` 类型已 import，无需额外引入。）

- [ ] **Step 6: 类型检查**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 通过（Monaco 的 `?worker` 由 vite/client 类型声明支持）。

- [ ] **Step 7: 构建验证（可选但建议）**

Run: `pnpm --filter client build`
Expected: `vue-tsc --noEmit && vite build` 均通过。

- [ ] **Step 8: Commit**

```bash
git add packages/client/package.json packages/client/src/components/build-script packages/client/src/pages/WorkflowDetailPage.vue
git commit -m "feat: add Monaco build script editor tab to workflow detail"
```

---

## Task 8: 前端模拟构建对话框

**Files:**
- Create: `packages/client/src/components/build-script/BuildSimulateDialog.vue`
- Modify: `packages/client/src/pages/WorkflowDetailPage.vue`（无需改，BuildScriptEditor 已引用）

- [ ] **Step 1: 创建 `BuildSimulateDialog.vue`**

创建 `packages/client/src/components/build-script/BuildSimulateDialog.vue`：

```vue
<template>
  <v-dialog v-model="show" max-width="980">
    <v-card>
      <v-card-title>模拟构建</v-card-title>
      <v-card-text>
        <!-- 步骤 1：填写参数 -->
        <template v-if="step === 1">
          <p class="text-body-2 text-grey mb-3">
            填写本次构建使用的参数，脚本会基于这些参数动态调整工作流。
          </p>

          <div v-for="p in aliasParams" :key="p.id" class="mb-3">
            <v-switch
              v-if="p.paramType === 'boolean'"
              v-model="booleanValues[p.alias!]"
              :label="paramLabel(p)"
              density="compact"
              hide-details
              color="primary"
            />
            <v-text-field
              v-else
              v-model="stringValues[p.alias!]"
              :label="paramLabel(p)"
              :type="p.paramType === 'number' ? 'number' : 'text'"
              density="compact"
              variant="outlined"
              hide-details
            />
          </div>

          <v-divider class="my-3" />

          <div class="d-flex align-center mb-2">
            <span class="text-subtitle-2">自定义字段</span>
            <v-spacer />
            <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addFreeField">
              添加自定义字段
            </v-btn>
          </div>
          <div
            v-for="(f, i) in freeFields"
            :key="i"
            class="d-flex align-center ga-2 mb-2"
          >
            <v-text-field
              v-model="f.key"
              label="字段名"
              density="compact"
              variant="outlined"
              hide-details
              style="max-width: 220px"
            />
            <v-select
              v-model="f.type"
              :items="['text', 'number', 'boolean']"
              label="类型"
              density="compact"
              variant="outlined"
              hide-details
              style="max-width: 130px"
            />
            <v-text-field
              v-model="f.value"
              label="值"
              density="compact"
              variant="outlined"
              hide-details
            />
            <v-btn icon="mdi-close" size="small" variant="text" @click="freeFields.splice(i, 1)" />
          </div>
        </template>

        <!-- 步骤 2：模拟结果 -->
        <template v-else>
          <v-alert
            v-if="errorText"
            type="error"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            <pre class="text-caption ma-0" style="white-space: pre-wrap">{{ errorText }}</pre>
          </v-alert>

          <template v-else>
            <v-tabs v-model="resultTab" color="primary">
              <v-tab value="table">节点与参数表</v-tab>
              <v-tab value="canvas">画布</v-tab>
              <v-tab value="json">JSON</v-tab>
            </v-tabs>

            <v-window v-model="resultTab" class="mt-3">
              <v-window-item value="table">
                <v-table v-if="graphNodes.length > 0">
                  <thead>
                    <tr>
                      <th>节点 ID</th>
                      <th>节点标题</th>
                      <th>字段名</th>
                      <th>值</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="node in graphNodes" :key="node.id">
                      <tr v-for="(input, fi) in node.inputs" :key="fi">
                        <td>{{ node.id }}</td>
                        <td>{{ node.title }}</td>
                        <td>{{ input.name }}</td>
                        <td class="text-caption">
                          <span v-if="input.connected">连线 → {{ input.source }}[{{ input.sourceSlot }}]</span>
                          <span v-else>{{ input.displayValue ?? '-' }}</span>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </v-table>
                <p v-else class="text-grey text-center py-4 ma-0">
                  构建结果中没有可展示的节点
                </p>
              </v-window-item>

              <v-window-item value="canvas">
                <WorkflowCanvas
                  v-if="builtJson"
                  :raw-json="builtJson"
                  :height="'460px'"
                />
              </v-window-item>

              <v-window-item value="json">
                <v-textarea
                  :model-value="formattedJson"
                  readonly
                  rows="16"
                  variant="outlined"
                  class="mb-2"
                />
                <v-btn color="primary" variant="tonal" @click="downloadJson">
                  下载 JSON
                </v-btn>
              </v-window-item>
            </v-window>
          </template>
        </template>
      </v-card-text>

      <v-card-actions>
        <v-btn v-if="step === 2" variant="text" @click="step = 1">
          返回修改参数
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="close">
          关闭
        </v-btn>
        <v-btn
          v-if="step === 1"
          color="primary"
          variant="flat"
          :loading="simulating"
          @click="runSimulate"
        >
          开始模拟
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WorkflowDetail, WorkflowParam } from '@/types';
import { simulateBuild } from '@/api/workflows';
import { parseWorkflowGraph, type GraphNode } from '../workflow-canvas/workflowGraph';
import WorkflowCanvas from '../workflow-canvas/WorkflowCanvas.vue';

/** 对话框显示控制（v-model） */
const show = defineModel<boolean>({ required: true });

/** 组件 props：工作流详情与当前脚本内容 */
const props = defineProps<{
  workflow: WorkflowDetail;
  script: string;
}>();

/** 当前步骤：1=填写参数，2=模拟结果 */
const step = ref<1 | 2>(1);
/** 模拟请求中 */
const simulating = ref(false);
/** 模拟错误信息 */
const errorText = ref('');
/** 构建后的 JSON 字符串 */
const builtJson = ref('');
/** 结果视图 tab */
const resultTab = ref('table');

/** 可传参的别名参数（alias 非空） */
const aliasParams = computed<WorkflowParam[]>(() =>
  props.workflow.params.filter((p) => p.alias != null && p.alias !== ''),
);

/** 文本/数字参数值（key 为别名） */
const stringValues = ref<Record<string, string>>({});

/** 布尔参数值（key 为别名） */
const booleanValues = ref<Record<string, boolean>>({});

/** 自定义自由字段行 */
interface FreeField {
  key: string;
  type: string;
  value: string;
}
const freeFields = ref<FreeField[]>([]);

/** 参数展示标签：别名 + 可选 label */
function paramLabel(p: WorkflowParam): string {
  return p.label ? `${p.alias}（${p.label}）` : (p.alias ?? '');
}

/** 添加一行自定义字段 */
function addFreeField(): void {
  freeFields.value.push({ key: '', type: 'text', value: '' });
}

/** 关闭对话框并复位 */
function close(): void {
  show.value = false;
  step.value = 1;
  errorText.value = '';
  builtJson.value = '';
  resultTab.value = 'table';
}

/** 组装请求参数（含类型转换） */
function buildParams(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const p of aliasParams.value) {
    if (!p.alias) continue;
    if (p.paramType === 'boolean') {
      result[p.alias] = booleanValues.value[p.alias] ?? false;
    } else if (p.paramType === 'number') {
      const v = stringValues.value[p.alias] ?? '';
      result[p.alias] = v === '' ? '' : Number(v);
    } else {
      result[p.alias] = stringValues.value[p.alias] ?? '';
    }
  }
  for (const f of freeFields.value) {
    const key = f.key.trim();
    if (!key) continue;
    if (f.type === 'boolean') {
      result[key] = f.value === 'true' || f.value === '1';
    } else if (f.type === 'number') {
      result[key] = f.value === '' ? '' : Number(f.value);
    } else {
      result[key] = f.value;
    }
  }
  return result;
}

/** 执行模拟构建 */
async function runSimulate(): Promise<void> {
  simulating.value = true;
  errorText.value = '';
  try {
    const res = await simulateBuild(props.workflow.id, {
      script: props.script,
      params: buildParams(),
    });
    builtJson.value = res.json;
    step.value = 2;
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err);
    step.value = 2;
  } finally {
    simulating.value = false;
  }
}

/** 格式化 JSON 展示 */
const formattedJson = computed(() => {
  try {
    return JSON.stringify(JSON.parse(builtJson.value), null, 2);
  } catch {
    return builtJson.value;
  }
});

/** 节点表数据：解析构建后的 JSON */
const graphNodes = computed<GraphNode[]>(() => {
  if (!builtJson.value) return [];
  const parsed = parseWorkflowGraph(builtJson.value);
  return parsed.ok ? parsed.nodes : [];
});

/** 下载构建结果 JSON */
function downloadJson(): void {
  const blob = new Blob([formattedJson.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `workflow-${props.workflow.id}-build.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 打开对话框时用已保存别名初始化参数值（仅初始化一次）
watch(show, (val) => {
  if (val) {
    stringValues.value = {};
    booleanValues.value = {};
    for (const p of aliasParams.value) {
      if (!p.alias) continue;
      if (p.paramType === 'boolean') {
        booleanValues.value[p.alias] = false;
      } else {
        stringValues.value[p.alias] = '';
      }
    }
    freeFields.value = [];
    step.value = 1;
    errorText.value = '';
    builtJson.value = '';
    resultTab.value = 'table';
  }
});
</script>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: 前端构建**

Run: `pnpm --filter client build`
Expected: 通过。

- [ ] **Step 4: 手动验证要点（开发服务器）**

Run: `pnpm dev:server` 与 `pnpm dev:client`，浏览器打开工作流详情页：
1. "动态构建脚本" 页签出现，Monaco 编辑器可输入，`BuildContext` 有类型提示
2. 点"插入模板"插入默认模板；点"保存"后刷新页面脚本仍在
3. 点"模拟构建"：填写参数 + 添加自定义字段 → "开始模拟" → 结果页签切换节点表/画布/JSON，JSON 可下载
4. 打开"启用动态构建"开关并保存，从列表页执行该工作流，任务日志失败时错误信息含 `Dynamic build failed`

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/build-script/BuildSimulateDialog.vue
git commit -m "feat: add build simulate dialog with node table, canvas and json views"
```

---

## Task 9: 全量验证与回归

**Files:**
- 无新增

- [ ] **Step 1: 后端类型检查 + 全量测试**

Run: `pnpm --filter server exec tsc --noEmit`
Run: `pnpm --filter server test`
Expected: 全部通过，无新增失败。

- [ ] **Step 2: 前端类型检查 + 构建**

Run: `pnpm --filter client exec tsc --noEmit`
Run: `pnpm --filter client build`
Expected: 全部通过。

- [ ] **Step 3: 端到端手工冒烟（若环境可用）**

1. 用 `example/text_to_image.json` 导入一个工作流
2. 编写脚本：根据 `params.mode` 切换 `seed` 或插入节点，模拟构建验证三视图
3. 启用脚本并执行，确认任务日志中 `comfyuiRequestBody` 为脚本构建后的 JSON（ComfyUI 不可达时任务 failed 但 request body 已落库）
4. 脚本报错时执行，任务 failed 且错误信息含 `Dynamic build failed`

- [ ] **Step 4: 最终 Commit（如有遗漏变更）**

```bash
git status
git add -A
git commit -m "chore: finalize dynamic workflow build feature"
```

---

## 参考

- 设计文档：`docs/superpowers/specs/2026-08-01-dynamic-workflow-build-design.md`
- 既有模式参考：`workflow.controller.ts` 的 `execute`、`workflow.routes.test.ts` 的集成测试结构、`WorkflowCanvas.vue` 与 `workflowGraph.ts` 的复用
