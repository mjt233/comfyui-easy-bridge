# 任务日志系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 记录每次提交到 ComfyUI 的任务日志，支持查看执行历史，自动检测任务完成状态。

**Architecture:** 新增 `task_logs` 表，`TaskService` 管理日志 CRUD，`PollingService` 后台轮询 ComfyUI `/history` 检测完成，`TaskListPage` 前端展示并每 1 秒刷新状态。

**Tech Stack:** Drizzle ORM (SQLite), Express, Vue 3 + Vuetify, vitest + supertest

---

### Task 1: task_logs 表定义 + 建表

**Files:**
- Modify: `packages/server/src/models/schema.ts`
- Modify: `packages/server/src/models/db.ts`

- [ ] **Step 1: schema.ts 添加 taskLogs 表定义**

```typescript
// 在 workflow_params 定义之后添加
export const taskLogs = sqliteTable('task_logs', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  workflowName: text('workflow_name').notNull(),
  promptId: text('prompt_id'),
  aliasValues: text('alias_values').notNull(),
  comfyuiUrl: text('comfyui_url').notNull(),
  comfyuiRequestBody: text('comfyui_request_body'),
  comfyuiResponse: text('comfyui_response'),
  status: text('status').notNull().default('pending'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});
```

```typescript
// 更新 exports
export { workflows, workflowParams, settings, taskLogs };
```

- [ ] **Step 2: db.ts 添加建表语句**

在 `settings` 表创建之后，`export const db` 之前添加：

```typescript
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
    created_at TEXT NOT NULL,
    completed_at TEXT
  )
`);
```

- [ ] **Step 3: 验证编译**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/models/schema.ts packages/server/src/models/db.ts
git commit -m "feat: 添加 task_logs 表定义"
```

---

### Task 2: TaskService

**Files:**
- Create: `packages/server/src/services/task.service.ts`

- [ ] **Step 1: 创建 TaskService**

```typescript
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { v4 as uuid } from 'uuid';

export interface CreateTaskInput {
  workflowId: string;
  workflowName: string;
  aliasValues: string;
  comfyuiUrl: string;
  comfyuiRequestBody: string | null;
  comfyuiResponse: string | null;
  promptId: string | null;
}

export interface UpdateTaskResult {
  status: 'completed' | 'failed';
  promptId?: string;
  comfyuiResponse?: string;
  errorMessage?: string;
  completedAt?: string;
}

export class TaskService {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  create(input: CreateTaskInput) {
    const now = new Date().toISOString();
    this.db.insert(schema.taskLogs).values({
      id: uuid(),
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      aliasValues: input.aliasValues,
      comfyuiUrl: input.comfyuiUrl,
      comfyuiRequestBody: input.comfyuiRequestBody,
      comfyuiResponse: input.comfyuiResponse,
      promptId: input.promptId,
      status: input.promptId ? 'pending' : 'failed',
      errorMessage: null,
      createdAt: now,
      completedAt: input.promptId ? null : now,
    }).run();

    const row = this.db.select().from(schema.taskLogs)
      .orderBy(schema.taskLogs.createdAt).all();
    return row[row.length - 1]!;
  }

  getById(id: string) {
    return this.db.select().from(schema.taskLogs).where(eq(schema.taskLogs.id, id)).get() ?? null;
  }

  list() {
    return this.db.select().from(schema.taskLogs)
      .orderBy(schema.taskLogs.createdAt).all();
  }

  updateStatus(id: string, input: UpdateTaskResult) {
    const now = new Date().toISOString();
    this.db.update(schema.taskLogs)
      .set({
        status: input.status,
        promptId: input.promptId,
        comfyuiResponse: input.comfyuiResponse,
        errorMessage: input.errorMessage ?? null,
        completedAt: input.completedAt ?? now,
      })
      .where(eq(schema.taskLogs.id, id))
      .run();
    return this.getById(id)!;
  }

  listPending() {
    return this.db.select().from(schema.taskLogs)
      .where(eq(schema.taskLogs.status, 'pending'))
      .all();
  }
}
```

注意：如果项目没有 `uuid` 包，需安装：
```bash
pnpm --filter server add uuid && pnpm --filter server add -D @types/uuid
```

或者使用 `crypto.randomUUID()` （Node.js 19+ 内置），但 safer 是用 uuid 包。检查 Node 版本后用 `crypto.randomUUID()`。

