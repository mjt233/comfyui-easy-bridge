# 任务并发控制与进度追踪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 限制提交到 ComfyUI 的并发任务数，超限进入队列排队，支持实时进度和手动插队。

**Architecture:** 新增 `progress` 字段到 taskLogs；新建 ComfyUIService 连接 WebSocket 接收实时进度/完成事件并自动调度队列；WorkflowController 提交时判断并发；前端新增进度条和排队状态。

**Tech Stack:** ws (WebSocket), Drizzle ORM, Express, Vue 3 + Vuetify

---

### Task 1: 数据库加 progress 字段

**Files:**
- Modify: `packages/server/src/models/schema.ts`
- Modify: `packages/server/src/models/db.ts`

在 `taskLogs` 表中追加 `progress` 字段：

```typescript
// schema.ts - taskLogs 表定义中追加
progress: integer('progress'),
```

```sql
-- db.ts - CREATE TABLE 中追加
progress INTEGER
```

验证：`pnpm --filter server exec tsc --noEmit`
提交：`git commit -m "feat: task_logs 新增 progress 字段"`

---

### Task 2: TaskService 新增方法

**Files:**
- Modify: `packages/server/src/services/task.service.ts`

新增方法：

```typescript
import { eq, desc, inArray, count } from 'drizzle-orm';

/** 统计指定状态的任务数 */
countByStatus(status: string): number {
  const row = this.db.select({ c: count() }).from(schema.taskLogs)
    .where(eq(schema.taskLogs.status, status)).get();
  return row?.c ?? 0;
}

/** 获取所有 queued 任务（按提交时间升序） */
listQueued() {
  return this.db.select().from(schema.taskLogs)
    .where(eq(schema.taskLogs.status, 'queued'))
    .orderBy(schema.taskLogs.createdAt).all();
}

/** 更新任务进度百分比 */
updateProgress(id: string, progress: number) {
  this.db.update(schema.taskLogs)
    .set({ progress })
    .where(eq(schema.taskLogs.id, id))
    .run();
  return this.getById(id)!;
}
```

验证：`pnpm --filter server exec tsc --noEmit`
提交：`git commit -m "feat: TaskService 新增 countByStatus/listQueued/updateProgress"`

---

### Task 3: ExecutorService 提取 submitPrompt

**Files:**
- Modify: `packages/server/src/services/executor.service.ts`

提取 `submitPrompt` 函数供 ComfyUIService 和 Controller 共用：

