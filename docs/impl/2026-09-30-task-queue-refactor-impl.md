# 任务队列功能重构 — 实现方案

> 需求原文见 `docs/dev-plans/2026-09-30-task-queue-refactor.md`。
> 本方案为与用户多轮澄清后的最终定稿。
>
> **状态：已实现（2026-09-30）**。后端 557 个测试全绿，`tsc --noEmit`（server）与
> `vue-tsc --noEmit`（client）均通过。实现要点与下方方案的差异仅一处：
> 「修改执行实例」与「立即提交（插队）」都改为**等待一轮调度完成后再据实返回状态**
> （否则响应里的 status 会早于调度结果，对使用者是误导）。

## 一、概念与状态模型

| 概念 | 任务状态 | 说明 |
|------|---------|------|
| 待调度 | `queued` | 系统收到提交请求后**一律先入此队列**，不再有"空闲直接提交"路径 |
| 已提交 | `pending` / `completed` / `failed` | 已真实提交到具体执行提供商（RunningHub / ComfyUI 实例）的任务 |

**任务归属字段语义**（两个字段对同时回答"记录了哪个提供商"）：

- `provider_id` / `provider_name`：**用户选择的执行提供商**——入队时的选择；手动修改执行实例 / 立即提交（插队）后覆盖为目标实例。分组任务即为分组本身
- `actual_provider_id` / `actual_provider_name`：**实际执行任务的实例**——非分组目标在入队/改道时即锁定为目标实例；分组目标由调度器在选定成员后写入

## 二、后端重构（破坏性简化）

### 1. 统一调度器（`services/dispatcher.service.ts` 重写）

合并现有两套队列消费逻辑（分组 `DispatcherService.drainGroup` + 实例 `tracker.drainQueue`）为唯一一套：

```
drainAll()
  ├─ 对每个启用中的分组 drainGroup(groupId)
  │     取该分组 queued 任务（按 createdAt 升序）
  │     pickMember（健康 + 空闲槽位 + 权重策略）→ submitTask → pending
  └─ 对每个启用的非分组实例 drainProvider(providerId)
        取 actualProviderId = 该实例 的 queued 任务（按 createdAt 升序）
        槽位空闲 → submitTask → pending
```

- `submitTask(task, targetProvider)` 成为唯一提交入口：
  1. 提交前即时探测 `targetProvider.testConnection()`（3s 超时），失败 → `markFailedNow` 冷却、改投下一候选（分组场景）或本轮结束（指定实例场景）
  2. 上传暂存媒体到目标实例 → `rewriteUploadedFilenames` 回写请求体（复用现有函数）
  3. `submitPrompt` 成功 → `updateActualProvider` 写入实际执行实例 + promptId → `pending`
  4. 永久性失败（4xx，复用 `isPermanentSubmitError`）→ 任务 `failed` + 清理暂存；瞬时失败 → 冷却目标实例、任务保留在队列
- **统一媒体暂存**：所有入队任务的媒体先落盘 `DATA_DIR/task-staging/<taskId>/`（删除"普通任务先上传再排队"路径），调度选定实例后上传；改道重试时基于暂存名形态的请求体重新回写
- **重入保护**：`taskInFlight`（任务级）+ `groupInFlight` / `providerInFlight`（队列级）集合统一在调度器内
- 保留 30s 兜底扫描 `start()` / `stop()`

### 2. 实例跟踪器瘦身（`services/execution.service.ts`）

`createProviderTracker` 只保留**状态跟踪**职责：

- 保留：WebSocket 连接 / `completionPoll` / `fallbackPoll`（探测终态）、进度更新、输出回填、终态清理（`cleanupTaskUploads` + `releaseStaged`）、连续失败计数
- 删除：`drainQueue` / `draining` / `listQueued` / `countPending` / `init` / `drain` 全部队列消费代码
- 槽位释放后统一回调调度器 `drainAll()`（成员实例释放槽位 → 分组队列 + 实例队列都可能可投递）
- `providerDrains` 注册表与 `drainProviderQueue` 导出收敛为调度器入口（`drainProviderQueue` 改为调用调度器对应队列的 drain）

### 3. 提交入口统一（`controllers/workflow.controller.ts` execute）

- 删除 `pendingCount >= concurrency` 分支与"直接提交"路径（`executeWorkflow` 直调、排队前 `processMediaParams` 先上传）
- 所有任务统一：`create`（`status=queued`）→ 媒体暂存落盘（统一 `stageGroupMedia` 逻辑，更名为通用暂存）→ 非分组目标提前写 `actualProviderId` → 触发一次调度 → 据实返回
- 响应结构不变（`task_id` + 调度后实际 status）

### 4. 修改执行实例（新增 API）

`PATCH /api/tasks/:taskId/provider`

- 仅 `queued` 状态可改；请求体 `{ providerId }`，目标必须是**启用中的任意实例（含分组）**
- 目标为非分组实例：`providerId/providerName` + `actualProviderId/actualProviderName` 均写为目标实例；同时更新 `comfyuiUrl` 为目标实例提交地址
- 目标为分组：`providerId/providerName` 写为分组，清空 `actualProviderId/actualProviderName`；`comfyuiUrl` 置为 `''`（分组无端点，与现状一致）
- 目标分组**无可用成员时允许修改**，但响应附带警告文案（该分组无成员，任务将滞留队列直至分组配置成员或再次改道）
- 修改成功后触发一次目标队列的调度
- 前端弹窗：下拉列出全部启用实例，分组在前并在选项中标注「分组」类型

### 5. 立即提交 / 插队（改造现有 `POST /api/tasks/:taskId/submit`）

