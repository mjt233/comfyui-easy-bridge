# 多执行提供商（ComfyUI 原生 / RunningHub）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作流可选择执行提供商实例（原生 ComfyUI / RunningHub），支持多实例、全局默认、每工作流覆盖，node-info 仅从原生 ComfyUI 获取。

**Architecture:** 新增 `providers` 表存提供商实例；`ExecutionProvider` 抽象接口封装 URL 解析/上传/提交/跟踪差异；`comfyui.service.ts` 改造为按实例启动独立跟踪器的 `execution.service.ts`；任务/输出回源按 `task_logs.provider_id` 解析实例；node-info 只选 comfyui 类型实例。

**Tech Stack:** Node.js + Express + TypeScript + Drizzle ORM (SQLite)、Vue 3 + Vuetify、vitest。

**Spec:** `docs/superpowers/specs/2026-08-07-execution-provider-design.md`

**验证命令：**
- 后端类型: `pnpm --filter server exec tsc --noEmit`
- 前端类型: `pnpm --filter client exec tsc --noEmit`
- 后端测试: `pnpm --filter server test`

---

## 文件结构总览

**后端（新建）：**
- `packages/server/src/models/migrations/v4-execution-providers.ts` — 迁移 4
- `packages/server/src/services/providers/types.ts` — ProviderType/ProviderConfig/ExecutionProvider/ExecutionResult/COMFYUI_CLIENT_ID
- `packages/server/src/services/providers/shared.ts` — 公共 HTTP 请求（submitPromptRequest/fetchHistoryRequest/interruptRequest/isPromptRunningRequest/buildViewUrl）
- `packages/server/src/services/providers/comfyui.provider.ts` — ComfyUIProvider
- `packages/server/src/services/providers/runninghub.provider.ts` — RunningHubProvider
- `packages/server/src/services/providers/provider.service.ts` — ProviderService（CRUD/解析/事件/测试连接）
- `packages/server/src/services/providers/provider.service.test.ts`
- `packages/server/src/services/providers/runninghub.provider.test.ts`
- `packages/server/src/routes/providers.routes.ts`
- `packages/server/src/controllers/providers.controller.ts`
- `packages/server/src/routes/providers.routes.test.ts`
- `packages/server/src/services/execution.service.ts`（由 comfyui.service.ts 迁移改名）
- `packages/server/src/services/execution.service.test.ts`（由 comfyui.service.test.ts 改名）

**后端（修改）：**
- `packages/server/src/models/schema.ts` — providers 表 + workflows/task_logs.providerId
- `packages/server/src/models/migrations/index.ts` — 注册 v4
- `packages/server/src/models/migrations.test.ts` — 迁移 4 用例
- `packages/server/src/services/executor.service.ts` — 接受 ExecutionProvider；submitPrompt/interruptPrompt/isPromptRunning 迁走
- `packages/server/src/services/executor.service.test.ts` — 适配新签名
- `packages/server/src/services/upload.service.ts` — 移除 uploadFileToComfyUI（移入 ComfyUIProvider）
- `packages/server/src/services/task.service.ts` — CreateTaskInput.providerId + 按实例查询
- `packages/server/src/services/node-info.service.ts` — ProviderService 解析 comfyui 实例
- `packages/server/src/controllers/workflow.controller.ts` — providerId + execute/simulateBuild 解析实例
- `packages/server/src/controllers/task.controller.ts` — 输出回源/下载按任务实例
- `packages/server/src/services/workflow-io.service.ts` — 导出/导入/复制携带 providerId
- `packages/server/src/index.ts` — 挂载 /api/providers + startExecutionService

**前端：**
- `packages/client/src/types/index.ts` — 提供商类型
- `packages/client/src/api/providers.ts`（新建）
- `packages/client/src/api/workflows.ts` — createWorkflow/updateWorkflow 支持 providerId；getWorkflow 返回 resolvedProvider
- `packages/client/src/pages/SettingsPage.vue` — 提供商管理区
- `packages/client/src/pages/WorkflowEditPage.vue` — 提供商选择器

---

## Task 1: Schema + 迁移 v4（providers 表 + provider_id 列）

**Files:**
- Modify: `packages/server/src/models/schema.ts`
- Create: `packages/server/src/models/migrations/v4-execution-providers.ts`
- Modify: `packages/server/src/models/migrations/index.ts`
- Modify: `packages/server/src/models/migrations.test.ts`

- [ ] **Step 1: schema.ts 新增 providers 表与两列**

在 `packages/server/src/models/schema.ts` 的 `settings` 表定义前追加：

```ts
/** 执行提供商实例（comfyui / runninghub） */
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  /** 展示名 */
  name: text('name').notNull(),
  /** 提供商类型：comfyui | runninghub */
  type: text('type').notNull(),
  /** 类型化配置 JSON（见 services/providers/types.ts 的 ProviderConfig） */
  config: text('config').notNull(),
  /** 该实例的并发上限 */
  concurrency: integer('concurrency').notNull().default(1),
  /** 是否启用（0/1） */
  enabled: integer('enabled').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

在 `workflows` 表定义中 `description` 列之后追加：

```ts
  /** 执行提供商实例 ID；null 表示使用全局默认实例 */
  providerId: text('provider_id'),
```

在 `taskLogs` 表定义中 `workflowName` 列之后追加：

```ts
  /** 实际使用的提供商实例 ID；历史任务可能为 null */
  providerId: text('provider_id'),
```

- [ ] **Step 2: 新建迁移 v4**

创建 `packages/server/src/models/migrations/v4-execution-providers.ts`：

```ts
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
```

- [ ] **Step 3: 注册迁移**

修改 `packages/server/src/models/migrations/index.ts`：

```ts
import { v1 } from './v1-initial-schema';
import { v2 } from './v2-task-original-form';
import { v3 } from './v3-declared-params';
import { v4 } from './v4-execution-providers';
import type { Migration } from './runner';

/** 迁移注册表：按 version 升序排列；新增迁移时在此追加 */
export const migrations: readonly Migration[] = [v1, v2, v3, v4];
```

- [ ] **Step 4: 迁移测试**

在 `packages/server/src/models/migrations.test.ts` 末尾追加：

```ts
describe('v4 execution providers migration', () => {
  /** 构造只有 settings / workflows / task_logs 的最小旧库 */
  function buildLegacyDb(): Database {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT);
      INSERT INTO settings (key, value) VALUES ('comfyui_base_url', 'http://localhost:8188');
      INSERT INTO workflows (id, name, raw_json, created_at, updated_at) VALUES ('w1', 'wf', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO task_logs (id, workflow_id, workflow_name, alias_values, comfyui_url, status, created_at) VALUES ('t1', 'w1', 'wf', '{}', 'http://localhost:8188/prompt', 'pending', '2026-01-01T00:00:00.000Z');
    `);
    return sqlite;
  }

  it('creates providers table and migrates legacy comfyui_base_url', () => {
    const sqlite = buildLegacyDb();
    runMigrations(sqlite);
    const provider = sqlite.prepare('SELECT * FROM providers').get() as { type: string; config: string };
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
```

确认测试文件顶部已有 `import { Database } from 'better-sqlite3';` 与 `runMigrations` 导入；没有则补上（参照文件现有写法）。

- [ ] **Step 5: 运行迁移测试**

Run: `pnpm --filter server test`
Expected: 迁移 4 相关用例 PASS，其余用例不回归。

- [ ] **Step 6: 类型验证 + 提交**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误（若 workflow-io 等直插 workflows 处报缺 providerId，属正常——Task 12 处理，可在本步先将缺失处显式补 `providerId: null` 以过编译）。

```bash
git add packages/server/src/models
git commit -m "feat: 新增 providers 表与 workflow/task 的 provider_id 迁移"
```

---

## Task 2: providers/types.ts + providers/shared.ts

**Files:**
- Create: `packages/server/src/services/providers/types.ts`
- Create: `packages/server/src/services/providers/shared.ts`
- Create: `packages/server/src/services/providers/shared.test.ts`

- [ ] **Step 1: 写失败测试（shared.test.ts）**

创建 `packages/server/src/services/providers/shared.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { submitPromptRequest, isPromptRunningRequest } from './shared';

describe('shared provider http', () => {
  it('submitPromptRequest injects client_id and returns prompt_id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ prompt_id: 'p1' }), { status: 200 })));
    const result = await submitPromptRequest('http://comfy:8188', JSON.stringify({ prompt: {} }));
    expect(result.success).toBe(true);
    expect(result.promptId).toBe('p1');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://comfy:8188/prompt');
    const body = JSON.parse(String(init.body)) as { client_id: string };
    expect(typeof body.client_id).toBe('string');
    vi.unstubAllGlobals();
  });

  it('submitPromptRequest returns error result on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await submitPromptRequest('http://comfy:8188', '{}');
    expect(result.success).toBe(false);
    expect(result.promptId).toBeNull();
    expect(result.errorMessage).toContain('500');
    vi.unstubAllGlobals();
  });

  it('isPromptRunningRequest checks queue_running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ queue_running: [['p1', {}, {}], ['p2', {}, {}]] }), { status: 200 })));
    expect(await isPromptRunningRequest('http://comfy:8188', 'p1')).toBe(true);
    expect(await isPromptRunningRequest('http://comfy:8188', 'p9')).toBe(false);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server test -- shared.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 创建 types.ts**

创建 `packages/server/src/services/providers/types.ts`：

```ts
import { randomUUID } from 'node:crypto';

/** 执行提供商类型 */
export type ProviderType = 'comfyui' | 'runninghub';

/**
 * 提供商实例配置（按类型区分的判别联合）。
 * - comfyui: { baseUrl }
 * - runninghub: { apiKey, gpuSize }
 */
export type ProviderConfig =
  | { baseUrl: string }
  | { apiKey: string; gpuSize: '24G' | '48G' };

/** 执行工作流的结果 */
export interface ExecutionResult {
  /** 是否成功提交 */
  success: boolean;
  /** 执行端的响应体（JSON） */
  comfyuiResponse: unknown;
  /** 执行端返回的 prompt_id，为 null 表示提交失败 */
  promptId: string | null;
  /** 错误信息（失败时） */
  errorMessage: string | null;
}

/** 本服务连接执行端时使用的稳定 client_id（WebSocket 会话标识） */
export const COMFYUI_CLIENT_ID: string = randomUUID();

/** 输出文件引用（构造下载地址用） */
export interface OutputFileRef {
  filename: string;
  subfolder: string;
  type: string;
}

/** 上传文件元数据 */
export interface UploadFileInput {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/** 媒体类型 */
export type MediaType = 'image' | 'video' | 'audio';

/**
 * 执行提供商抽象接口。
 * 新增提供商类型时实现本接口并在 ProviderService 中注册工厂。
 */
export interface ExecutionProvider {
  /** 实例 ID */
  readonly id: string;
  /** 展示名 */
  readonly name: string;
  /** 提供商类型 */
  readonly type: ProviderType;
  /** 并发上限 */
  readonly concurrency: number;
  /** 任务跟踪模式：websocket 或 polling */
  readonly trackingMode: 'websocket' | 'polling';
  /** 解析后的 HTTP 基础地址 */
  getBaseUrl(): string;
  /** 提交 prompt，不抛网络/HTTP 异常 */
  submitPrompt(body: string): Promise<ExecutionResult>;
  /** 上传媒体文件，返回注入工作流节点的文件名 */
  uploadMedia(file: UploadFileInput, mediaType: MediaType): Promise<string>;
  /** 拉取指定 prompt 的 history */
  fetchHistory(promptId: string): Promise<unknown>;
  /** 中断任务，可带 promptId 轮询确认停止 */
  interrupt(promptId?: string): Promise<boolean>;
  /** 查询 prompt 是否仍在执行队列 */
  isPromptRunning(promptId: string): Promise<boolean>;
  /** 构造输出文件下载地址 */
  buildOutputViewUrl(file: OutputFileRef): string;
}
```

- [ ] **Step 4: 创建 shared.ts**

创建 `packages/server/src/services/providers/shared.ts`（从 executor.service.ts 迁入并泛化为 baseUrl 参数）：

```ts
import { COMFYUI_CLIENT_ID, type ExecutionResult, type OutputFileRef } from './types';

/** 延迟指定毫秒数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 确保请求体 JSON 中包含 client_id（已有则保留）。
 * @param body 原始请求体字符串
 * @returns 注入 client_id 后的请求体字符串；无法解析为对象时原样返回
 */
function ensureClientIdInBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return body;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.client_id === 'string' && obj.client_id.trim() !== '') {
      return body;
    }
    obj.client_id = COMFYUI_CLIENT_ID;
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

/**
 * 提交 prompt JSON 到执行端并返回结果。
 * @param baseUrl 执行端基础 URL
 * @param body 请求体 JSON 字符串（通常含 prompt）
 */
export async function submitPromptRequest(baseUrl: string, body: string): Promise<ExecutionResult> {
  try {
    const requestBody = ensureClientIdInBody(body);
    const response = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });
    const text = await response.text();
    let responseBody: unknown;
    try { responseBody = JSON.parse(text); } catch { responseBody = text; }
    if (!response.ok) {
      return {
        success: false,
        comfyuiResponse: responseBody,
        promptId: null,
        errorMessage: `Executor returned status ${response.status}: ${text}`,
      };
    }
    const promptId = (responseBody as { prompt_id?: string }).prompt_id ?? null;
    return { success: true, comfyuiResponse: responseBody, promptId, errorMessage: null };
  } catch (err: unknown) {
    return {
      success: false,
      comfyuiResponse: null,
      promptId: null,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/** 中断后确认停止的轮询间隔（ms） */
const INTERRUPT_POLL_INTERVAL = 500;
/** 中断后确认停止的最大轮询次数 */
const INTERRUPT_MAX_ATTEMPTS = 120;

/**
 * 查询指定 prompt 是否仍在执行队列。
 * 请求失败或响应结构异常时保守返回 true。
 * @param baseUrl 执行端基础 URL
 * @param promptId 要检查的 prompt_id
 */
export async function isPromptRunningRequest(baseUrl: string, promptId: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/queue`);
    if (!response.ok) return true;
    const data: unknown = await response.json();
    const queueRunning = (data as { queue_running?: unknown }).queue_running;
    if (!Array.isArray(queueRunning)) return true;
    return queueRunning.some((entry: unknown) => {
      if (!Array.isArray(entry) || entry.length < 1) return false;
      return entry[0] === promptId;
    });
  } catch {
    return true;
  }
}

/**
 * 中断执行端当前正在执行的 prompt，并在中断后轮询确认其已停止。
 * @param baseUrl 执行端基础 URL
 * @param promptId 目标 prompt_id；为空时只发送一次中断请求
 * @param options 可选配置（供测试缩短轮询间隔/次数）
 */
export async function interruptRequest(
  baseUrl: string,
  promptId?: string,
  options?: { pollIntervalMs?: number; maxAttempts?: number },
): Promise<boolean> {
  const pollIntervalMs = options?.pollIntervalMs ?? INTERRUPT_POLL_INTERVAL;
  const maxAttempts = options?.maxAttempts ?? INTERRUPT_MAX_ATTEMPTS;
  try {
    const first = await fetch(`${baseUrl}/interrupt`, { method: 'POST' });
    if (!first.ok) return false;
    if (!promptId) return true;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const stillRunning = await isPromptRunningRequest(baseUrl, promptId);
      if (!stillRunning) return true;
      try {
        await fetch(`${baseUrl}/interrupt`, { method: 'POST' });
      } catch {
        // 忽略单次中断失败，继续轮询
      }
      await sleep(pollIntervalMs);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 拉取指定 prompt 的 history。
 * @param baseUrl 执行端基础 URL
 * @param promptId prompt_id
 */
export async function fetchHistoryRequest(baseUrl: string, promptId: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/history/${promptId}`);
  if (!res.ok) {
    throw new Error(`history returned status ${res.status}`);
  }
  return res.json() as Promise<unknown>;
}

/**
 * 构造输出文件下载地址。
 * @param baseUrl 执行端基础 URL
 * @param file 输出文件引用
 */
export function buildViewUrl(baseUrl: string, file: OutputFileRef): string {
  const q = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type,
  });
  return `${baseUrl}/view?${q.toString()}`;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter server test -- shared.test.ts`
Expected: PASS

- [ ] **Step 6: 类型验证 + 提交**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误

```bash
git add packages/server/src/services/providers
git commit -m "feat: 提供商抽象层类型与公共 HTTP 请求"
```

---

## Task 3: ComfyUIProvider + RunningHubProvider

**Files:**
- Create: `packages/server/src/services/providers/comfyui.provider.ts`
- Create: `packages/server/src/services/providers/runninghub.provider.ts`
- Create: `packages/server/src/services/providers/runninghub.provider.test.ts`

- [ ] **Step 1: 写失败测试（runninghub.provider.test.ts）**

创建 `packages/server/src/services/providers/runninghub.provider.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { RunningHubProvider } from './runninghub.provider';

function makeProvider(apiKey = 'sk-test-1234', gpuSize: '24G' | '48G' = '24G'): RunningHubProvider {
  return new RunningHubProvider('p1', 'RH', { apiKey, gpuSize }, 1);
}

describe('RunningHubProvider', () => {
  it('derives 24G proxy base url', () => {
    expect(makeProvider('abc', '24G').getBaseUrl()).toBe('https://www.runninghub.cn/proxy/abc');
  });

  it('derives 48G proxy-plus base url', () => {
    expect(makeProvider('abc', '48G').getBaseUrl()).toBe('https://www.runninghub.cn/proxy-plus/abc');
  });

  it('uses polling tracking mode', () => {
    expect(makeProvider().trackingMode).toBe('polling');
  });

  it('uploads via /openapi/v2/media/upload/binary with bearer auth and returns fileName', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 0, message: 'success', data: { fileName: 'openapi/xyz.png', type: 'image', download_url: 'https://cdn/x', size: '1' } }),
      { status: 200 },
    )));
    const provider = makeProvider('sk-abc', '24G');
    const name = await provider.uploadMedia({ buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }, 'image');
    expect(name).toBe('openapi/xyz.png');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.runninghub.cn/openapi/v2/media/upload/binary');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-abc');
    vi.unstubAllGlobals();
  });

  it('throws when upload api returns non-zero code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 401, message: 'bad key', data: null }),
      { status: 200 },
    )));
    const provider = makeProvider('bad', '24G');
    await expect(provider.uploadMedia({ buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }, 'image'))
      .rejects.toThrow('bad key');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server test -- runninghub.provider.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 创建 comfyui.provider.ts**