```typescript
/** 提交 prompt 到 ComfyUI 并返回结果 */
export async function submitPrompt(
  body: string,
  comfyuiBaseUrl: string,
): Promise<ExecutionResult> {
  try {
    const response = await fetch(`${comfyuiBaseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await response.text();
    let responseBody: unknown;
    try { responseBody = JSON.parse(text); } catch { responseBody = text; }
    if (!response.ok) {
      return {
        success: false,
        comfyuiResponse: responseBody,
        promptId: null,
        errorMessage: `ComfyUI returned status ${response.status}: ${text}`,
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

并修改 `executeWorkflow` 内部调用 `submitPrompt`：

```typescript
export async function executeWorkflow(
  rawJson: string,
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
  comfyuiBaseUrl: string,
): Promise<ExecutionResult> {
  try {
    const modifiedJson = applyAliases(rawJson, params, aliasValues);
    const body = JSON.stringify({ prompt: JSON.parse(modifiedJson) });
    return submitPrompt(body, comfyuiBaseUrl);
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

验证：`pnpm --filter server exec tsc --noEmit`
提交：`git commit -m "refactor: 提取 submitPrompt 函数供复用"`

---

### Task 4: WorkflowController 并发检查

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`

在 `execute` 方法中，调用 `executeWorkflow` 之前加入并发检查：

```typescript
// 获取并发配置
const concurrencyStr = settingsService.get('comfyui_concurrency');
const concurrency = concurrencyStr ? parseInt(concurrencyStr, 10) : 1;

// 统计当前 pending 任务数
const pendingCount = taskService.countByStatus('pending');

if (pendingCount >= concurrency) {
  // 超过并发，进入排队
  const task = taskService.create({
    workflowId: wf.id,
    workflowName: wf.name,
    aliasValues: JSON.stringify(aliasValues),
    comfyuiUrl: `${baseUrl}/prompt`,
    comfyuiRequestBody: JSON.stringify({ prompt: JSON.parse(modifiedJson) }),
    comfyuiResponse: null,
    promptId: null,
  });
  // 覆盖默认 status（create 默认根据 promptId 判断）
  taskService.updateStatus(task.id, {
    status: 'queued',
  });
  res.json({
    task_id: task.id,
    status: 'queued',
    comfyui_response: null,
  });
  return;
}
```

代码逻辑在原来的 `applyAliases` 验证之后、调用 `executeWorkflow` 之前插入。

验证：`pnpm --filter server exec tsc --noEmit && pnpm --filter server test`
提交：`git commit -m "feat: execute 接口加入并发检查，超限则排队"`

---

### Task 5: ComfyUIService (WebSocket + 队列调度)

**Files:**
- Create: `packages/server/src/services/comfyui.service.ts`
- Delete: `packages/server/src/services/polling.service.ts` (被替换)
- Modify: `packages/server/src/index.ts` (替换注册)

核心服务，连接 ComfyUI WebSocket 接收实时事件，调度队列：

```typescript
import WebSocket from 'ws';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TaskService } from './task.service';
import { SettingsService } from './settings.service';
import { submitPrompt } from './executor.service';

const FALLBACK_INTERVAL = 30000;

export function startComfyUIService(db: BetterSQLite3Database<typeof schema>): { stop: () => void } {
  const taskService = new TaskService(db);
  const settingsService = new SettingsService(db);

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function getBaseUrl(): string | null {
    return settingsService.get('comfyui_base_url');
  }

  function getWsUrl(): string | null {
    const base = getBaseUrl();
    if (!base) return null;
    return base.replace(/^http/, 'ws') + '/ws';
  }

  function getConcurrency(): number {
    const val = settingsService.get('comfyui_concurrency');
    return val ? parseInt(val, 10) : 1;
  }

  /** 调度队列：当 running < concurrency 时取出最旧 queued 任务提交 */
  async function drainQueue(): Promise<void> {
    try {
      const concurrency = getConcurrency();
      const running = taskService.countByStatus('pending');
      if (running >= concurrency) return;

      const queued = taskService.listQueued();
      if (queued.length === 0) return;

      const baseUrl = getBaseUrl();
      if (!baseUrl) return;

      const nextTask = queued[0];
      if (!nextTask.comfyuiRequestBody) {
        taskService.updateStatus(nextTask.id, { status: 'failed', errorMessage: 'Missing request body' });
        return;
      }

      const result = await submitPrompt(nextTask.comfyuiRequestBody, baseUrl);
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
      console.error('[ComfyUIService] drainQueue error', err);
    }
  }

  function connect(): void {
    if (stopped) return;
    const url = getWsUrl();
    if (!url) {
      reconnectTimer = setTimeout(connect, 5000);
      return;
    }

    try {
      ws = new WebSocket(url);
      ws.on('open', () => {
        console.log('[ComfyUIService] WebSocket connected');
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
              // promptId 是 ComfyUI 的 ID，需找到对应 task
              const tasks = taskService.listPending().filter(t => t.promptId === promptId);
              for (const t of tasks) {
                taskService.updateProgress(t.id, pct);
              }
            }
          } else if (msg.type === 'execution_complete' || msg.type === 'execution_success') {
            const tasks = taskService.listPending().filter(t => t.promptId === promptId);
            if (tasks.length > 0) {
              for (const t of tasks) {
                taskService.updateStatus(t.id, { status: 'completed' });
              }
              drainQueue();
            }
          } else if (msg.type === 'execution_error') {
            const tasks = taskService.listPending().filter(t => t.promptId === promptId);
            if (tasks.length > 0) {
              for (const t of tasks) {
                taskService.updateStatus(t.id, {
                  status: 'failed',
                  errorMessage: data.exception_message || 'Execution error',
                });
              }
              drainQueue();
            }
          }
        } catch {
          // ignore parse errors
        }
      });

      ws.on('close', () => {
        if (!stopped) {
          reconnectTimer = setTimeout(connect, 5000);
        }
      });

      ws.on('error', () => {
        // close event will fire and trigger reconnect
      });
    } catch {
      reconnectTimer = setTimeout(connect, 5000);
    }
  }

  // 后备轮询 /history 补偿丢失消息
  function startFallback(): void {
    fallbackTimer = setInterval(async () => {
      try {
        const pending = taskService.listPending();
        if (pending.length === 0) return;
        const baseUrl = getBaseUrl();
        if (!baseUrl) return;

        for (const task of pending) {
          if (!task.promptId) continue;
          try {
            const res = await fetch(`${baseUrl}/history/${task.promptId}`);
            if (res.status === 404) continue;
            if (res.status >= 500) {
              const text = await res.text();
              taskService.updateStatus(task.id, { status: 'failed', errorMessage: `ComfyUI error: ${text}` });
              continue;
            }
            const text = await res.text();
            let data: unknown;
            try { data = JSON.parse(text); } catch { continue; }
            const promptData = (data as Record<string, unknown>)[task.promptId];
            if (!promptData) continue;
            const statusObj = (promptData as { status?: { completed?: boolean } }).status;
            if (statusObj?.completed) {
              taskService.updateStatus(task.id, { status: 'completed', comfyuiResponse: JSON.stringify(data) });
              drainQueue();
            }
          } catch { /* retry next cycle */ }
        }
      } catch { /* ignore */ }
    }, FALLBACK_INTERVAL);
  }

  connect();
  startFallback();

  return {
    stop: () => {
      stopped = true;
      if (ws) { ws.close(); ws = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); }
      if (fallbackTimer) { clearInterval(fallbackTimer); }
    },
  };
}
```

需要安装 `ws` 包：
```bash
pnpm --filter server add ws && pnpm --filter server add -D @types/ws
```

**index.ts 修改：**

```typescript
// 替换
// import { startPollingService } from './services/polling.service';
import { startComfyUIService } from './services/comfyui.service';

// startServer 中
function startServer() {
  startComfyUIService(db);
  app.listen(PORT, () => { ... });
}
```

验证：`pnpm --filter server exec tsc --noEmit && pnpm --filter server test`
提交：`git commit -m "feat: 添加 ComfyUIService (WebSocket+队列调度)，替换 PollingService"`

---

### Task 6: TaskController + TaskRoutes 新增 submit 端点

**Files:**
- Modify: `packages/server/src/controllers/task.controller.ts`
- Modify: `packages/server/src/routes/task.routes.ts`

**task.controller.ts** 新增：

```typescript
import { submitPrompt } from '../services/executor.service';
import { SettingsService } from '../services/settings.service';

// 在 createTaskController 内
const settingsService = new SettingsService(db);

// 返回对象中新增方法
/** 立即提交 queued 任务（无视并发限制） */
async submit(req: Request, res: Response): Promise<void> {
  const task = taskService.getById(req.params.taskId as string);
  if (!task) {
    res.status(404).json({ error: 'Task not found', code: 'task_not_found' });
    return;
  }
  if (task.status !== 'queued') {
    res.status(400).json({ error: 'Task is not in queued status', code: 'invalid_status' });
    return;
  }
  const baseUrl = settingsService.get('comfyui_base_url');
  if (!baseUrl) {
    res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
    return;
  }
  if (!task.comfyuiRequestBody) {
    res.status(400).json({ error: 'Task has no request body', code: 'missing_parameter' });
    return;
  }
  const result = await submitPrompt(task.comfyuiRequestBody, baseUrl);
  if (result.success) {
    taskService.updateStatus(task.id, {
      status: 'pending',
      promptId: result.promptId ?? undefined,
      comfyuiResponse: result.comfyuiResponse ? JSON.stringify(result.comfyuiResponse) : undefined,
    });
    res.json({ task_id: task.id, status: 'pending', comfyui_response: result.comfyuiResponse });
  } else {
    taskService.updateStatus(task.id, {
      status: 'failed',
      errorMessage: result.errorMessage ?? 'Submit failed',
    });
    res.json({ task_id: task.id, status: 'failed', error_message: result.errorMessage });
  }
}
```

**task.routes.ts** 新增路由：

```typescript
router.post('/:taskId/submit', auth, controller.submit);
```

（放在 `/:taskId` 前面以避免冲突）

验证：`pnpm --filter server exec tsc --noEmit`
提交：`git commit -m "feat: 添加 POST /api/tasks/:taskId/submit 端点"`

---

### Task 7: 前端 SettingsPage 添加并发数

**Files:**
- Modify: `packages/client/src/pages/SettingsPage.vue`

```vue
<v-text-field
  v-model="comfyuiUrl"
  label="ComfyUI 服务地址"
  hint="例如: http://localhost:8188"
  variant="outlined"
  class="mb-4"
  placeholder="http://localhost:8188"
/>

<v-text-field
  v-model="concurrency"
  label="ComfyUI 任务执行并发数"
  type="number"
  min="1"
  variant="outlined"
  class="mb-4"
/>

<v-btn color="primary" :loading="saving" @click="handleSave">
  保存
</v-btn>
```

```typescript
const concurrency = ref('1');

async function handleSave() {
  saving.value = true;
  error.value = '';
  try {
    await updateSetting('comfyui_base_url', comfyuiUrl.value);
    await updateSetting('comfyui_concurrency', concurrency.value);
    snackbar.value = { show: true, text: '已保存', color: 'success' };
  } catch {
    error.value = '保存失败';
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    const settings = await getSettings();
    comfyuiUrl.value = settings.comfyui_base_url ?? '';
    concurrency.value = settings.comfyui_concurrency ?? '1';
  } catch {
    error.value = '加载设置失败';
  }
});
```

验证：`pnpm --filter client exec vue-tsc --noEmit`
提交：`git commit -m "feat: 设置页面添加并发数配置"`

---

### Task 8: 前端 TaskListPage 排队状态 + 进度 + 提交按钮

**Files:**
- Modify: `packages/client/src/pages/TaskListPage.vue`
- Modify: `packages/client/src/api/tasks.ts`

**tasks.ts** 新增：

```typescript
/** 立即提交 queued 任务 */
export async function submitTask(taskId: string): Promise<{ task_id: string; status: string }> {
  const res = await client.post<{ task_id: string; status: string }>(`/tasks/${taskId}/submit`);
  return res.data;
}
```

**TaskListPage.vue** 修改：

1. 表头新增"进度"列：

```typescript
const headers = [
  { title: '提交时间', key: 'createdAt' },
  { title: '工作流', key: 'workflowName' },
  { title: '状态', key: 'status' },
  { title: '进度', key: 'progress' },
  { title: '完成时间', key: 'completedAt' },
  { title: '操作', key: 'actions', sortable: false },
];
```

2. 进度列模板：
```vue
<template #item.progress="{ item }">
  <v-progress-linear
    v-if="item.status === 'pending' && item.progress != null"
    :model-value="item.progress"
    color="primary"
    height="6"
    rounded
  >
    <template #default>
      <span class="text-caption">{{ item.progress }}%</span>
    </template>
  </v-progress-linear>
  <span v-else-if="item.status === 'pending' && item.progress == null" class="text-caption text-grey">
    等待中
  </span>
  <span v-else class="text-caption text-grey">-</span>
</template>
```

3. 状态列新增 queued：
```typescript
function statusColor(status: string): string {
  switch (status) {
    case 'queued': return 'blue';
    case 'pending': return 'orange';
    case 'completed': return 'green';
    case 'failed': return 'red';
    default: return 'grey';
  }
}

function statusText(status: string): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'pending': return '处理中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    default: return status;
  }
}
```

4. 操作列新增"立即提交"按钮：
```vue
<template #item.actions="{ item }">
  <v-btn
    v-if="item.status === 'queued'"
    color="primary"
    size="small"
    variant="tonal"
    class="mr-1"
    @click.stop="handleSubmitTask(item.id)"
  >
    立即提交
  </v-btn>
  <v-btn icon="mdi-information-outline" size="small" variant="text" @click.stop="openDetail(item)" />
</template>
```

5. 新增 `handleSubmitTask` 函数：
```typescript
import { submitTask } from '@/api/tasks';

async function handleSubmitTask(taskId: string) {
  try {
    await submitTask(taskId);
    await fetchTasks();
  } catch {
    // ignore
  }
}
```

6. 导入新增 `submitTask`。

验证：`pnpm --filter client exec vue-tsc --noEmit`
提交：`git commit -m "feat: 任务列表新增排队状态/进度条/立即提交按钮"`

---

### Task 9: 验证

- 后端测试：`pnpm --filter server test`
- 后端编译：`pnpm --filter server exec tsc --noEmit`
- 前端编译：`pnpm --filter client exec vue-tsc --noEmit`