- [ ] **Step 2: 验证编译**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/task.service.ts
git commit -m "feat: 添加 TaskService"
```

---

### Task 3: 修改 executor.service 返回结构化结果

**Files:**
- Modify: `packages/server/src/services/executor.service.ts`

- [ ] **Step 1: 添加 ExecutionResult 类型并修改 executeWorkflow**

```typescript
export interface ExecutionResult {
  success: boolean;
  comfyuiResponse: unknown;
  promptId: string | null;
  errorMessage: string | null;
}

export async function executeWorkflow(
  rawJson: string,
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
  comfyuiBaseUrl: string,
): Promise<ExecutionResult> {
  try {
    const modifiedJson = applyAliases(rawJson, params, aliasValues);
    const body = JSON.stringify({ prompt: JSON.parse(modifiedJson) });
    const response = await fetch(`${comfyuiBaseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const responseBody = await response.json();
    if (!response.ok) {
      return {
        success: false,
        comfyuiResponse: responseBody,
        promptId: null,
        errorMessage: `ComfyUI returned status ${response.status}: ${JSON.stringify(responseBody)}`,
      };
    }
    const promptId = (responseBody as { prompt_id?: string }).prompt_id ?? null;
    return {
      success: true,
      comfyuiResponse: responseBody,
      promptId,
      errorMessage: null,
    };
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

- [ ] **Step 2: 验证编译**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/executor.service.ts
git commit -m "refactor: executeWorkflow 返回结构化结果而非抛异常"
```

---

### Task 4: PollingService

**Files:**
- Create: `packages/server/src/services/polling.service.ts`

- [ ] **Step 1: 创建 PollingService**

```typescript
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService } from './task.service';
import { SettingsService } from './settings.service';

const POLL_INTERVAL = 3000;

export function startPollingService(db: BetterSQLite3Database<typeof schema>): { stop: () => void } {
  const taskService = new TaskService(db);
  const settingsService = new SettingsService(db);

  const intervalId = setInterval(async () => {
    try {
      const pending = taskService.listPending();
      const baseUrl = settingsService.get('comfyui_base_url');
      if (!baseUrl || pending.length === 0) return;

      for (const task of pending) {
        if (!task.promptId) {
          taskService.updateStatus(task.id, {
            status: 'failed',
            errorMessage: 'Missing prompt_id',
          });
          continue;
        }
        try {
          const res = await fetch(`${baseUrl}/history/${task.promptId}`);
          if (res.status === 404) continue;
          const data = await res.json();
          const promptData = (data as Record<string, unknown>)[task.promptId];
          if (!promptData) continue;

          const statusObj = (promptData as { status?: { completed?: boolean } }).status;
          if (statusObj?.completed) {
            taskService.updateStatus(task.id, {
              status: 'completed',
              comfyuiResponse: JSON.stringify(data),
            });
          }
        } catch {
          // 暂时性网络错误，下次再试
        }
      }
    } catch {
      // 防止未捕获异常杀死轮询
    }
  }, POLL_INTERVAL);

  return {
    stop: () => clearInterval(intervalId),
  };
}
```

- [ ] **Step 2: 验证编译**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/services/polling.service.ts
git commit -m "feat: 添加 PollingService 后台轮询任务状态"
```

---

### Task 5: TaskController + TaskRoutes

**Files:**
- Create: `packages/server/src/controllers/task.controller.ts`
- Create: `packages/server/src/routes/task.routes.ts`

- [ ] **Step 1: 创建 TaskController**

```typescript
import { Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService } from '../services/task.service';

export function createTaskController(db: BetterSQLite3Database<typeof schema>) {
  const taskService = new TaskService(db);

  return {
    list(_req: Request, res: Response): void {
      res.json(taskService.list());
    },

    getById(req: Request, res: Response): void {
      const task = taskService.getById(req.params.taskId);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
        return;
      }
      res.json(task);
    },
  };
}
```

- [ ] **Step 2: 创建 TaskRoutes**

```typescript
import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createTaskController } from '../controllers/task.controller';
import { createAuthMiddleware } from '../middleware/auth';

export function createTaskRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createTaskController(db);
  const auth = createAuthMiddleware(db);

  router.get('/', auth, controller.list);
  router.get('/:taskId', auth, controller.getById);

  return router;
}
```

- [ ] **Step 3: 验证编译**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/controllers/task.controller.ts packages/server/src/routes/task.routes.ts
git commit -m "feat: 添加任务日志 API 路由"
```