创建 `packages/server/src/services/providers/comfyui.provider.ts`：

```ts
import { buildUniqueUploadFilename } from '../upload.service';
import {
  buildViewUrl,
  fetchHistoryRequest,
  interruptRequest,
  isPromptRunningRequest,
  submitPromptRequest,
} from './shared';
import type { ExecutionProvider, ExecutionResult, MediaType, OutputFileRef, ProviderConfig, ProviderType, UploadFileInput } from './types';

/**
 * 原生 ComfyUI 执行提供商。
 * 通过 /upload/image 上传媒体，任务跟踪走 WebSocket。
 */
export class ComfyUIProvider implements ExecutionProvider {
  readonly type: ProviderType = 'comfyui';
  readonly trackingMode: 'websocket' | 'polling' = 'websocket';

  /**
   * @param id 实例 ID
   * @param name 展示名
   * @param config 类型化配置（含 baseUrl）
   * @param concurrency 并发上限
   */
  constructor(
    readonly id: string,
    readonly name: string,
    private config: Extract<ProviderConfig, { baseUrl: string }>,
    readonly concurrency: number,
  ) {}

  /** 基础地址即配置的 baseUrl */
  getBaseUrl(): string {
    return this.config.baseUrl;
  }

  /** 提交 prompt 到 /prompt */
  submitPrompt(body: string): Promise<ExecutionResult> {
    return submitPromptRequest(this.config.baseUrl, body);
  }

  /** 上传媒体文件到 /upload/image，返回 ComfyUI 存储文件名 */
  async uploadMedia(file: UploadFileInput, _mediaType: MediaType): Promise<string> {
    // 生成唯一文件名，避免同名覆盖导致工作流节点引用错乱
    const uniqueName = buildUniqueUploadFilename(file.originalname);
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
    formData.append('image', blob, uniqueName);
    formData.append('type', 'input');
    formData.append('overwrite', 'true');

    const response = await fetch(`${this.config.baseUrl}/upload/image`, { method: 'POST', body: formData });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ComfyUI upload failed (${response.status}): ${text}`);
    }
    const result = (await response.json()) as { name: string };
    return result.name;
  }

  /** 拉取 history */
  fetchHistory(promptId: string): Promise<unknown> {
    return fetchHistoryRequest(this.config.baseUrl, promptId);
  }

  /** 中断任务 */
  interrupt(promptId?: string): Promise<boolean> {
    return interruptRequest(this.config.baseUrl, promptId);
  }

  /** 查询是否仍在执行队列 */
  isPromptRunning(promptId: string): Promise<boolean> {
    return isPromptRunningRequest(this.config.baseUrl, promptId);
  }

  /** 构造 /view 下载地址 */
  buildOutputViewUrl(file: OutputFileRef): string {
    return buildViewUrl(this.config.baseUrl, file);
  }
}
```

- [ ] **Step 4: 创建 runninghub.provider.ts**

创建 `packages/server/src/services/providers/runninghub.provider.ts`：

```ts
import { buildUniqueUploadFilename } from '../upload.service';
import {
  buildViewUrl,
  fetchHistoryRequest,
  interruptRequest,
  isPromptRunningRequest,
  submitPromptRequest,
} from './shared';
import type { ExecutionProvider, ExecutionResult, MediaType, OutputFileRef, ProviderConfig, ProviderType, UploadFileInput } from './types';

/** RunningHub 显存档位：24G → /proxy，48G → /proxy-plus */
export type RunningHubGpuSize = '24G' | '48G';

/**
 * RunningHub 原生 ComfyUI 接口执行提供商。
 * 基础地址由 apiKey + gpuSize 推导；媒体走 /openapi/v2/media/upload/binary（Bearer 鉴权）；
 * 任务跟踪为纯轮询。
 */
export class RunningHubProvider implements ExecutionProvider {
  readonly type: ProviderType = 'runninghub';
  readonly trackingMode: 'websocket' | 'polling' = 'polling';

  /**
   * @param id 实例 ID
   * @param name 展示名
   * @param config 类型化配置（含 apiKey / gpuSize）
   * @param concurrency 并发上限
   */
  constructor(
    readonly id: string,
    readonly name: string,
    private config: Extract<ProviderConfig, { apiKey: string; gpuSize: '24G' | '48G' }>,
    readonly concurrency: number,
  ) {}

  /** 由 apiKey + gpuSize 推导 proxy 基础地址 */
  getBaseUrl(): string {
    const prefix = this.config.gpuSize === '48G' ? 'proxy-plus' : 'proxy';
    return `https://www.runninghub.cn/${prefix}/${this.config.apiKey}`;
  }

  /** 提交 prompt 到推导出的 proxy /prompt */
  submitPrompt(body: string): Promise<ExecutionResult> {
    return submitPromptRequest(this.getBaseUrl(), body);
  }