- 仅 `queued` 状态可用
- **弹窗选择目标非分组实例**（后端强校验 `providerId` 必须为非分组实例；当前分组的成员与其他实例都在候选中，前端弹窗区分「当前分组成员」与「其他实例」两组展示）
- **插队即改道**：`providerId/providerName` + `actualProviderId/actualProviderName` 一并写为目标实例
- 后端流程：探测目标实例连通 → 通过则**无视并发上限**直接走 `submitTask`（含暂存媒体上传 + 文件名回写）→ `pending`；探测失败 → 保持 `queued` 返回错误信息（不置 failed，用户可换实例重试）
- 分组目标不再支持立即提交（无直接端点），旧逻辑（触发一次自动分配）删除

### 6. TaskService 简化（`services/task.service.ts`）

- 删除：`listQueuedByGroups`（调度器改为按目标统一取队列）、`listQueued`（无调用方）、`countByStatus`（execute 不再判断并发）
- 新增：`listQueuedByTarget(targetId)`——按「`providerId = 分组ID`（分组队列）或 `actualProviderId = 实例ID`（实例队列）」统一取排队任务（内部即 `AND status='queued' AND (actualProviderId = ? OR (actualProviderId IS NULL AND providerId = ?))`，按 `createdAt` 升序）
- 保留：`countPendingByActualProvider`（槽位统计）、`setActualProvider` / `updateActualProvider`（修改实例与调度写入复用）

### 7. TaskService 其他调用方收敛

`task.controller.ts`：

- `list` / `getById` / `listOutputFiles` / `downloadOutputFile` / `cancel` / `clearCompleted` 不变
- `cancel`：queued 分支不再区分分组/实例，直接置 failed + 触发调度器 drainAll；pending 分支的中断后 drain 收敛为调度器入口
- 删除 `submit` 旧实现（见上），新增 `PATCH provider` 路由处理

`routes/task.routes.ts`：新增 `PATCH /:taskId/provider`。

### 8. 健康巡检（不变）

`health.service.ts` 30s 巡检成员实例、冷却与恢复逻辑保持；巡检回调改为触发调度器 `drainAll()`。

## 三、前端改造（`pages/TaskListPage.vue` + `api/tasks.ts`）

### 1. 两个页签

`v-tabs` 挂在任务表格上方：

- **待调度**：`status === 'queued'`，按提交时间降序展示；列为 提交时间 / 工作流 / 提供商（当前目标，含分组）/ 状态 / 操作（**修改执行实例**、**立即提交**、中断、详情）
- **已提交**：`status ∈ {pending, completed, failed}`，现有列与交互全部保留（进度环、输出文件、中断、详情）

轮询逻辑不变（1s 拉全量后前端按状态分组到两个页签）。

### 2. 修改执行实例弹窗（待调度页签）

- 下拉候选：全部启用实例，分组标注「分组」后缀；选中分组无成员时表单内联警告（滞留提示）
- 提交 → `PATCH /tasks/:id/provider` → 刷新列表

### 3. 立即提交弹窗（待调度页签）

- 分组显示：**当前分组的成员实例**与**其他实例**两组（分组目标任务时高亮当前分组成员区）
- 仅列非分组实例；选中后 → `POST /tasks/:id/submit`（body `{ providerId }`）→ 刷新
- 提交失败（探测不通）保持 queued，可换实例重试

### 4. 详情弹窗

两个归属字段对始终展示（含 queued 任务）：

- 「选择的提供商」= `providerName`（入队/最近一次人工调整后的目标）
- 「实际执行实例」= `actualProviderName`（非分组目标即该实例；分组目标调度成功后写入；未调度为 `-`）

### 5. API 封装（`api/tasks.ts`）

- `updateTaskProvider(taskId, providerId)` → `PATCH`
- `submitTask(taskId, providerId)` → `POST`（body 携带目标实例）
- `listProviders()`（复用现有 providers API）拉取候选

## 四、不引入数据库迁移

`queued` 状态与四个归属字段均已存在；存量 `queued` 任务在新调度器下可正常消费（普通任务 v11 已回填 `actual_provider_id`；极旧数据的 NULL 归属由 `listQueuedByTarget` 的 fallback 分支兜底为按 `providerId` 消费）。

## 五、测试与验证

| 项 | 内容 |
|----|------|
| `dispatcher.service.test.ts` | 重写：实例队列消费、分组队列消费、改道后重投、探测失败冷却、永久性失败置 failed、媒体上传 + 回写 |
| `execution.service.test.ts` | tracker 不再消费队列；槽位释放触发调度器；终态探测/清理用例保留调整 |
| `task.routes.test.ts` | 新增：PATCH provider（非分组/分组/空分组警告/非法目标）、submit 插队（改道落库、探测失败保持 queued） |
| `workflow.routes.test.ts` | execute 统一入队：空闲实例场景经调度器变为 pending；媒体统一暂存 |
| 类型验证 | `pnpm --filter server exec tsc --noEmit`、`pnpm --filter client exec tsc --noEmit` |
| 全量测试 | `pnpm --filter server test` |

## 六、执行顺序

1. `dispatcher.service.ts` 统一调度器重写（含 `submitTask` / `listQueuedByTarget` 依赖）
2. `task.service.ts` 简化 + `task-staging.service.ts` 复用确认
3. `execution.service.ts` tracker 瘦身 + 调度器接线
4. `workflow.controller.ts` execute 统一入队（删除直接提交分支）
5. `task.controller.ts` + `task.routes.ts`：PATCH provider、submit 插队改造、cancel 收敛
6. 前端 `TaskListPage.vue` 页签 + 两弹窗 + `api/tasks.ts`
7. 测试重写与补齐
8. 类型验证 + 全量测试
9. 更新本文档关联的设计文档段落（`docs/superpowers/specs/2026-08-13-provider-group-auto-dispatch-design.md` 中分组队列描述如与新实现冲突，以新实现为准修订）