---

### Task 6: 修改 workflow.controller 的 execute 方法

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`

- [ ] **Step 1: 修改 execute 为异步任务流程**

```typescript
import { TaskService } from '../services/task.service';

export function createWorkflowController(db: BetterSQLite3Database<typeof schema>) {
  const workflowService = new WorkflowService(db);
  const settingsService = new SettingsService(db);
  const taskService = new TaskService(db);

  return {
    // ... 其他方法不变 ...

    async execute(req: Request, res: Response): Promise<void> {
      const id = req.params.id as string;
      const wf = workflowService.getById(id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const params = workflowService.getParams(id);
      const baseUrl = settingsService.get('comfyui_base_url');
      if (!baseUrl) {
        res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
        return;
      }
      try {
        const result = await executeWorkflow(wf.rawJson, params, req.body, baseUrl);
        // 创建任务日志
        const task = taskService.create({
          workflowId: wf.id,
          workflowName: wf.name,
          aliasValues: JSON.stringify(req.body),
          comfyuiUrl: `${baseUrl}/prompt`,
          comfyuiRequestBody: JSON.stringify({ prompt: JSON.parse(applyAliases(wf.rawJson, params, req.body)) }),
          comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : null,
          promptId: result.promptId,
        });
        if (!result.success) {
          taskService.updateStatus(task.id, {
            status: 'failed',
            errorMessage: result.errorMessage ?? 'Unknown error',
          });
        }
        res.json({
          task_id: task.id,
          status: task.status,
          comfyui_response: result.comfyuiResponse,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith('Missing required parameter:')) {
          res.status(400).json({ error: err.message, code: 'missing_parameter' });
          return;
        }
        throw err;
      }
    },
  };
}
```

注意：`applyAliases` 需要被 import 用于构建 `comfyuiRequestBody`（仅用于日志记录，异常会被 taskService.create 的调用覆盖）。实际上更好的做法是只记录提交的参数，而不是重复调用 applyAliases。让我简化：

```typescript
import { executeWorkflow, applyAliases } from '../services/executor.service';

async execute(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;
  const wf = workflowService.getById(id);
  if (!wf) {
    res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
    return;
  }
  const params = workflowService.getParams(id);
  const baseUrl = settingsService.get('comfyui_base_url');
  if (!baseUrl) {
    res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
    return;
  }
  const aliasValues = req.body as Record<string, string>;
  // 验证参数（applyAliases 内部会检查缺失参数）
  applyAliases(wf.rawJson, params, aliasValues);

  const result = await executeWorkflow(wf.rawJson, params, aliasValues, baseUrl);

  const task = taskService.create({
    workflowId: wf.id,
    workflowName: wf.name,
    aliasValues: JSON.stringify(aliasValues),
    comfyuiUrl: `${baseUrl}/prompt`,
    comfyuiRequestBody: result.success ? JSON.stringify({ prompt: JSON.parse(modifiedJson) }) : null,
    comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : null,
    promptId: result.promptId,
  });

  // 如果失败，更新任务状态
  if (!result.success) {
    taskService.updateStatus(task.id, {
      status: 'failed',
      errorMessage: result.errorMessage ?? 'Unknown error',
    });
  }

  res.json({
    task_id: task.id,
    status: task.status,
    comfyui_response: result.comfyuiResponse,
  });
}
```

Hmm, this is getting messy with trying to get the modifiedJson for the request body log. Let me simplify - rebuild the request body from what we know:

Actually, the cleanest approach: just run applyAliases to validate first, then construct the request body, then execute.

Wait, but executeWorkflow already calls applyAliases internally. So calling it twice is wasteful. Let me refactor:

Actually, let me keep it simple. The `comfyuiRequestBody` is just a nice-to-have for logging. We can reconstruct it:

```typescript
// Validate parameters first
applyAliases(wf.rawJson, params, aliasValues);
// Build request body for logging
const requestBody = JSON.stringify({ prompt: JSON.parse(applyAliases(wf.rawJson, params, aliasValues)) });
const result = await executeWorkflow(wf.rawJson, params, aliasValues, baseUrl);
```

This calls applyAliases twice. For a logging feature, that's fine. Actually, I should refactor executeWorkflow to avoid the double call, but that's complexity we don't need.

Let me just keep the implementation practical:

- [ ] **Step 1: 修改 execute 方法**

把原来的 `createWorkflowController` 中的 `execute` 方法替换为异步任务版本。同时 import `TaskService` 和 `applyAliases`。

完整实现：

```typescript
import { TaskService } from '../services/task.service';
import { executeWorkflow, applyAliases } from '../services/executor.service';

// 在 createWorkflowController 内部
const taskService = new TaskService(db);

// execute 方法
async execute(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;
  const wf = workflowService.getById(id);
  if (!wf) {
    res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
    return;
  }
  const params = workflowService.getParams(id);
  const baseUrl = settingsService.get('comfyui_base_url');
  if (!baseUrl) {
    res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
    return;
  }
  const aliasValues = req.body as Record<string, string>;

  // 先验证参数
  const modifiedJson = applyAliases(wf.rawJson, params, aliasValues);

  const result = await executeWorkflow(wf.rawJson, params, aliasValues, baseUrl);

  const task = taskService.create({
    workflowId: wf.id,
    workflowName: wf.name,
    aliasValues: JSON.stringify(aliasValues),
    comfyuiUrl: `${baseUrl}/prompt`,
    comfyuiRequestBody: JSON.stringify({ prompt: JSON.parse(modifiedJson) }),
    comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : null,
    promptId: result.promptId,
  });

  if (!result.success) {
    taskService.updateStatus(task.id, {
      status: 'failed',
      errorMessage: result.errorMessage ?? 'Unknown error',
    });
  }

  res.json({
    task_id: task.id,
    status: task.status,
    comfyui_response: result.comfyuiResponse,
  });
}
```

- [ ] **Step 2: 验证编译**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/controllers/workflow.controller.ts
git commit -m "feat: execute 接口改为异步任务流程"
```

---

### Task 7: 注册路由 + 启动 PollingService

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: 注册 task 路由和轮询服务**

```typescript
import { createTaskRoutes } from './routes/task.routes';
import { startPollingService } from './services/polling.service';

// 在现有路由之后添加
app.use('/api/tasks', createTaskRoutes(db));

// 在 startServer 函数中启动轮询
function startServer() {
  const poller = startPollingService(db);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
```

- [ ] **Step 2: 验证编译**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: No errors

- [ ] **Step 3: 运行现有测试**

Run: `pnpm --filter server test`
Expected: Tests pass (注意：execute 接口的测试可能需要先适配)

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat: 注册 /api/tasks 路由并启动轮询服务"
```

---

### Task 8: 适配现有测试

**Files:**
- Modify: `packages/server/src/services/executor.service.test.ts`
- Modify: `packages/server/src/routes/workflow.routes.test.ts`

- [ ] **Step 1: 修改 executor.service.test.ts**

更新测试以适应新的返回类型：

```typescript
import { applyAliases } from './executor.service';

describe('executor.service', () => {
  const sampleJson = JSON.stringify({
    '29': {
      'inputs': { 'filename_prefix': 'test', 'images': ['30:8', 0] },
      'class_type': 'SaveImage',
      '_meta': { 'title': '保存图像' },
    },
    '30:19': {
      'inputs': { 'value': 'original prompt' },
      'class_type': 'PrimitiveStringMultiline',
      '_meta': { 'title': 'Text String' },
    },
  });

  it('applyAliases replaces primitive values', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null },
    ];
    const result = applyAliases(sampleJson, params, { img_desc: 'a cute cat' });
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('a cute cat');
  });

  it('applyAliases does not modify node connections (arrays)', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '29', fieldName: 'images', alias: 'img_alias', label: null },
    ];
    const result = applyAliases(sampleJson, params, { img_alias: 'something' });
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed['29'].inputs.images)).toBe(true);
  });

  it('applyAliases throws on missing alias value', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null },
    ];
    expect(() => applyAliases(sampleJson, params, {})).toThrow('Missing required parameter: img_desc');
  });

  it('applyAliases ignores params for non-existent nodes', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: 'nonexistent', fieldName: 'value', alias: 'x', label: null },
    ];
    const result = applyAliases(sampleJson, params, { x: 'val' });
    expect(result).toBe(sampleJson);
  });
});
```

（实际上 executor.service.test.ts 没有直接测 `executeWorkflow`（它依赖网络），所以可能不需要改。）

- [ ] **Step 2: 修改 workflow.routes.test.ts**

execute 相关测试需要适配新返回格式：

```typescript
it('POST /api/workflows/:id/execute without auth returns 502 (ComfyUI unreachable)', async () => {
  const res = await supertest(app)
    .post('/api/workflows/test-flow/execute')
    .send({ img_desc: 'cat' });
  expect(res.status).toBe(502);
});
```

改为测试新行为 - 因为没有设置 baseUrl，应该先返回 400：

```typescript
it('POST /api/workflows/:id/execute without auth returns 400 (no base URL)', async () => {
  const res = await supertest(app)
    .post('/api/workflows/test-flow/execute')
    .send({ img_desc: 'cat' });
  expect(res.status).toBe(400);
});
```

这个测试已经存在且正确，不需要改。但如果需要测试异步执行成功路径，需要 mock fetch，这比较复杂。目前的测试覆盖基本情况即可。

- [ ] **Step 3: 运行测试验证**

Run: `pnpm --filter server test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/executor.service.test.ts packages/server/src/routes/workflow.routes.test.ts
git commit -m "test: 适配新接口的测试"
```

---

### Task 9: 前端 Tasks API

**Files:**
- Create: `packages/client/src/api/tasks.ts`

- [ ] **Step 1: 创建 tasks API 模块**

```typescript
import client from './client';