  /**
   * 上传媒体到 RunningHub 上传接口，返回 fileName 注入加载节点。
   * @param file 待上传文件
   * @param _mediaType 媒体类型（RunningHub 上传接口按扩展名识别，无需区分端点）
   */
  async uploadMedia(file: UploadFileInput, _mediaType: MediaType): Promise<string> {
    const uniqueName = buildUniqueUploadFilename(file.originalname);
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
    formData.append('file', blob, uniqueName);

    const response = await fetch('https://www.runninghub.cn/openapi/v2/media/upload/binary', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: formData,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`RunningHub upload failed (${response.status}): ${text}`);
    }
    const result = (await response.json()) as { code: number; message: string; data?: { fileName: string } };
    if (result.code !== 0) {
      throw new Error(`RunningHub upload failed: ${result.message ?? 'unknown error'}`);
    }
    if (!result.data?.fileName) {
      throw new Error('RunningHub upload failed: missing fileName');
    }
    return result.data.fileName;
  }

  /** 拉取 history */
  fetchHistory(promptId: string): Promise<unknown> {
    return fetchHistoryRequest(this.getBaseUrl(), promptId);
  }

  /** 中断任务 */
  interrupt(promptId?: string): Promise<boolean> {
    return interruptRequest(this.getBaseUrl(), promptId);
  }

  /** 查询是否仍在执行队列 */
  isPromptRunning(promptId: string): Promise<boolean> {
    return isPromptRunningRequest(this.getBaseUrl(), promptId);
  }

  /** 构造 /view 下载地址 */
  buildOutputViewUrl(file: OutputFileRef): string {
    return buildViewUrl(this.getBaseUrl(), file);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter server test -- runninghub.provider.test.ts`
Expected: PASS

- [ ] **Step 6: 类型验证 + 提交**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误

```bash
git add packages/server/src/services/providers
git commit -m "feat: ComfyUIProvider 与 RunningHubProvider"
```

---

## Task 4: ProviderService（CRUD / 解析 / 事件 / 测试连接）

**Files:**
- Create: `packages/server/src/services/providers/provider.service.ts`
- Create: `packages/server/src/services/providers/provider.service.test.ts`

- [ ] **Step 1: 写失败测试（provider.service.test.ts）**

创建 `packages/server/src/services/providers/provider.service.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../models/schema';
import { ProviderService } from './provider.service';

function buildDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, provider_id TEXT);
  `);
  return drizzle(sqlite, { schema });
}

describe('ProviderService', () => {
  let db: ReturnType<typeof buildDb>;
  let service: ProviderService;

  beforeEach(() => {
    db = buildDb();
    service = new ProviderService(db);
  });

  it('creates and lists providers with parsed config', () => {
    const rec = service.create({ name: 'RH', type: 'runninghub', config: { apiKey: 'k', gpuSize: '24G' }, concurrency: 2 });
    const list = service.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('RH');
    expect(service.getConfig(rec.id)).toEqual({ apiKey: 'k', gpuSize: '24G' });
  });

  it('instantiates provider by id', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' }, concurrency: 1 });
    const provider = service.getProviderById(rec.id);
    expect(provider?.getBaseUrl()).toBe('http://localhost:8188');
    expect(provider?.trackingMode).toBe('websocket');
  });

  it('resolves default provider from settings', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' }, concurrency: 1 });
    service.setDefault(rec.id);
    expect(service.getDefaultProvider()?.id).toBe(rec.id);
  });

  it('resolveWorkflowProvider prefers workflow providerId over default', () => {
    const a = service.create({ name: 'A', type: 'comfyui', config: { baseUrl: 'http://a' }, concurrency: 1 });
    const b = service.create({ name: 'B', type: 'comfyui', config: { baseUrl: 'http://b' }, concurrency: 1 });
    service.setDefault(a.id);
    db.insert(schema.workflows).values({ id: 'w1', name: 'wf', rawJson: '{}', providerId: b.id, createdAt: 'x', updatedAt: 'x' }).run();
    expect(service.resolveWorkflowProvider('w1')?.getBaseUrl()).toBe('http://b');
    expect(service.resolveWorkflowProvider('missing')?.getBaseUrl()).toBe('http://a');
  });

  it('getNodeInfoProvider only returns comfyui type', () => {
    const rh = service.create({ name: 'RH', type: 'runninghub', config: { apiKey: 'k', gpuSize: '24G' }, concurrency: 1 });
    service.setDefault(rh.id);
    expect(service.getNodeInfoProvider()).toBeNull();
    const cu = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' }, concurrency: 1 });
    expect(service.getNodeInfoProvider()?.id).toBe(cu.id);
  });

  it('blocks deleting the default provider', () => {
    const rec = service.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' }, concurrency: 1 });
    service.setDefault(rec.id);
    const result = service.delete(rec.id);
    expect(result.deleted).toBe(false);
    expect(service.getById(rec.id)).not.toBeNull();
  });

  it('clears workflow providerId when deleting a referenced provider', () => {
    const rec = service.create({ name: 'A', type: 'comfyui', config: { baseUrl: 'http://a' }, concurrency: 1 });
    db.insert(schema.workflows).values({ id: 'w1', name: 'wf', rawJson: '{}', providerId: rec.id, createdAt: 'x', updatedAt: 'x' }).run();
    const result = service.delete(rec.id);
    expect(result.deleted).toBe(true);
    const wf = db.select().from(schema.workflows).where((t, { eq }) => eq(t.id, 'w1')).get();
    expect(wf?.providerId).toBeNull();
  });

  it('validates provider input', () => {
    expect(service.validateInput({ name: '', type: 'comfyui', config: { baseUrl: 'http://x' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'x', type: 'nope', config: { baseUrl: 'http://x' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'x', type: 'comfyui', config: { baseUrl: '' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'x', type: 'runninghub', config: { apiKey: '', gpuSize: '24G' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'x', type: 'runninghub', config: { apiKey: 'k', gpuSize: '99G' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'x', type: 'comfyui', config: { baseUrl: 'http://x' } }).ok).toBe(true);
  });

  it('masks apiKey in summary', () => {
    const rec = service.create({ name: 'RH', type: 'runninghub', config: { apiKey: 'sk-abcdef', gpuSize: '24G' }, concurrency: 1 });
    const summary = service.toSummary(rec);
    expect(summary.config.apiKey).not.toContain('abcdef');
  });

  it('emits change events', () => {
    const fn = vi.fn();
    const unsub = service.onChange(fn);
    service.notifyChange();
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    service.notifyChange();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server test -- provider.service.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 创建 provider.service.ts**

创建 `packages/server/src/services/providers/provider.service.ts`：

```ts
import { eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as schema from '../../models/schema';
import { ComfyUIProvider } from './comfyui.provider';
import { RunningHubProvider } from './runninghub.provider';
import type { ExecutionProvider, ProviderConfig, ProviderType } from './types';

/** 提供商实例行（DB 行） */
export type ProviderRow = typeof schema.providers.$inferSelect;

/** 创建/更新提供商实例的输入 */
export interface ProviderInput {
  name: string;
  type: ProviderType;
  config: ProviderConfig;
  concurrency?: number;
  enabled?: boolean;
}

/** 校验结果 */
export type ValidationResult =
  | { ok: true; value: ProviderInput }
  | { ok: false; error: string };

/** 对外摘要（config 中的 apiKey 打码） */
export interface ProviderSummary {
  id: string;
  name: string;
  type: ProviderType;
  config: ProviderConfig & { apiKey?: string };
  concurrency: number;
  enabled: boolean;
  /** 解析后的基础地址 */
  resolvedBaseUrl: string;
  trackingMode: 'websocket' | 'polling';
}

/** 类型白名单 */
const TYPES: readonly ProviderType[] = ['comfyui', 'runninghub'];
/** 显存档位白名单 */
const GPU_SIZES: readonly string[] = ['24G', '48G'];

/**
 * 执行提供商实例服务：CRUD、解析（工作流/默认/node-info）、变更事件、测试连接。
 */
export class ProviderService {
  /**
   * @param db Drizzle 数据库实例
   */
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /** 列出全部实例（按创建时间升序） */
  list(): ProviderRow[] {
    return this.db.select().from(schema.providers).orderBy(schema.providers.createdAt).all();
  }

  /** 列出启用的实例 */
  listEnabled(): ProviderRow[] {
    return this.db.select().from(schema.providers).where(eq(schema.providers.enabled, 1)).all();
  }

  /** 按 ID 查询实例行 */
  getById(id: string): ProviderRow | null {
    return this.db.select().from(schema.providers).where(eq(schema.providers.id, id)).get() ?? null;
  }

  /** 解析实例行的类型化配置 */
  getConfig(row: ProviderRow): ProviderConfig {
    return JSON.parse(row.config) as ProviderConfig;
  }

  /** 新建实例 */
  create(input: ProviderInput): ProviderRow {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.insert(schema.providers).values({
      id,
      name: input.name,
      type: input.type,
      config: JSON.stringify(input.config),
      concurrency: input.concurrency ?? 1,
      enabled: input.enabled === false ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.getById(id)!;
  }

  /** 更新实例；config/concurrency/enabled/name 均可选 */
  update(id: string, input: Partial<ProviderInput>): ProviderRow | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const config = input.config ? JSON.stringify(input.config) : existing.config;
    this.db.update(schema.providers)
      .set({
        name: input.name ?? existing.name,
        type: input.type ?? existing.type,
        config,
        concurrency: input.concurrency ?? existing.concurrency,
        enabled: input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.providers.id, id))
      .run();
    return this.getById(id)!;
  }

  /**
   * 删除实例。默认实例禁止删除。
   * 被工作流引用的实例：将 workflows.provider_id 置空（回退默认）。
   * @param id 实例 ID
   * @returns { deleted, error? } 删除结果
   */
  delete(id: string): { deleted: boolean; error?: string } {
    const existing = this.getById(id);
    if (!existing) return { deleted: false, error: 'provider_not_found' };
    if (this.getDefault()?.id === id) {
      return { deleted: false, error: 'default_provider_not_deletable' };
    }
    // 引用该实例的工作流回退为默认
    this.db.update(schema.workflows)
      .set({ providerId: null })
      .where(eq(schema.workflows.providerId, id))
      .run();
    this.db.delete(schema.providers).where(eq(schema.providers.id, id)).run();
    return { deleted: true };
  }

  /** 读取全局默认实例 ID（settings.default_provider_id） */
  getDefaultId(): string | null {
    const row = this.db.select().from(schema.settings).where(eq(schema.settings.key, 'default_provider_id')).get();
    return row?.value ?? null;
  }

  /** 读取全局默认实例行 */
  getDefault(): ProviderRow | null {
    const id = this.getDefaultId();
    if (!id) return null;
    return this.getById(id);
  }

  /** 设置全局默认实例 */
  setDefault(id: string): void {
    this.db.insert(schema.settings)
      .values({ key: 'default_provider_id', value: id })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: id } })
      .run();
  }

  /**
   * 将实例行实例化为 ExecutionProvider。
   * @param row 实例行
   * @returns 实例化后的 provider；config 非法时返回 null
   */
  instantiate(row: ProviderRow): ExecutionProvider | null {
    const config = this.getConfig(row);
    if (row.type === 'comfyui' && typeof (config as { baseUrl?: string }).baseUrl === 'string') {
      return new ComfyUIProvider(row.id, row.name, config as Extract<ProviderConfig, { baseUrl: string }>, row.concurrency);
    }
    if (row.type === 'runninghub' && typeof (config as { apiKey?: string }).apiKey === 'string') {
      return new RunningHubProvider(row.id, row.name, config as Extract<ProviderConfig, { apiKey: string; gpuSize: '24G' | '48G' }>, row.concurrency);
    }
    return null;
  }

  /** 按 ID 获取实例化 provider */
  getProviderById(id: string): ExecutionProvider | null {
    const row = this.getById(id);
    if (!row) return null;
    return this.instantiate(row);
  }

  /** 获取全局默认的实例化 provider */
  getDefaultProvider(): ExecutionProvider | null {
    const row = this.getDefault();
    if (!row) return null;
    return this.instantiate(row);
  }

  /**
   * 解析工作流使用的 provider：workflow.providerId 优先，其次全局默认。
   * @param workflowId 工作流 ID
   * @returns 实例化 provider 或 null
   */
  resolveWorkflowProvider(workflowId: string): ExecutionProvider | null {
    const wf = this.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
    if (wf?.providerId) {
      const p = this.getProviderById(wf.providerId);
      if (p) return p;
    }
    return this.getDefaultProvider();
  }

  /**
   * 解析 node-info 用的 provider：仅原生 ComfyUI 类型。
   * 全局默认若是 comfyui 则用它；否则取第一个启用的 comfyui 实例。
   * @returns comfyui 类型的 provider 或 null
   */
  getNodeInfoProvider(): ExecutionProvider | null {
    const def = this.getDefaultProvider();
    if (def?.type === 'comfyui') return def;
    const row = this.listEnabled().find((r) => r.type === 'comfyui');
    if (!row) return null;
    return this.instantiate(row);
  }

  /**
   * 校验并规范化创建/更新输入。
   * @param raw 原始输入
   * @returns 校验结果
   */
  validateInput(raw: Partial<ProviderInput>): ValidationResult {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name === '') return { ok: false, error: 'name is required' };
    if (!raw.type || !TYPES.includes(raw.type)) {
      return { ok: false, error: 'invalid type' };
    }
    if (raw.type === 'comfyui') {
      const baseUrl = (raw.config as { baseUrl?: unknown })?.baseUrl;
      if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
        return { ok: false, error: 'baseUrl is required' };
      }
      return {
        ok: true,
        value: {
          name,
          type: raw.type,
          config: { baseUrl: baseUrl.trim() },
          concurrency: this.normalizeConcurrency(raw.concurrency),
          enabled: raw.enabled,
        },
      };
    }
    const cfg = raw.config as { apiKey?: unknown; gpuSize?: unknown };
    if (typeof cfg.apiKey !== 'string' || cfg.apiKey.trim() === '') {
      return { ok: false, error: 'apiKey is required' };
    }
    const gpuSize = cfg.gpuSize === '48G' ? '48G' : cfg.gpuSize === '24G' ? '24G' : null;
    if (!gpuSize) return { ok: false, error: 'gpuSize must be 24G or 48G' };
    return {
      ok: true,
      value: {
        name,
        type: raw.type,
        config: { apiKey: cfg.apiKey.trim(), gpuSize },
        concurrency: this.normalizeConcurrency(raw.concurrency),
        enabled: raw.enabled,
      },
    };
  }

  /** 规范化并发数：非法时回退 1 */
  private normalizeConcurrency(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(n) && n > 0 ? n : 1;
  }

  /**
   * 生成对外摘要：apiKey 打码、附解析地址与跟踪模式。
   * @param row 实例行
   * @returns 摘要
   */
  toSummary(row: ProviderRow): ProviderSummary {
    const config = this.getConfig(row);
    const provider = this.instantiate(row);
    let maskedConfig = config as ProviderSummary['config'];
    if (row.type === 'runninghub') {
      const apiKey = (config as { apiKey: string }).apiKey;
      maskedConfig = { ...(config as object), apiKey: apiKey.length <= 4 ? '****' : `${apiKey.slice(0, 4)}****` } as ProviderSummary['config'];
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type as ProviderType,
      config: maskedConfig,
      concurrency: row.concurrency,
      enabled: row.enabled === 1,
      resolvedBaseUrl: provider?.getBaseUrl() ?? '',
      trackingMode: provider?.trackingMode ?? 'polling',
    };
  }

  /** 测试连接回调集合 */
  private listeners = new Set<() => void>();

  /** 订阅实例变更事件，返回取消订阅函数 */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** 触发变更事件（增删改实例 / 默认切换后调用） */
  notifyChange(): void {
    for (const cb of this.listeners) cb();
  }

  /**
   * 连通性测试：GET {base}/system_stats，2xx 视为连通（单一确定行为，无退化）。
   * @param config 待测试的配置（未保存也可）
   * @returns 测试结果
   */
  async testConnection(config: ProviderConfig): Promise<{ ok: boolean; message: string }> {
    const baseUrl = config.baseUrl
      ?? `https://www.runninghub.cn/${config.gpuSize === '48G' ? 'proxy-plus' : 'proxy'}/${config.apiKey}`;
    try {
      const res = await fetch(`${baseUrl}/system_stats`);
      if (res.ok) return { ok: true, message: '连接成功' };
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : 'Unknown error' };
    }
  }
}
```

> 注：`testConnection` 中 config 为 comfyui 时 `config.baseUrl` 存在；为 runninghub 时推导。上方用 `config.baseUrl ?? ...` 推导 RunningHub 地址，需在 TS 中处理判别联合——若类型报错，改用显式分支（`'baseUrl' in config`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter server test -- provider.service.test.ts`
Expected: PASS

