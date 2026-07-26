# 任务并发控制与进度追踪设计

## 背景

控制提交到 ComfyUI 的并发任务数量，超限任务进入队列等待。支持实时进度查看和手动插队提交。

## 状态流转

```
queued → pending → completed
              \→ failed
```

- `queued`: 超出并发限制，排队中
- `pending`: 已提交到 ComfyUI，正在执行
- `completed`/`failed`: 终态

## 数据库

`task_logs` 表新增字段：
- `progress: integer` — 0-100 执行进度百分比，nullable

## 后端架构

### 设置
- key `comfyui_concurrency`，默认值 `'1'`

### 新文件
- `services/comfyui.service.ts` — WebSocket 连接 + 队列调度

### 修改文件

**TaskService** — 新增：
- `countByStatus(status)` — 统计某状态的任务数
- `listQueued()` — 获取所有 queued 任务（按创建时间升序）
- `updateProgress(id, progress)` — 更新进度

**WorkflowController.execute** — 改为：
1. 验证参数
2. 获取并发数配置
3. 统计 `pending` 任务数
4. 若 `pending >= concurrency` → 创建 `queued` 任务
5. 否则 → 提交 ComfyUI → 创建 `pending` 任务

**ComfyUIService** — 替换 PollingService：
- 连接 ComfyUI WebSocket (`ws://{host}:{port}/ws`)
- 监听 `progress` 事件 → 更新 task progress
- 监听 `execution_complete` → 更新 completed，调用 `drainQueue()`
- 监听 `execution_error` → 更新 failed，调用 `drainQueue()`
- 30 秒后备轮询 `/history` 补偿丢失消息
- 自动重连（指数退避）
- drainQueue: 当 `pending < concurrency` 时取出最旧 queued 任务提交

**TaskController** — 新增：
- `submit(taskId)` — 立即提交 queued 任务（无视并发限制）

**TaskRoutes** — 新增 `POST /:taskId/submit`

## 前端变更

### SettingsPage
- 新增"ComfyUI 任务执行并发数"数字输入框，min=1

### TaskListPage
- 状态 chip: `queued`=蓝色 `排队中`
- 新增"进度"列，pending 状态显示 `<v-progress-linear>`
- queued 状态行显示"立即提交"按钮

### API
- `api/settings.ts` — 无变更（通用接口已支持任意 key/value）
- `api/tasks.ts` — 新增 `submitTask(id)` 函数