export interface TaskLog {
  id: string;
  workflowId: string;
  workflowName: string;
  promptId: string | null;
  aliasValues: string;
  comfyuiUrl: string;
  comfyuiRequestBody: string | null;
  comfyuiResponse: string | null;
  status: 'pending' | 'completed' | 'failed';
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export async function listTasks(): Promise<TaskLog[]> {
  const res = await client.get<TaskLog[]>('/tasks');
  return res.data;
}

export async function getTask(id: string): Promise<TaskLog> {
  const res = await client.get<TaskLog>(`/tasks/${id}`);
  return res.data;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/api/tasks.ts
git commit -m "feat: 前端 Tasks API"
```

---

### Task 10: 前端 TaskListPage

**Files:**
- Create: `packages/client/src/pages/TaskListPage.vue`

- [ ] **Step 1: 创建 TaskListPage**

```vue
<template>
  <v-app-bar color="primary">
    <v-app-bar-title>任务日志</v-app-bar-title>
    <template #append>
      <v-btn icon to="/admin">
        <v-icon>mdi-chevron-left</v-icon>
      </v-btn>
    </template>
  </v-app-bar>

  <v-container>
    <v-card>
      <v-data-table
        :headers="headers"
        :items="tasks"
        :loading="loading"
        item-value="id"
        @click:row="openDetail"
      >
        <template #item.createdAt="{ value }">
          {{ formatTime(value) }}
        </template>
        <template #item.status="{ value }">
          <v-chip
            :color="statusColor(value)"
            size="small"
          >
            {{ statusText(value) }}
          </v-chip>
        </template>
        <template #item.completedAt="{ value }">
          {{ value ? formatTime(value) : '-' }}
        </template>
        <template #item.actions="{ item }">
          <v-btn
            icon="mdi-information-outline"
            size="small"
            variant="text"
            @click.stop="openDetail(item)"
          />
        </template>
      </v-data-table>
    </v-card>

    <!-- 详情对话框 -->
    <v-dialog v-model="detailDialog" max-width="800">
      <v-card v-if="selectedTask">
        <v-card-title>任务详情</v-card-title>
        <v-card-text>
          <v-list>
            <v-list-item>
              <v-list-item-subtitle>任务 ID</v-list-item-subtitle>
              <v-list-item-title>{{ selectedTask.id }}</v-list-item-title>
            </v-list-item>
            <v-list-item>
              <v-list-item-subtitle>工作流</v-list-item-subtitle>
              <v-list-item-title>{{ selectedTask.workflowName }}</v-list-item-title>
            </v-list-item>
            <v-list-item>
              <v-list-item-subtitle>状态</v-list-item-subtitle>
              <v-list-item-title>
                <v-chip :color="statusColor(selectedTask.status)" size="small">
                  {{ statusText(selectedTask.status) }}
                </v-chip>
              </v-list-item-title>
            </v-list-item>
            <v-list-item>
              <v-list-item-subtitle>提交时间</v-list-item-subtitle>
              <v-list-item-title>{{ formatTime(selectedTask.createdAt) }}</v-list-item-title>
            </v-list-item>
            <v-list-item v-if="selectedTask.completedAt">
              <v-list-item-subtitle>完成时间</v-list-item-subtitle>
              <v-list-item-title>{{ formatTime(selectedTask.completedAt) }}</v-list-item-title>
            </v-list-item>
            <v-list-item v-if="selectedTask.promptId">
              <v-list-item-subtitle>ComfyUI Prompt ID</v-list-item-subtitle>
              <v-list-item-title>{{ selectedTask.promptId }}</v-list-item-title>
            </v-list-item>
            <v-list-item v-if="selectedTask.errorMessage">
              <v-list-item-subtitle>错误信息</v-list-item-subtitle>
              <v-list-item-title class="text-error">{{ selectedTask.errorMessage }}</v-list-item-title>
            </v-list-item>
          </v-list>

          <v-expansion-panels>
            <v-expansion-panel title="提交参数">
              <v-expansion-panel-text>
                <pre class="text-caption">{{ formatJson(selectedTask.aliasValues) }}</pre>
              </v-expansion-panel-text>
            </v-expansion-panel>
            <v-expansion-panel title="请求 URL">
              <v-expansion-panel-text>
                <pre class="text-caption">{{ selectedTask.comfyuiUrl }}</pre>
              </v-expansion-panel-text>
            </v-expansion-panel>
            <v-expansion-panel title="请求体">
              <v-expansion-panel-text>
                <pre class="text-caption">{{ selectedTask.comfyuiRequestBody ? formatJson(selectedTask.comfyuiRequestBody) : '-' }}</pre>
              </v-expansion-panel-text>
            </v-expansion-panel>
            <v-expansion-panel title="ComfyUI 响应">
              <v-expansion-panel-text>
                <pre class="text-caption">{{ selectedTask.comfyuiResponse ? formatJson(selectedTask.comfyuiResponse) : '-' }}</pre>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="detailDialog = false">关闭</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { listTasks, type TaskLog } from '@/api/tasks';

const headers = [
  { title: '提交时间', key: 'createdAt' },
  { title: '工作流', key: 'workflowName' },
  { title: '状态', key: 'status' },
  { title: '完成时间', key: 'completedAt' },
  { title: '操作', key: 'actions', sortable: false },
];

const tasks = ref<TaskLog[]>([]);
const loading = ref(true);
const detailDialog = ref(false);
const selectedTask = ref<TaskLog | null>(null);

let pollTimer: number | undefined;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'pending': return 'orange';
    case 'completed': return 'green';
    case 'failed': return 'red';
    default: return 'grey';
  }
}