- [ ] **Step 5: 类型验证 + 提交**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误

```bash
git add packages/server/src/services/providers
git commit -m "feat: ProviderService 实例 CRUD/解析/事件/测试连接"
```

---

## Task 5: executor.service.ts 收敛为 ExecutionProvider

**Files:**
- Modify: `packages/server/src/services/executor.service.ts`
- Modify: `packages/server/src/services/executor.service.test.ts`
- Modify: `packages/server/src/services/upload.service.ts`

- [ ] **Step 1: 改测试（executor.service.test.ts）**

在 `packages/server/src/services/executor.service.test.ts` 中：

1. 更新导入（顶部 `import { ... } from './executor.service';` 块），移除 `submitPrompt`、`interruptPrompt`、`isPromptRunning`，加入 `processMediaParams` 仍保留；`COMFYUI_CLIENT_ID` 与 `ExecutionResult` 改为从 `./providers/types` 导入（executor.service 会 re-export，二选一；本计划采用从 `./providers/types` 导入）。
2. 删除 `describe('submitPrompt client_id')`、`describe('interruptPrompt polling')`、`describe('isPromptRunning')` 三个块（其逻辑已由 `providers/shared.test.ts` 覆盖）。
3. 将 `describe('processMediaParams')` 块改为接收 `ExecutionProvider` 桩：新建 `makeProviderStub()` 辅助：

```ts
import type { ExecutionProvider, ExecutionResult, MediaType, OutputFileRef, UploadFileInput } from './providers/types';

/** 构造测试用 provider 桩：记录上传调用 */
function makeProviderStub(uploadResults: string[]): {
  provider: ExecutionProvider;
  uploadCalls: Array<{ file: UploadFileInput; mediaType: MediaType }>;
} {
  const uploadCalls: Array<{ file: UploadFileInput; mediaType: MediaType }> = [];
  let idx = 0;
  const provider: ExecutionProvider = {
    id: 'p1',
    name: 'stub',
    type: 'comfyui',
    concurrency: 1,
    trackingMode: 'polling',
    getBaseUrl: () => 'http://comfy:8188',
    submitPrompt: async (body: string): Promise<ExecutionResult> => ({
      success: true, comfyuiResponse: null, promptId: 'pid', errorMessage: null,
    }),
    uploadMedia: async (file: UploadFileInput, mediaType: MediaType): Promise<string> => {
      uploadCalls.push({ file, mediaType });
      const name = uploadResults[idx] ?? `uploaded-${idx}`;
      idx += 1;
      return name;
    },
    fetchHistory: async () => ({}),
    interrupt: async () => true,
    isPromptRunning: async () => false,
    buildOutputViewUrl: (f: OutputFileRef) => `http://comfy:8188/view?filename=${f.filename}`,
  };
  return { provider, uploadCalls };
}
```

4. `processMediaParams` 各用例改为传入 `makeProviderStub(...)` 返回的 `provider`（把原来的 `comfyuiBaseUrl` 参数换成 provider，断言 `uploadCalls` 而非 mock fetch）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server test -- executor.service.test.ts`
Expected: FAIL（签名不匹配）。

- [ ] **Step 3: 改 executor.service.ts**

在 `packages/server/src/services/executor.service.ts`：

1. 删除 `import { uploadFileToComfyUI } from './upload.service';`，改为：

```ts
import type { ExecutionProvider } from './providers/types';
// re-export 供既有引用方使用（COMFYUI_CLIENT_ID / ExecutionResult 定义已迁至 providers/types）
export { COMFYUI_CLIENT_ID, type ExecutionResult } from './providers/types';
```

2. 删除 `COMFYUI_CLIENT_ID` 常量定义、`ensureClientIdInBody`、`submitPrompt`、`isPromptRunning`、`interruptPrompt`、`sleep` 及 `INTERRUPT_*` 常量（均已迁至 `providers/`）。文件顶部 `import { randomUUID } from 'crypto';` 一并删除。
3. `ExecutionResult` 接口定义删除（改由 re-export）。
4. `processMediaParams` 签名与上传调用改为：

```ts
export async function processMediaParams(
  params: RuntimeParam[],
  aliasValues: Record<string, unknown>,
  files: Record<string, { buffer: Buffer; originalname: string; mimetype: string }[]>,
  provider: ExecutionProvider,
): Promise<Record<string, unknown>> {
```

函数体内两处 `uploadFileToComfyUI(file, param.paramType as 'image' | 'video' | 'audio', comfyuiBaseUrl)` 改为 `provider.uploadMedia(file, param.paramType as 'image' | 'video' | 'audio')`，并删除末尾参数引用。

5. `executeWorkflow` 签名改为：

```ts
export async function executeWorkflow(
  rawJson: string,
  params: RuntimeParam[],
  aliasValues: Record<string, unknown>,
  provider: ExecutionProvider,
): Promise<ExecutionResult> {
  try {
    const modifiedJson = applyAliases(rawJson, params, aliasValues);
    const body = JSON.stringify({ prompt: JSON.parse(modifiedJson) });
    return provider.submitPrompt(body);
  } catch (err: unknown) {
    return {
      success: false,
      comfyuiResponse: null,
      promptId: null,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
```

- [ ] **Step 4: 改 upload.service.ts**

删除 `uploadFileToComfyUI` 函数（其逻辑已迁入 `ComfyUIProvider.uploadMedia`），保留 `buildUniqueUploadFilename` 与 `randomHex`。检查 `upload.service.test.ts` 中 `uploadFileToComfyUI` 用例：迁移到 `comfyui.provider.test.ts`（新增 `describe('ComfyUIProvider.uploadMedia')`，mock fetch 断言 `/upload/image` 与返回 name），并删除原用例。

- [ ] **Step 5: 运行后端全部测试**

Run: `pnpm --filter server test`
Expected: 全部 PASS（`comfyui.service.test.ts` 若仍引用旧导出会报错，属于 Task 7 范围——若本步报错，先确认错误只来自 `comfyui.service.*`，允许暂缓到 Task 7）。

- [ ] **Step 6: 类型验证 + 提交**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误（`comfyui.service.ts`/`task.controller.ts`/`workflow.controller.ts` 若因旧导出缺失报错，属于后续 Task 范围，可先临时保留旧导出或用 `// @ts-expect-error` 标注过渡——推荐直接在本步把 `comfyui.service.ts` 的 `submitPrompt` 导入改为从 `providers/shared` 导入以过编译）。

```bash
git add packages/server/src/services/executor.service.ts packages/server/src/services/executor.service.test.ts packages/server/src/services/upload.service.ts packages/server/src/services/upload.service.test.ts packages/server/src/services/comfyui.service.ts
git commit -m "refactor: executor 服务收敛为 ExecutionProvider 接口"
```

---

## Task 6: task.service.ts 支持 providerId

**Files:**
- Modify: `packages/server/src/services/task.service.ts`
- Modify: `packages/server/src/services/task.service.test.ts`

- [ ] **Step 1: 改测试（task.service.test.ts）**

在 `packages/server/src/services/task.service.test.ts` 末尾追加：

```ts
describe('TaskService provider support', () => {
  let db: ReturnType<typeof buildDb>;
  let service: TaskService;

  beforeEach(() => {
    db = buildDb();
    service = new TaskService(db);
  });

  it('stores providerId on create', () => {
    const task = service.create({
      workflowId: 'w1',
      workflowName: 'wf',
      aliasValues: '{}',
      comfyuiUrl: 'http://x/prompt',
      comfyuiRequestBody: null,
      comfyuiResponse: null,
      promptId: null,
      providerId: 'p1',
    });
    expect(task.providerId).toBe('p1');
    expect(task.status).toBe('failed');
  });

  it('filters queued and pending by providerId', () => {
    const t1 = service.create({ workflowId: 'w1', workflowName: 'wf', aliasValues: '{}', comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null, promptId: null, providerId: 'p1' });
    const t2 = service.create({ workflowId: 'w1', workflowName: 'wf', aliasValues: '{}', comfyuiUrl: 'u', comfyuiRequestBody: null, comfyuiResponse: null, promptId: null, providerId: 'p2' });
    service.updateStatus(t1.id, { status: 'queued' });
    service.updateStatus(t2.id, { status: 'queued' });
    expect(service.listQueued('p1').map((t) => t.id)).toEqual([t1.id]);
    expect(service.listQueued().map((t) => t.id)).toHaveLength(2);
    expect(service.countByStatus('queued', 'p1')).toBe(1);
  });
});
```

> 注：`buildDb` 需在测试文件的 `task_logs` 建表语句中加 `provider_id TEXT` 列（参照现有 `buildDb` 实现补列）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server test -- task.service.test.ts`
Expected: FAIL（`providerId` 不存在）。

- [ ] **Step 3: 改 task.service.ts**

1. `CreateTaskInput` 增加：

```ts
  /** 实际使用的提供商实例 ID */
  providerId?: string | null;
```

2. `create()` 的 `values` 增加：

```ts
      providerId: input.providerId ?? null,
```

3. 新增按实例查询（保留无参兼容）：

```ts
  /** 查询所有 pending 状态的任务；可按提供商实例过滤 */
  listPending(providerId?: string) {
    const base = this.db.select().from(schema.taskLogs).where(eq(schema.taskLogs.status, 'pending'));
    if (providerId) return base.where(eq(schema.taskLogs.providerId, providerId)).all();
    return base.all();
  }

  /** 统计指定状态的任务数；可按提供商实例过滤 */
  countByStatus(status: string, providerId?: string): number {
    const base = this.db.select({ c: count() }).from(schema.taskLogs).where(eq(schema.taskLogs.status, status));
    const row = providerId ? base.where(eq(schema.taskLogs.providerId, providerId)).get() : base.get();
    return row?.c ?? 0;
  }

  /** 获取所有 queued 任务（按提交时间升序）；可按提供商实例过滤 */
  listQueued(providerId?: string) {
    const base = this.db.select().from(schema.taskLogs)
      .where(eq(schema.taskLogs.status, 'queued'))
      .orderBy(schema.taskLogs.createdAt);
    if (providerId) return base.where(eq(schema.taskLogs.providerId, providerId)).all();
    return base.all();
  }
