# 任务日志系统设计

## 背景

用户通过 ComfyUI Easy Bridge 将工作流任务提交到 ComfyUI 时，需要完整记录执行日志，包括提交时间、参数、请求详情、响应以及状态变化。同时需要在管理后台提供统一的查看入口，并自动检测任务完成状态。

## 状态流转

```
pending → completed
pending → failed
```

只有两个终态。pending 表示已提交但 ComfyUI 尚未完成处理。

## 架构概览

```
POST /api/workflows/:id/execute
  → 创建 task_log 记录 (status=pending)
  → 调用 ComfyUI POST /prompt
  → 存储 ComfyUI 响应 (prompt_id 等)
  → 立即返回 { task_id, status, comfyui_response }

PollingService (setInterval, 3s)
  → 扫描所有 status=pending 的 task_log
  → 调用 ComfyUI GET /history/{prompt_id}
  → 若 completed → 更新 status=completed, completed_at
  → 若 error → 更新 status=failed, error_message, completed_at

Client (GET /api/tasks/:taskId, 每 1s 轮询)
  → 刷新 UI 中的任务状态
```

## 数据库

### task_logs 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| workflow_id | TEXT FK→workflows(id) CASCADE | 关联工作流 |
| workflow_name | TEXT NOT NULL | 冗余存储工作流名称 |
| provider_id | TEXT | 实际执行的提供商实例 ID（可空；历史任务为 null） |
| provider_name | TEXT | 实际执行的提供商实例名称（冗余存储，实例改名/删除后日志仍可溯源；可空，历史任务为 null） |
| prompt_id | TEXT | ComfyUI 返回的 prompt_id |
| alias_values | TEXT NOT NULL | 提交的字段参数 (JSON) |
| comfyui_url | TEXT NOT NULL | 完整请求 URL |
| comfyui_request_body | TEXT | 完整请求体 (JSON) |
| comfyui_response | TEXT | ComfyUI 初始响应 (JSON) |
| status | TEXT NOT NULL DEFAULT 'pending' | pending / completed / failed |
| error_message | TEXT | 失败时的错误信息 |
| created_at | TEXT NOT NULL | 提交时间 |
| completed_at | TEXT | 完成或失败时间 |

## 后端变更

### 新增文件

- `packages/server/src/services/task.service.ts` — `TaskService` 管理 task_logs CRUD 和状态更新
- `packages/server/src/services/polling.service.ts` — `PollingService` 每 3 秒轮询 pending 任务
- `packages/server/src/controllers/task.controller.ts` — 任务列表/详情接口
- `packages/server/src/routes/task.routes.ts` — 路由注册，需 auth 中间件

### 修改文件

- `packages/server/src/models/schema.ts` — 新增 `taskLogs` 表定义
- `packages/server/src/models/db.ts` — 新增 `task_logs` 建表语句
- `packages/server/src/services/executor.service.ts` — `executeWorkflow` 改为返回结构化结果 `{ comfyuiResponse, promptId }` 而非抛异常
- `packages/server/src/controllers/workflow.controller.ts` — execute 改为异步流程：创建 task → 调 ComfyUI → 存响应 → 启动轮询 → 返回 `{ task_id, status, comfyui_response }`
- `packages/server/src/index.ts` — 注册 task 路由，启动 PollingService

## 前端变更

### 新增文件

- `packages/client/src/pages/TaskListPage.vue` — 任务日志列表页
- `packages/client/src/api/tasks.ts` — `listTasks()`、`getTask(id)` API

### 修改文件

- `packages/client/src/router/index.ts` — 新增 `/admin/tasks` 路由
- `packages/client/src/pages/WorkflowListPage.vue` — 工作流列表导航栏增加"任务日志"入口

### TaskListPage 设计

- 表格列：提交时间、工作流名称、参数摘要、状态 (chip)、完成耗时、操作
- 状态 chip 颜色：pending=橙色, completed=绿色, failed=红色
- 点击行展开详情 dialog：完整 URL、请求体、ComfyUI 响应、错误信息
- 每 1 秒轮询刷新 pending/failed 任务状态

## 测试

- `task.service.test.ts` — 单元测试 TaskService CRUD 和状态更新
- `workflow.routes.test.ts` — 适配 execute 接口返回结构变化
- `polling.service.test.ts` — 测试轮询逻辑

## 未涉及

- 不引入外部任务队列或消息中间件
- 不修改现有认证机制
- 不修改工作流 CRUD 接口