function statusText(status: string): string {
  switch (status) {
    case 'pending': return '处理中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    default: return status;
  }
}

async function openDetail(item: TaskLog) {
  selectedTask.value = item;
  detailDialog.value = true;
}

async function fetchTasks() {
  try {
    tasks.value = await listTasks();
  } catch {
    // 忽略错误
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  fetchTasks();
  // 每 1 秒刷新任务状态
  pollTimer = window.setInterval(fetchTasks, 1000);
});

onUnmounted(() => {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
  }
});
</script>
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/pages/TaskListPage.vue
git commit -m "feat: 任务日志列表页"
```

---

### Task 11: 前端路由 + 导航入口

**Files:**
- Modify: `packages/client/src/router/index.ts`
- Modify: `packages/client/src/pages/WorkflowListPage.vue`

- [ ] **Step 1: 添加 /admin/tasks 路由**

在 router/index.ts 中添加：

```typescript
{
  path: '/admin/tasks',
  name: 'TaskList',
  component: () => import('@/pages/TaskListPage.vue'),
},
```

- [ ] **Step 2: WorkflowListPage 添加导航按钮**

修改 `WorkflowListPage.vue` 的 `<v-app-bar>`，添加"任务日志"按钮：

查找 `<v-app-bar>` 内的现有按钮，添加：

```vue
<v-btn to="/admin/tasks" prepend-icon="mdi-clipboard-text">
  任务日志
</v-btn>
```

在现有的 `<template #append>` 或 `<v-app-bar>` 内容区域添加。

确认 `WorkflowListPage.vue` 的 app-bar 结构后，精确插入。

- [ ] **Step 3: 验证前端编译**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/router/index.ts packages/client/src/pages/WorkflowListPage.vue
git commit -m "feat: 添加 /admin/tasks 路由和导航入口"
```

---

### Task 12: 端到端验证

- [ ] **Step 1: 运行后端测试**

Run: `pnpm --filter server test`
Expected: All tests pass

- [ ] **Step 2: 验证后端类型**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: No errors

- [ ] **Step 3: 验证前端类型**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: No errors