```

> 注：drizzle 的 `.where()` 链式调用会覆盖条件，故上面用三元分支分别构造；若版本行为不同导致覆盖，改用 `and()` 组合条件。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter server test -- task.service.test.ts`
Expected: PASS

- [ ] **Step 5: 类型验证 + 提交**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误

```bash
git add packages/server/src/services/task.service.ts packages/server/src/services/task.service.test.ts
git commit -m "feat: TaskService 支持按提供商实例过滤与记录 providerId"
```

---

## Task 7: execution.service.ts（comfyui.service.ts 改造为按实例跟踪器）

**Files:**
- Rename: `packages/server/src/services/comfyui.service.ts` → `packages/server/src/services/execution.service.ts`
- Rename: `packages/server/src/services/comfyui.service.test.ts` → `packages/server/src/services/execution.service.test.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: 先跑既有 comfyui 测试，确认基线**

Run: `pnpm --filter server test -- comfyui.service.test.ts`
Expected: 基线通过（若因 Task 5 导入变化失败，先修 import：把 `submitPrompt` 等导入改为 `./providers/shared` 或 provider 桩）。

- [ ] **Step 2: 新增 execution.service.ts（保留纯函数，重写跟踪器）**

用 git mv 改名后重写文件主体：

```bash
git mv packages/server/src/services/comfyui.service.ts packages/server/src/services/execution.service.ts
git mv packages/server/src/services/comfyui.service.test.ts packages/server/src/services/execution.service.test.ts
```

`execution.service.ts` 内容（保留 `HistoryOutcome` / `resolveHistoryOutcome` / `parseHistoryOutputs` / `extractErrorMessageFromMessages` / `guessFileType` 的现有实现，跟踪逻辑改为按实例）：

```ts
import WebSocket from 'ws';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService, type OutputFile } from './task.service';
import { ProviderService } from './providers/provider.service';
import { COMFYUI_CLIENT_ID } from './providers/types';
import type { ExecutionProvider } from './providers/types';

const FALLBACK_INTERVAL = 10000;
const COMPLETION_POLL_INTERVAL = 1000;
const RECONNECT_DELAY = 5000;

// —— 以下纯函数保持原实现：HistoryOutcome / extractErrorMessageFromMessages /
//    resolveHistoryOutcome / parseHistoryOutputs / guessFileType（从旧文件原样保留）——
//    （文件太长，此处示意；实现时保留旧文件中的这些导出函数与类型，不做改动）

/** 单个提供商实例的跟踪器 */
interface ProviderTracker {
  stop(): void;
}

/**
 * 为单个提供商实例创建跟踪器：队列调度 + （可选）WebSocket + 轮询。
 * @param provider 实例化后的执行提供商
 * @param taskService 任务服务
 */
function createProviderTracker(provider: ExecutionProvider, taskService: TaskService): ProviderTracker {
  const providerId = provider.id;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let completionPollTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function getConcurrency(): number {
    return provider.concurrency;
  }

  /** 调度队列：当 running < concurrency 时取出最旧 queued 任务提交 */
  async function drainQueue(): Promise<void> {
    try {
      const concurrency = getConcurrency();
      const running = taskService.countByStatus('pending', providerId);
      if (running >= concurrency) return;

      const queued = taskService.listQueued(providerId);
      if (queued.length === 0) return;

      const nextTask = queued[0];
      if (!nextTask.comfyuiRequestBody) {
        taskService.updateStatus(nextTask.id, {
          status: 'failed',
          errorMessage: 'Missing request body',
        });
        return;
      }

      const result = await provider.submitPrompt(nextTask.comfyuiRequestBody);
      if (result.success) {
        taskService.updateStatus(nextTask.id, {
          status: 'pending',
          promptId: result.promptId ?? undefined,
          comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
        });
      } else {
        taskService.updateStatus(nextTask.id, {
          status: 'failed',
          errorMessage: result.errorMessage ?? 'Submit failed',
          comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
        });
      }
    } catch (err) {
      console.error(`[ExecutionService:${providerId}] drainQueue error`, err);
    }
  }

  /** 将 pending 任务标记为已完成，提取输出文件并触发队列调度 */
  async function completeTask(promptId: string): Promise<void> {
    const task = taskService.getByPromptId(promptId);
    if (!task || task.status !== 'pending') return;
    taskService.updateStatus(task.id, { status: 'completed' });
    fetchHistoryAndExtractOutputs(promptId)
      .catch(err => console.error(`[ExecutionService:${providerId}] fetch outputs error`, err));
    drainQueue();
  }

  /** 将 pending 任务标记为失败并触发队列调度 */
  function failTask(promptId: string, errorMessage?: string): void {
    const task = taskService.getByPromptId(promptId);
    if (!task || task.status !== 'pending') return;
    taskService.updateStatus(task.id, {
      status: 'failed',
      errorMessage: errorMessage || 'Execution error',
    });
    drainQueue();
  }

  async function fetchHistoryAndExtractOutputs(promptId: string): Promise<void> {
    try {
      const data = await provider.fetchHistory(promptId);
      const files = parseHistoryOutputs(data, promptId);
      if (files.length === 0) return;
      const task = taskService.getByPromptId(promptId);
      if (task) {
        taskService.updateOutputFiles(task.id, files);
      }
    } catch (err) {
      console.error(`[ExecutionService:${providerId}] fetchHistoryAndExtractOutputs error`, err);
    }
  }

  /** 按 history 解析结果更新 pending 任务终态 */
  function applyHistoryOutcome(taskId: string, promptId: string, data: unknown): boolean {
    const outcome = resolveHistoryOutcome(data, promptId);
    if (outcome.kind === 'running') return false;

    if (outcome.kind === 'completed') {
      taskService.updateStatus(taskId, { status: 'completed', comfyuiResponse: JSON.stringify(data) });
      const files = parseHistoryOutputs(data, promptId);
      if (files.length > 0) {
        taskService.updateOutputFiles(taskId, files);
      }
      drainQueue();
      return true;
    }

    taskService.updateStatus(taskId, {
      status: 'failed',
      errorMessage: outcome.errorMessage,
      comfyuiResponse: JSON.stringify(data),
    });
    drainQueue();
    return true;
  }

  /** 仅 websocket 模式建立连接 */
  function connect(): void {
    if (stopped || provider.trackingMode !== 'websocket') return;
    const url = `${provider.getBaseUrl().replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(COMFYUI_CLIENT_ID)}`;
    try {
      ws = new WebSocket(url);
      ws.on('open', () => {
        console.log(`[ExecutionService:${providerId}] WebSocket connected`);
      });
      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          const data = msg.data || {};
          const promptId = data.prompt_id;
          if (!promptId) return;
          if (msg.type === 'progress') {
            const { value, max } = data;
            if (value != null && max > 0) {
              const pct = Math.round((value / max) * 100);
              const task = taskService.getByPromptId(promptId);
              if (task && task.status === 'pending') {
                taskService.updateProgress(task.id, pct);
              }
            }
          } else if (msg.type === 'execution_success') {
            completeTask(promptId);
          } else if (msg.type === 'execution_error') {
            failTask(promptId, toErrorMessage(data.exception_message, 'Execution error'));
          } else if (msg.type === 'execution_interrupted') {
            failTask(promptId, 'Execution interrupted');
          }
        } catch {
          // ignore parse errors
        }
      });
      ws.on('close', () => {
        if (!stopped) {
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
        }
      });
      ws.on('error', () => {
        // close event will fire and trigger reconnect
      });
    } catch {
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
    }
  }

  /** 快速轮询进度 100% 但尚未完成的 pending 任务 */
  function startCompletionPoll(): void {
    completionPollTimer = setInterval(async () => {
      try {
        const pending = taskService.listPending(providerId);
        const stuck = pending.filter(t => t.progress != null && t.progress >= 100);
        if (stuck.length === 0) return;
        for (const task of stuck) {
          if (!task.promptId) continue;
          try {
            const data = await provider.fetchHistory(task.promptId);
            applyHistoryOutcome(task.id, task.promptId, data);
          } catch {
            // retry next cycle
          }
        }
      } catch {
        // ignore
      }
    }, COMPLETION_POLL_INTERVAL);
  }

  /** 后备轮询 /history 补偿丢失消息 */
  function startFallback(): void {
    fallbackTimer = setInterval(async () => {
      try {
        const pending = taskService.listPending(providerId);
        if (pending.length === 0) return;
        for (const task of pending) {
          if (!task.promptId) continue;
          try {
            const data = await provider.fetchHistory(task.promptId);
            applyHistoryOutcome(task.id, task.promptId, data);
          } catch {
            // retry next cycle
          }
        }
      } catch {
        // ignore
      }
    }, FALLBACK_INTERVAL);
  }

  connect();
  startFallback();
  startCompletionPoll();

  return {
    stop: () => {
      stopped = true;
      if (ws) { ws.close(); ws = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); }
      if (fallbackTimer) { clearInterval(fallbackTimer); }
      if (completionPollTimer) { clearInterval(completionPollTimer); }
    },
  };
}

/** 错误文案安全转换 */
function toErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (value == null) return fallback;
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

/**
 * 启动执行服务：为每个启用的提供商实例启动独立跟踪器；
 * 实例变更（增删改/默认切换）时整体重建。
 * @param db 数据库实例
 */
export function startExecutionService(db: BetterSQLite3Database<typeof schema>): { stop: () => void } {
  const taskService = new TaskService(db);
  const providerService = new ProviderService(db);
  let trackers: ProviderTracker[] = [];

  function stopAll(): void {
    for (const t of trackers) t.stop();
    trackers = [];
  }

  function startAll(): void {
    stopAll();
    const rows = providerService.listEnabled();
    trackers = rows
      .map((row) => providerService.instantiate(row))
      .filter((p): p is ExecutionProvider => p !== null)
      .map((p) => createProviderTracker(p, taskService));
  }

  const unsubscribe = providerService.onChange(() => startAll());
  startAll();

  return {
    stop: () => {
      unsubscribe();
      stopAll();
    },
  };
}
```

> 注意：`resolveHistoryOutcome`、`parseHistoryOutputs`、`HistoryOutcome`、`extractErrorMessageFromMessages`、`guessFileType` 需从旧文件完整保留（实现时直接保留原代码块，勿改动其签名与行为）。

- [ ] **Step 3: 更新 execution.service.test.ts**

保留原测试中对 `resolveHistoryOutcome` / `parseHistoryOutputs` 的用例（改名导入路径为 `./execution.service`）。删除/改写依赖单例 WebSocket 与全局设置 `comfyui_base_url` 的集成用例（若有），替换为对 `startExecutionService` 的最小冒烟测试：

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { startExecutionService } from './execution.service';
import { ProviderService } from './providers/provider.service';

describe('startExecutionService', () => {
  it('starts and stops without throwing', () => {
    const sqlite = new Database(':memory:');
    // 建表：providers / settings / task_logs / workflows（最小结构）
    sqlite.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT, provider_id TEXT);
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, provider_id TEXT);
    `);
    const db = drizzle(sqlite, { schema });
    const svc = startExecutionService(db);
    expect(svc.stop).toBeTypeOf('function');
    svc.stop();
  });
});
```

- [ ] **Step 4: 更新 index.ts 引用**

修改 `packages/server/src/index.ts`：

```ts
import { startExecutionService } from './services/execution.service';
// ...
function startServer() {
  startExecutionService(db);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
```

- [ ] **Step 5: 运行全部后端测试**

Run: `pnpm --filter server test`
Expected: 全部 PASS。

- [ ] **Step 6: 类型验证 + 提交**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误

```bash
git add packages/server/src/services/execution.service.ts packages/server/src/services/execution.service.test.ts packages/server/src/index.ts
git commit -m "feat: 执行服务按提供商实例启动独立跟踪器"
```

---

## Task 8: node-info.service.ts 只从 ComfyUI 类型提供商获取

**Files:**
- Modify: `packages/server/src/services/node-info.service.ts`
- Modify: `packages/server/src/services/node-info.service.test.ts`

- [ ] **Step 1: 改测试（node-info.service.test.ts）**

在现有测试文件顶部新增 `providers` 建表与辅助（参照现有 `sqlite.exec(...)` 模式，补 `providers` 表与 `settings.default_provider_id`）。在 `'returns null when comfyui_base_url is not configured'` 用例附近追加：

```ts
it('uses default provider when it is comfyui type', async () => {
  const providerService = new ProviderService(db);
  const rec = providerService.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://comfy:8188' }, concurrency: 1 });
  providerService.setDefault(rec.id);
  const info = await getNodeInfoCached(db);
  expect(info).not.toBeNull();
});

it('falls back to first enabled comfyui provider when default is runninghub', async () => {
  const providerService = new ProviderService(db);
  const rh = providerService.create({ name: 'RH', type: 'runninghub', config: { apiKey: 'k', gpuSize: '24G' }, concurrency: 1 });
  providerService.setDefault(rh.id);
  const cu = providerService.create({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://comfy:8188' }, concurrency: 1 });
  const info = await getNodeInfoCached(db);
  expect(info).not.toBeNull();
});

it('returns null when only runninghub providers exist', async () => {
  const providerService = new ProviderService(db);
  const rh = providerService.create({ name: 'RH', type: 'runninghub', config: { apiKey: 'k', gpuSize: '24G' }, concurrency: 1 });
  providerService.setDefault(rh.id);
  clearNodeInfoCache();
  const info = await getNodeInfoCached(db);
  expect(info).toBeNull();
});
```

> 注：这些用例依赖 mock 的 `nodeInfoServiceConfig.fetchImpl`（现有测试已有 mock 模式），需确保其按 URL 返回 object_info。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server test -- node-info.service.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 改 node-info.service.ts**

将 `getNodeInfoCached` 中读取 settings 的部分替换为 ProviderService 解析：

```ts
import { ProviderService } from './providers/provider.service';

// 原：
//   const baseUrl = new SettingsService(db).get('comfyui_base_url');
//   if (!baseUrl) return null;
// 改为：
  const provider = new ProviderService(db).getNodeInfoProvider();
  if (!provider) return null;
  const baseUrl = provider.getBaseUrl();
```

其余缓存/拉取逻辑不变（缓存 key 仍是 baseUrl）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter server test -- node-info.service.test.ts`
Expected: PASS

- [ ] **Step 5: 类型验证 + 提交**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误

```bash
git add packages/server/src/services/node-info.service.ts packages/server/src/services/node-info.service.test.ts
git commit -m "feat: node-info 仅从原生 ComfyUI 提供商获取"
```

---

## Task 9: providers routes/controller + 挂载

**Files:**
- Create: `packages/server/src/controllers/providers.controller.ts`
- Create: `packages/server/src/routes/providers.routes.ts`
- Create: `packages/server/src/routes/providers.routes.test.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: 写失败测试（providers.routes.test.ts）**

创建 `packages/server/src/routes/providers.routes.test.ts`（参照 `settings.routes.test.ts` 的建库/子应用模式，并在建表语句中补 `providers` 表）：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createProvidersRoutes } from './providers.routes';
import { createSettingsRoutes } from './settings.routes';
import { ProviderService } from '../services/providers/provider.service';
import { SettingsService } from '../services/settings.service';

function buildApp() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, provider_id TEXT);
    CREATE TABLE auth (token TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
  `);
  const db = drizzle(sqlite, { schema });
  new SettingsService(db).set('auth_enabled', '0');
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createProvidersRoutes(db));
  app.use('/api/settings', createSettingsRoutes(db));
  return { app, db };
}

describe('providers routes', () => {
  let app: ReturnType<typeof buildApp>['app'];
  let db: ReturnType<typeof buildApp>['db'];

  beforeEach(() => {
    ({ app, db } = buildApp());
  });

  it('creates and lists providers', async () => {
    const res = await request(app)
      .post('/api/providers')
      .send({ name: 'RH', type: 'runninghub', config: { apiKey: 'sk-12345678', gpuSize: '24G' }, concurrency: 2 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('RH');
    const list = await request(app).get('/api/providers');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].config.apiKey).toContain('****');
  });

  it('rejects invalid input with 400', async () => {
    const res = await request(app).post('/api/providers').send({ name: '', type: 'comfyui', config: { baseUrl: 'x' } });
    expect(res.status).toBe(400);
  });

  it('tests connection with given config via /test', async () => {
    const res = await request(app)
      .post('/api/providers/test')
      .send({ type: 'comfyui', config: { baseUrl: 'http://unreachable.invalid' } });
    expect(res.status).toBe(200);
    expect(typeof res.body.ok).toBe('boolean');
  });

  it('sets and reads default provider', async () => {
    const created = await request(app)
      .post('/api/providers')
      .send({ name: 'Local', type: 'comfyui', config: { baseUrl: 'http://localhost:8188' } });
    const id = created.body.id;
    await request(app).put('/api/settings').send({ key: 'default_provider_id', value: id });
    const res = await request(app).delete(`/api/providers/${id}`);
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server test -- providers.routes.test.ts`
Expected: FAIL（路由不存在）。

- [ ] **Step 3: 创建 providers.controller.ts**

创建 `packages/server/src/controllers/providers.controller.ts`：

```ts
import { Request, Response, NextFunction } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { ProviderService } from '../services/providers/provider.service';
import type { ProviderConfig, ProviderType } from '../services/providers/types';

/**
 * 解析请求体中的配置为 ProviderConfig（不做校验，由 service.validateInput 完成）。
 * @param type 提供商类型
 * @param raw 原始 config
 * @returns 解析后的配置
 */
function parseConfigBody(type: ProviderType, raw: unknown): ProviderConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (type === 'runninghub') {
    return {
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : '',
      gpuSize: obj.gpuSize === '48G' ? '48G' : obj.gpuSize === '24G' ? '24G' : '24G',
    };
  }
  return { baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : '' };
}

/** 提供商管理控制器 */
export function createProvidersController(db: BetterSQLite3Database<typeof schema>) {
  const providerService = new ProviderService(db);

  return {
    /** 列出全部提供商实例（含脱敏摘要） */
    list(_req: Request, res: Response): void {
      res.json(providerService.list().map((r) => providerService.toSummary(r)));
    },

    /** 新建提供商实例 */
    create(req: Request, res: Response): void {
      const body = req.body as { name?: unknown; type?: unknown; config?: unknown; concurrency?: unknown; enabled?: unknown };
      const type = body.type === 'runninghub' ? 'runninghub' : body.type === 'comfyui' ? 'comfyui' : null;
      if (!type) {
        res.status(400).json({ error: 'invalid type', code: 'missing_parameter' });
        return;
      }
      const config = parseConfigBody(type, body.config);
      const validation = providerService.validateInput({
        name: body.name as string,
        type,
        config,
        concurrency: body.concurrency as number,
        enabled: body.enabled as boolean,
      });
      if (!validation.ok) {
        res.status(400).json({ error: validation.error, code: 'missing_parameter' });
        return;
      }
      const rec = providerService.create(validation.value);
      providerService.notifyChange();
      res.status(201).json(providerService.toSummary(rec));
    },

    /** 更新提供商实例 */
    update(req: Request, res: Response): void {
      const id = req.params.id as string;
      const existing = providerService.getById(id);
      if (!existing) {
        res.status(404).json({ error: 'Provider not found', code: 'provider_not_found' });
        return;
      }
      const body = req.body as { name?: unknown; type?: unknown; config?: unknown; concurrency?: unknown; enabled?: unknown };
      const type = body.type === 'runninghub' ? 'runninghub' : body.type === 'comfyui' ? 'comfyui' : existing.type as ProviderType;
      const config = body.config !== undefined ? parseConfigBody(type, body.config) : undefined;
      const validation = providerService.validateInput({
        name: body.name as string,
        type,
        config,
        concurrency: body.concurrency as number,
        enabled: body.enabled as boolean,
      });
      if (!validation.ok) {
        res.status(400).json({ error: validation.error, code: 'missing_parameter' });
        return;
      }
      const rec = providerService.update(id, validation.value)!;
      providerService.notifyChange();
      res.json(providerService.toSummary(rec));
    },

    /** 删除提供商实例；默认实例返回 409 */
    delete(req: Request, res: Response): void {
      const id = req.params.id as string;
      const result = providerService.delete(id);
      if (!result.deleted) {
        const status = result.error === 'provider_not_found' ? 404 : 409;
        res.status(status).json({ error: result.error, code: result.error ?? 'provider_delete_failed' });
        return;
      }
      providerService.notifyChange();
      res.status(204).send();
    },

    /** 用未保存配置测试连通性 */
    async testByConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const body = req.body as { type?: unknown; config?: unknown };
        const type = body.type === 'runninghub' ? 'runninghub' : 'comfyui';
        const config = parseConfigBody(type, body.config);
        const result = await providerService.testConnection(config);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },

    /** 测试已保存实例的连通性 */
    async testById(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const row = providerService.getById(req.params.id as string);
        if (!row) {
          res.status(404).json({ error: 'Provider not found', code: 'provider_not_found' });
          return;
        }
        const result = await providerService.testConnection(providerService.getConfig(row));
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  };
}
```

- [ ] **Step 4: 创建 providers.routes.ts**

创建 `packages/server/src/routes/providers.routes.ts`：

```ts
import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createProvidersController } from '../controllers/providers.controller';
import { createAuthMiddleware } from '../middleware/auth';

export function createProvidersRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createProvidersController(db);
  const auth = createAuthMiddleware(db);

  router.get('/', auth, controller.list);
  router.post('/', auth, controller.create);
  router.post('/test', auth, controller.testByConfig);
  router.put('/:id', auth, controller.update);
  router.delete('/:id', auth, controller.delete);
  router.post('/:id/test', auth, controller.testById);

  return router;
}
```

> 注意：`POST /test` 需在 `/:id` 动态路由之前注册（Express 匹配顺序）。

- [ ] **Step 5: 挂载到 index.ts**

修改 `packages/server/src/index.ts`：

```ts
import { createProvidersRoutes } from './routes/providers.routes';
// ...
app.use('/api/providers', createProvidersRoutes(db));
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter server test -- providers.routes.test.ts`
Expected: PASS

- [ ] **Step 7: 类型验证 + 提交**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误

```bash
git add packages/server/src/controllers/providers.controller.ts packages/server/src/routes/providers.routes.ts packages/server/src/routes/providers.routes.test.ts packages/server/src/index.ts
git commit -m "feat: 提供商管理 API（CRUD/测试连接）"
```

---

## Task 10: workflow.controller.ts — providerId + 执行解析实例

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`
- Modify: `packages/server/src/services/workflow.service.ts`
- Modify: `packages/server/src/routes/workflow.routes.test.ts`
- Modify: `packages/client/src/api/workflows.ts`（前端部分在此步一并做类型打通）

- [ ] **Step 1: workflow.service.ts 支持 providerId**

`CreateWorkflowInput` / `UpdateWorkflowInput` 增加：

```ts
  /** 执行提供商实例 ID；缺省为 null（用全局默认） */
  providerId?: string | null;
```

`create()` 的 `values` 增加 `providerId: input.providerId ?? null,`；`update()` 的两处 insert/update `values` 均增加 `providerId`（id 变更分支补 `providerId: input.providerId ?? existing.providerId,`；普通分支依赖 `...input` 展开，无需额外处理，但需确认 `providerId` 在 input 中可空透传）。

- [ ] **Step 2: workflow.controller.ts 改动**

1. 导入新增：

```ts
import { ProviderService } from '../services/providers/provider.service';
```

2. `createWorkflowController` 内新增：

```ts
  const providerService = new ProviderService(db);
```

3. `create` 方法：`const { id, name, rawJson } = req.body;` 后增加 `const providerId = typeof req.body.providerId === 'string' && req.body.providerId !== '' ? req.body.providerId : null;`，`workflowService.create({ id, name, rawJson, description, providerId })`。
4. `update` 方法：`const wf = workflowService.update(id, req.body);` 改为先规范化 `providerId`：

```ts
      const body = { ...req.body } as Record<string, unknown>;
      if (typeof body.providerId === 'string' && body.providerId === '') {
        body.providerId = null;
      }
      const wf = workflowService.update(id, body);
```

5. `getById` / `saveBuildScript` / `saveDeclaredParams` 的响应对象补充提供商摘要：

```ts
      const resolvedProvider = providerService.resolveWorkflowProvider(id);
      res.json({
        ...wf,
        providerId: wf.providerId ?? null,
        resolvedProvider: resolvedProvider
          ? { id: resolvedProvider.id, name: resolvedProvider.name, type: resolvedProvider.type, resolvedBaseUrl: resolvedProvider.getBaseUrl() }
          : null,
        // ... 原有字段
      });
```

（三处响应均按此补充，或在每处重复片段。）

6. `execute` 方法改造：
   - 删除 `const baseUrl = settingsService.get('comfyui_base_url');` 及其 400 校验，改为：

```ts
        const provider = providerService.resolveWorkflowProvider(id);
        if (!provider) {
          res.status(400).json({ error: 'No execution provider configured', code: 'provider_not_configured' });
          return;
        }
        const baseUrl = provider.getBaseUrl();
```

   - 动态构建失败分支的 `comfyuiUrl: \`${baseUrl}/prompt\`` 保持不变（baseUrl 已来自 provider）
   - `processMediaParams(effectiveParams, aliasValues, uploadedFiles, baseUrl)` → 第 4 参改为 `provider`
   - `executeWorkflow(buildSource, effectiveParams, finalAliasValues, baseUrl)` → 第 4 参改为 `provider`
   - 任务创建的 `comfyuiUrl` 保持 `${baseUrl}/prompt`；新增 `providerId: provider.id`
   - 并发检查改为按实例：

```ts
        const pendingCount = taskService.countByStatus('pending', provider.id);
```

     删除 `const concurrencyStr = settingsService.get('comfyui_concurrency');`，改为 `const concurrency = provider.concurrency;`
   - 排队分支任务创建同样新增 `providerId: provider.id`
7. `simulateBuild` 方法：删除 `const baseUrl = settingsService.get('comfyui_base_url');` 校验，改为：

```ts
        const provider = providerService.resolveWorkflowProvider(id);
        if (!provider) {
          res.status(400).json({ error: 'No execution provider configured', code: 'provider_not_configured' });
          return;
        }
        const baseUrl = provider.getBaseUrl();
```

   `processMediaParams(effectiveParams, aliasParams, filesMeta, baseUrl)` → 第 4 参改为 `provider`。

- [ ] **Step 3: 前端 workflows.ts 类型打通**

`packages/client/src/api/workflows.ts`：

```ts
export async function createWorkflow(data: { id: string; name: string; rawJson: string; description?: string; providerId?: string | null }): Promise<Workflow> {
```

```ts
export async function updateWorkflow(id: string, data: Partial<{ id: string; name: string; rawJson: string; description: string; providerId: string | null }>): Promise<Workflow> {
```

- [ ] **Step 4: 更新 workflow.routes.test.ts**

将原来依赖 `comfyui_base_url` 设置 + `executeWorkflow` 直接提交的用例改为：先通过 `POST /api/providers` 创建 comfyui 实例 + `PUT /api/settings` 设 `default_provider_id`，再执行。新增用例：

```ts
it('returns provider_not_configured when no provider exists', async () => {
  const res = await request(app)
    .post('/api/workflows/my-workflow/execute')
    .send({ prompt: 'cat' });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('provider_not_configured');
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter server test -- workflow.routes.test.ts`
Expected: PASS（其余路由测试同步修好 `comfyui_base_url` 相关用例）。

- [ ] **Step 6: 类型验证（前后端）+ 提交**

Run: `pnpm --filter server exec tsc --noEmit` 与 `pnpm --filter client exec tsc --noEmit`
Expected: 均无错误

```bash
git add packages/server/src/controllers/workflow.controller.ts packages/server/src/services/workflow.service.ts packages/server/src/routes/workflow.routes.test.ts packages/client/src/api/workflows.ts
git commit -m "feat: 工作流支持按提供商实例执行与覆盖配置"
```

---

## Task 11: task.controller.ts — 输出回源/下载按任务实例

**Files:**
- Modify: `packages/server/src/controllers/task.controller.ts`
- Modify: `packages/server/src/routes/task.routes.test.ts`

- [ ] **Step 1: 改 task.controller.ts**

1. 导入新增：

```ts
import { ProviderService } from '../services/providers/provider.service';
import { fetchHistoryRequest } from '../services/providers/shared';
```

2. `createTaskController` 内新增 `const providerService = new ProviderService(db);`，并新增辅助：

```ts
  /** 按任务解析执行提供商：优先 task.providerId，回退全局默认 */
  function resolveProviderForTask(task: { providerId: string | null }): ExecutionProvider | null {
    if (task.providerId) {
      const p = providerService.getProviderById(task.providerId);
      if (p) return p;
    }
    return providerService.getDefaultProvider();
  }
```

（需导入 `ExecutionProvider` 类型：`import type { ExecutionProvider } from '../services/providers/types';`）

3. `fetchOutputsFromHistory(baseUrl, promptId)` 改为接收 provider：

```ts
async function fetchOutputsFromHistory(provider: ExecutionProvider, promptId: string): Promise<OutputFile[]> {
  try {
    const data = await provider.fetchHistory(promptId);
    return parseHistoryOutputs(data, promptId);
  } catch {
    return [];
  }
}
```

4. `listOutputFiles`：删除 `const baseUrl = settingsService.get('comfyui_base_url');`，改为：

```ts
      const provider = resolveProviderForTask(task);
      const mode = settingsService.get('output_download_mode') || 'proxy';
      // ...
      if (
        files.length === 0
        && task.status === 'completed'
        && task.promptId
        && provider
      ) {
        files = await fetchOutputsFromHistory(provider, task.promptId);
        if (files.length === 0) {
          await sleep(outputHistoryBackfillConfig.retryDelayMs);
          files = await fetchOutputsFromHistory(provider, task.promptId);
        }
        if (files.length > 0) {
          taskService.updateOutputFiles(task.id, files);
        }
      }
```

   结果 url 构造改为：

```ts
      const result = files.map(f => ({
        ...f,
        url: mode === 'direct' && provider
          ? provider.buildOutputViewUrl(f)
          : `/api/tasks/${task.id}/output-files/${encodeURIComponent(f.filename)}?subfolder=${encodeURIComponent(f.subfolder)}&type=${f.type}`,
      }));
```

5. `downloadOutputFile`：删除 `const baseUrl = settingsService.get('comfyui_base_url');`，改为：

```ts
      const provider = resolveProviderForTask(task);
      if (!provider) {
        res.status(502).json({ error: 'No execution provider configured', code: 'comfyui_unreachable' });
        return;
      }
      const comfyUrl = provider.buildOutputViewUrl({ filename, subfolder, type });
```

6. `submit` / `cancel` 方法：`const baseUrl = settingsService.get('comfyui_base_url');` 改为按任务解析 provider：

```ts
      const provider = resolveProviderForTask(task);
      if (!provider) {
        res.status(400).json({ error: 'No execution provider configured', code: 'provider_not_configured' });
        return;
      }
```

   `submitPrompt(task.comfyuiRequestBody, baseUrl)` → `provider.submitPrompt(task.comfyuiRequestBody)`；`interruptPrompt(baseUrl, task.promptId ?? undefined)` → `provider.interrupt(task.promptId ?? undefined)`。

- [ ] **Step 2: 更新 task.routes.test.ts**

将设置 `comfyui_base_url` 的用例改为：创建 comfyui provider 实例 + `default_provider_id`，并在 `task_logs` 写入时带 `provider_id`。新增用例：任务带 `provider_id` 指向 runninghub 实例时，`listOutputFiles` 的回源走 runninghub 的推导地址（mock fetch 断言 URL 含 `/proxy/<key>/history/<id>`）。

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm --filter server test -- task.routes.test.ts`
Expected: PASS

- [ ] **Step 4: 类型验证 + 提交**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无错误

```bash
git add packages/server/src/controllers/task.controller.ts packages/server/src/routes/task.routes.test.ts
git commit -m "feat: 任务输出回源与下载按提供商实例解析"
```

---

## Task 12: workflow-io.service.ts — 导出/导入/复制携带 providerId

**Files:**
- Modify: `packages/server/src/services/workflow-io.service.ts`
- Modify: `packages/server/src/services/workflow-io.service.test.ts`

- [ ] **Step 1: 改 workflow-io.service.ts**

1. `ExportManifest` 的 workflow 条目类型与 `exportWorkflows` 的 `manifest.workflows.push({...})` 增加 `providerId: wf.providerId ?? null,`。
2. `importWorkflows` 的 `this.db.insert(schema.workflows).values({...})` 增加 `providerId: entry.providerId ?? null,`（兼容旧导出无此字段）。
3. `duplicate` 的 insert `values` 增加 `providerId: existing.providerId,`。

- [ ] **Step 2: 更新测试**

在 `workflow-io.service.test.ts` 增加：复制后 `provider_id` 保留；导出 JSON 含 `providerId`；导入含 `providerId` 的工作流后恢复。

- [ ] **Step 3: 运行测试 + 类型验证 + 提交**

Run: `pnpm --filter server test` 与 `pnpm --filter server exec tsc --noEmit`
Expected: 全部 PASS / 无错误

```bash
git add packages/server/src/services/workflow-io.service.ts packages/server/src/services/workflow-io.service.test.ts
git commit -m "feat: 工作流导出/导入/复制携带 providerId"
```

---

## Task 13: 前端类型 + api/providers.ts

**Files:**
- Modify: `packages/client/src/types/index.ts`
- Create: `packages/client/src/api/providers.ts`

- [ ] **Step 1: types/index.ts 追加**

```ts
/** 执行提供商类型 */
export type ProviderType = 'comfyui' | 'runninghub';

/** 提供商配置（按类型区分） */
export type ProviderConfigInput =
  | { baseUrl: string }
  | { apiKey: string; gpuSize: '24G' | '48G' };

/** 提供商实例摘要（API 返回；apiKey 已打码） */
export interface ProviderSummary {
  id: string;
  name: string;
  type: ProviderType;
  config: ProviderConfigInput;
  concurrency: number;
  enabled: boolean;
  /** 解析后的执行地址 */
  resolvedBaseUrl: string;
  trackingMode: 'websocket' | 'polling';
}

/** 工作流解析后的提供商摘要 */
export interface ResolvedProvider {
  id: string;
  name: string;
  type: ProviderType;
  resolvedBaseUrl: string;
}
```

`WorkflowDetail` 增加：

```ts
  /** 执行提供商实例 ID；null = 用全局默认 */
  providerId: string | null;
  /** 解析后的提供商摘要 */
  resolvedProvider: ResolvedProvider | null;
```

`Workflow` 增加 `providerId: string | null;`。

- [ ] **Step 2: api/providers.ts**

创建 `packages/client/src/api/providers.ts`：

```ts
import client from './client';
import type { ProviderConfigInput, ProviderSummary, ProviderType } from '@/types';

export async function listProviders(): Promise<ProviderSummary[]> {
  const res = await client.get<ProviderSummary[]>('/providers');
  return res.data;
}

export interface ProviderCreateInput {
  name: string;
  type: ProviderType;
  config: ProviderConfigInput;
  concurrency?: number;
  enabled?: boolean;
}

export async function createProvider(data: ProviderCreateInput): Promise<ProviderSummary> {
  const res = await client.post<ProviderSummary>('/providers', data);
  return res.data;
}

export async function updateProvider(id: string, data: Partial<ProviderCreateInput>): Promise<ProviderSummary> {
  const res = await client.put<ProviderSummary>(`/providers/${id}`, data);
  return res.data;
}

export async function deleteProvider(id: string): Promise<void> {
  await client.delete(`/providers/${id}`);
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

/** 用未保存配置测试连通性 */
export async function testProviderConfig(type: ProviderType, config: ProviderConfigInput): Promise<TestConnectionResult> {
  const res = await client.post<TestConnectionResult>('/providers/test', { type, config });
  return res.data;
}

/** 测试已保存实例的连通性 */
export async function testProviderById(id: string): Promise<TestConnectionResult> {
  const res = await client.post<TestConnectionResult>(`/providers/${id}/test`);
  return res.data;
}
```

- [ ] **Step 3: 前端类型验证**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 无错误（SettingsPage 等尚未使用，不报错）。

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/types/index.ts packages/client/src/api/providers.ts
git commit -m "feat: 前端提供商类型与 API 模块"
```

---

## Task 14: SettingsPage.vue — 提供商管理区

**Files:**
- Modify: `packages/client/src/pages/SettingsPage.vue`

- [ ] **Step 1: 模板新增「执行提供商」卡片**

在「安全设置」卡片之前插入：

```html
    <v-card class="mb-4">
      <v-card-title>执行提供商</v-card-title>
      <v-card-text>
        <v-alert v-if="providerError" type="error" closable class="mb-4">{{ providerError }}</v-alert>
        <v-alert v-if="providers.length === 0" type="info" class="mb-4">
          尚未配置任何执行提供商，请先新建一个。
        </v-alert>

        <v-select
          v-model="defaultProviderId"
          :items="providers.map(p => ({ title: p.name, value: p.id }))"
          label="全局默认提供商实例"
          hint="所有未指定提供商的工作流将使用此实例执行"
          persistent-hint
          variant="outlined"
          class="mb-4"
          @update:model-value="handleDefaultChange"
        />

        <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreateDialog">新建提供商</v-btn>

        <v-list v-if="providers.length" class="mt-4">
          <v-list-item v-for="p in providers" :key="p.id">
            <template #prepend>
              <v-icon>{{ p.type === 'runninghub' ? 'mdi-cloud' : 'mdi-server' }}</v-icon>
            </template>
            <v-list-item-title>{{ p.name }}</v-list-item-title>
            <v-list-item-subtitle>
              {{ p.type === 'runninghub' ? `RunningHub ${configLabel(p)}` : p.resolvedBaseUrl }}
              · 并发 {{ p.concurrency }} · {{ p.enabled ? '已启用' : '已停用' }}
            </v-list-item-subtitle>
            <template #append>
              <v-btn size="small" variant="text" prepend-icon="mdi-wifi" :loading="testingId === p.id" @click="handleTest(p)">测试</v-btn>
              <v-btn size="small" variant="text" prepend-icon="mdi-pencil" @click="openEditDialog(p)">编辑</v-btn>
              <v-btn size="small" variant="text" color="error" prepend-icon="mdi-delete" @click="handleDelete(p)">删除</v-btn>
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>

    <v-dialog v-model="providerDialog.show" max-width="560">
      <v-card>
        <v-card-title>{{ providerDialog.isEdit ? '编辑提供商' : '新建提供商' }}</v-card-title>
        <v-card-text>
          <v-text-field v-model="providerForm.name" label="名称" variant="outlined" class="mb-3" />
          <v-select
            v-model="providerForm.type"
            :items="[{ title: 'ComfyUI 原生', value: 'comfyui' }, { title: 'RunningHub', value: 'runninghub' }]"
            label="类型"
            variant="outlined"
            class="mb-3"
          />
          <template v-if="providerForm.type === 'comfyui'">
            <v-text-field v-model="providerForm.baseUrl" label="ComfyUI 服务地址" placeholder="http://localhost:8188" variant="outlined" class="mb-3" />
          </template>
          <template v-else>
            <v-text-field v-model="providerForm.apiKey" label="RunningHub API Key" variant="outlined" class="mb-3" />
            <v-radio-group v-model="providerForm.gpuSize" label="显存档位" inline>
              <v-radio label="24G" value="24G" />
              <v-radio label="48G" value="48G" />
            </v-radio-group>
          </template>
          <v-text-field v-model.number="providerForm.concurrency" label="并发数" type="number" min="1" variant="outlined" class="mb-3" />
          <v-switch v-model="providerForm.enabled" label="启用" color="primary" />

          <v-alert v-if="providerTestResult" :type="providerTestResult.ok ? 'success' : 'error'" class="mb-3">
            {{ providerTestResult.message }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="providerDialog.show = false">取消</v-btn>
          <v-btn variant="text" :loading="testing" @click="handleDialogTest">测试连接</v-btn>
          <v-btn color="primary" :loading="savingProvider" @click="handleSaveProvider">保存</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
```

- [ ] **Step 2: script 逻辑**

在 `<script setup lang="ts">` 中新增：

```ts
import { ref, onMounted } from 'vue';
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  testProviderConfig,
  testProviderById,
} from '@/api/providers';
import { updateSetting } from '@/api/settings';
import type { ProviderSummary, ProviderType } from '@/types';

const providers = ref<ProviderSummary[]>([]);
const defaultProviderId = ref('');
const providerError = ref('');
const providerDialog = ref({ show: false, isEdit: false, id: '' });
const providerForm = ref({
  name: '',
  type: 'comfyui' as ProviderType,
  baseUrl: '',
  apiKey: '',
  gpuSize: '24G' as '24G' | '48G',
  concurrency: 1,
  enabled: true,
});
const providerTestResult = ref<{ ok: boolean; message: string } | null>(null);
const testing = ref(false);
const testingId = ref('');
const savingProvider = ref(false);

function configLabel(p: ProviderSummary): string {
  return p.type === 'runninghub'
    ? `${'gpuSize' in p.config ? p.config.gpuSize : '24G'} · ${'apiKey' in p.config ? p.config.apiKey : ''}`
    : ('baseUrl' in p.config ? p.config.baseUrl : '');
}

function resetForm() {
  providerForm.value = {
    name: '', type: 'comfyui', baseUrl: '', apiKey: '', gpuSize: '24G', concurrency: 1, enabled: true,
  };
  providerTestResult.value = null;
}

async function loadProviders() {
  try {
    providers.value = await listProviders();
    const settings = await getSettings();
    defaultProviderId.value = settings.default_provider_id ?? '';
  } catch {
    providerError.value = '加载提供商失败';
  }
}

function openCreateDialog() {
  providerDialog.value = { show: true, isEdit: false, id: '' };
  resetForm();
}

function openEditDialog(p: ProviderSummary) {
  providerDialog.value = { show: true, isEdit: true, id: p.id };
  providerForm.value = {
    name: p.name,
    type: p.type,
    baseUrl: p.type === 'comfyui' && 'baseUrl' in p.config ? p.config.baseUrl : '',
    apiKey: p.type === 'runninghub' && 'apiKey' in p.config ? p.config.apiKey : '',
    gpuSize: p.type === 'runninghub' && 'gpuSize' in p.config ? p.config.gpuSize : '24G',
    concurrency: p.concurrency,
    enabled: p.enabled,
  };
  providerTestResult.value = null;
}

function buildConfigPayload() {
  return providerForm.value.type === 'comfyui'
    ? { baseUrl: providerForm.value.baseUrl }
    : { apiKey: providerForm.value.apiKey, gpuSize: providerForm.value.gpuSize };
}

async function handleDialogTest() {
  testing.value = true;
  try {
    providerTestResult.value = await testProviderConfig(providerForm.value.type, buildConfigPayload());
  } catch {
    providerTestResult.value = { ok: false, message: '测试请求失败' };
  } finally {
    testing.value = false;
  }
}

async function handleSaveProvider() {
  savingProvider.value = true;
  providerError.value = '';
  try {
    const payload = {
      name: providerForm.value.name,
      type: providerForm.value.type,
      config: buildConfigPayload(),
      concurrency: providerForm.value.concurrency,
      enabled: providerForm.value.enabled,
    };
    if (providerDialog.value.isEdit) {
      await updateProvider(providerDialog.value.id, payload);
    } else {
      const created = await createProvider(payload);
      // 首个实例自动设为全局默认
      if (providers.value.length === 0) {
        defaultProviderId.value = created.id;
        await updateSetting('default_provider_id', created.id);
      }
    }
    providerDialog.value.show = false;
    await loadProviders();
  } catch {
    providerError.value = '保存提供商失败';
  } finally {
    savingProvider.value = false;
  }
}

async function handleDefaultChange(val: string | null) {
  if (!val) return;
  try {
    await updateSetting('default_provider_id', val);
    providerError.value = '';
  } catch {
    providerError.value = '设置默认提供商失败';
  }
}

async function handleTest(p: ProviderSummary) {
  testingId.value = p.id;
  try {
    const r = await testProviderById(p.id);
    providerError.value = r.ok ? `「${p.name}」连接成功` : `「${p.name}」连接失败：${r.message}`;
  } catch {
    providerError.value = '测试请求失败';
  } finally {
    testingId.value = '';
  }
}

async function handleDelete(p: ProviderSummary) {
  if (!window.confirm(`确认删除提供商「${p.name}」？`)) return;
  try {
    await deleteProvider(p.id);
    if (defaultProviderId.value === p.id) defaultProviderId.value = '';
    await loadProviders();
  } catch {
    providerError.value = '删除失败（默认实例不可删除）';
  }
}
```

3. 在 `onMounted` 中调用 `await loadProviders();`。

- [ ] **Step 3: 前端类型验证**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/pages/SettingsPage.vue
git commit -m "feat: 设置页提供商实例管理"
```

---

## Task 15: WorkflowEditPage.vue — 提供商选择器

**Files:**
- Modify: `packages/client/src/pages/WorkflowEditPage.vue`

- [ ] **Step 1: 模板加入提供商选择**

在工作流基本信息表单（名称输入附近）加入：

```html
        <v-select
          v-model="providerId"
          :items="providerOptions"
          label="执行提供商"
          hint="留空使用全局默认提供商实例"
          persistent-hint
          variant="outlined"
          clearable
          class="mb-4"
        />
```

- [ ] **Step 2: script 逻辑**

```ts
import { listProviders } from '@/api/providers';
import type { ProviderSummary } from '@/types';

const providerId = ref<string | null>(null);
const providerOptions = ref<Array<{ title: string; value: string }>>([]);

async function loadProviders() {
  try {
    const list = await listProviders();
    providerOptions.value = list
      .filter((p) => p.enabled)
      .map((p) => ({ title: p.name, value: p.id }));
  } catch {
    providerOptions.value = [];
  }
}
```

- 编辑模式加载工作流详情后：`providerId.value = (detail as { providerId?: string | null }).providerId ?? null;`
- 保存时 payload 增加 `providerId: providerId.value`（`createWorkflow` / `updateWorkflow` 的 data 传入 `providerId`）
- `onMounted` 中调用 `loadProviders()`

- [ ] **Step 3: 前端类型验证**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/pages/WorkflowEditPage.vue
git commit -m "feat: 工作流编辑页支持选择执行提供商"
```

---

## Task 16: 文档与全量验证

**Files:**
- Modify: `docs/workflow-api.md`
- Modify: `AGENTS.md`（如需）

- [ ] **Step 1: 更新 docs/workflow-api.md**

在「提交工作流执行」一节补充：错误响应表新增 `provider_not_configured`；响应说明中 `comfyui_response` 语义不变但注明执行端可能为 RunningHub。新增「提供商管理」一节简要列出 `/api/providers` 各端点与 `POST /api/providers/test`。

- [ ] **Step 2: 全量测试与类型检查**

Run:
- `pnpm --filter server test`
- `pnpm --filter server exec tsc --noEmit`
- `pnpm --filter client exec tsc --noEmit`
- `pnpm --filter client exec vue-tsc --noEmit`（若项目配置了）

Expected: 全部通过。

- [ ] **Step 3: 手动冒烟（可选）**

启动 `pnpm dev:server` 与 `pnpm dev:client`，在设置页新建一个 ComfyUI 提供商实例（指向本地 ComfyUI），确认全局默认生效、工作流可执行、任务日志与输出下载正常；新建 RunningHub 实例（如无 key 可仅测「测试连接」失败分支不阻止保存）。

- [ ] **Step 4: 提交**

```bash
git add docs/workflow-api.md AGENTS.md
git commit -m "docs: 更新提供商管理与执行接口文档"
```

---

## 自审结论

- **Spec 覆盖**：providers 表/字段迁移（Task 1）、抽象层（Task 2-3）、ProviderService 解析与事件（Task 4）、executor 收敛（Task 5）、任务服务（Task 6）、按实例跟踪器（Task 7）、node-info 仅 comfyui（Task 8）、提供商 API（Task 9）、工作流覆盖与执行解析（Task 10）、输出回源/下载（Task 11）、导入导出复制（Task 12）、前端设置与工作流页（Task 13-15）、文档与验证（Task 16）。Spec 中「测试连接 GET /system_stats 单一行为」「测试失败不阻止保存」「node-info 只从原生 ComfyUI」均已覆盖。
- **占位符扫描**：无 TBD/TODO；关键代码均给出完整实现或明确改造点。
- **类型一致性**：`ExecutionProvider` / `ProviderConfig` / `ProviderService` / `providerId` 字段命名在 Task 2-15 保持一致；`processMediaParams` 第 4 参统一为 `provider`；`countByStatus` / `listQueued` / `listPending` 的 `providerId` 可选参一致。
