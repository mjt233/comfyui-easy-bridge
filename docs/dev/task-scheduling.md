# 任务调度与队列（待调度 / 已提交）

> 本文是任务队列、统一调度器与分组自动分配的完整说明。
> `AGENTS.md` 只保留摘要与指引，实现细节以本文为准。
>
> 相关文档：[分组自动分配设计（历史）](../superpowers/specs/2026-08-13-provider-group-auto-dispatch-design.md)、
> [本次重构实现方案](../impl/2026-09-30-task-queue-refactor-impl.md)。

## 1. 概念定义

| 概念 | 任务状态 | 含义 |
|---|---|---|
| **待调度** | `queued` | 系统收到提交请求后任务先进入此队列；目标执行提供商（分组或具体实例）没有空闲可用时一直排队等待 |
| **已提交** | `pending` / `completed` / `failed` | 工作流已真实提交到某个具体执行提供商实例（ComfyUI / RunningHub） |

- 匹配的执行提供商一旦可用，就**按入队顺序（`created_at` 升序）**把任务提交执行。
- `execute` **不再有「实例空闲则直接提交」的旁路**：无论目标是分组还是具体实例，一律先入队，
  再由调度器投递（目标空闲时表现为"立即执行"，但走的是同一条路径）。

## 2. 状态与归属字段

任务日志用两个字段对回答"用了哪个提供商 / 实际提交到哪个实例"：

| 字段 | 语义 |
|---|---|
| `provider_id` / `provider_name` | **选择的提供商**：入队时的选择，或人工改派后的目标；可能为分组 |
| `actual_provider_id` / `actual_provider_name` | **实际执行实例**：具体实例目标在入队/改派时即锁定；分组目标由调度器选定成员后写入 |
| `comfyui_url` | 提交地址：具体实例为 `{baseUrl}/prompt`；分组无自有端点，沿用 `/prompt` 占位 |

时间字段：`created_at`（入队）→ `started_at`（首次进入 pending，即真实提交成功）→ `completed_at`（终态）。
排队时长不计入执行耗时。

## 3. 统一调度器

实现：`packages/server/src/services/dispatcher.service.ts`。
**全部 queued 任务都由它消费**——历史上并行的两套消费逻辑（分组 `DispatcherService.drainGroup` 与
实例跟踪器内的 `drainQueue`）已合并删除，实例跟踪器只做状态跟踪。

### 3.1 队列划分

| 队列 | 归属判定 | 消费入口 |
|---|---|---|
| 实例队列 | `actual_provider_id` 已锁定为该实例 | `drainProvider(providerId)` |
| 分组队列 | `provider_id` 为分组 且 `actual_provider_id` 为空 | `drainGroup(groupId)` |

- 队列查询统一入口：`TaskService.listQueuedByTarget(targetId)`（一次查询覆盖上面两种形态）。
- 槽位占用统一按 `countPendingByActualProvider(providerId)` 统计（分组任务提交后 `actual_provider_id`
  即成员实例，因此与具体实例任务口径一致）。

### 3.2 提交流程（`submitToProvider`）

```
1. 校验任务仍为 queued 且请求体存在（缺失 → failed 'Missing request body'）
2. 探测目标实例：GET {baseUrl}/system_stats（3s 超时）
   └─ 失败 → markFailedNow 进入冷却；分组场景改投下一候选，实例场景本轮结束
3. 上传暂存媒体到目标实例（各实例文件存储相互独立）
   └─ 失败 → 按实例故障处理（冷却 + 改投），任务保留在队列
4. 用上传返回的文件名回写请求体（暂存名 → 实例侧真实文件名）
5. 提交 prompt
   ├─ 成功 → 写 actual_provider_* 与 prompt_id，任务转 pending，释放暂存目录
   ├─ 4xx（工作流本身问题，`isPermanentSubmitError`）→ 任务置 failed，继续处理下一个任务
   └─ 其他（瞬时故障）→ 目标实例进入冷却，任务保留在队列改投其他候选
```

### 3.3 触发时机

`drainAll()` 对每个启用中的非分组实例与每个启用中的分组各跑一轮，由以下事件触发：

- 提交入口（`POST /api/workflows/:id/execute`）入队后同步触发一次；
- 任务进入终态后的槽位释放回调（跟踪器 WebSocket/轮询路径）；
- 人工干预入口：改派（`PATCH /api/tasks/:id/provider`）、插队（`POST /api/tasks/:id/submit`）、
  取消排队任务（`POST /api/tasks/:id/cancel`）；
- 健康巡检回调（`health.service.ts` 每 30s 一轮，实例恢复可用后立即消费队列）；
- 调度器兜底扫描（`dispatcherConfig.fallbackIntervalMs`，默认 30s）；
- 执行服务启动/重建（`startExecutionService`，让重启前的排队任务尽快执行）。

### 3.4 并发保护

- `taskInFlight`：任务级 in-flight 集合，避免同一任务被两轮调度重复提交；
- `groupInFlight` / `providerInFlight`：队列级串行，同一队列同时只跑一轮；
- `attemptedMembers`：分组每轮调度中"已尝试且失败"的成员，避免反复打同一个故障实例；
- `maxSubmitsPerRound`（默认 50）：单轮提交上限，防御异常情况下长时间占用事件循环。

## 4. 媒体上传时机与文件名回写

ComfyUI / RunningHub 的文件存储各自独立，`uploadMedia()` 返回的才是**该实例上的真实文件名**
（原生 ComfyUI 上传时会重新生成唯一名，RunningHub 由平台分配）。

- 入队时尚不确定真正执行的实例，媒体一律先落盘 `DATA_DIR/task-staging/<taskId>/`，
  并把「本地生成的暂存名」作为占位注入工作流；
- 调度器提交前把暂存文件上传到目标实例，并用返回的文件名回写请求体
  （`dispatcher.rewriteUploadedFilenames`，按值替换 `prompt` 子树中的文件名，含数组与嵌套对象）；
- 任务记录中的 `comfyui_request_body` **始终保留暂存名形态**：改投其他实例重试时会拿到该实例自己的
  文件名，以同一份暂存信息为基准重新回写即可；
- 实例侧真实文件名追加进 `uploaded_files`（`TaskService.addUploadedFiles`），供终态后的资产自动清理；
- 暂存目录在提交成功、任务终态、提交失败时释放；进程启动时清理超过 24h 的残留目录
  （`cleanupStaleStaging`）。

> 说明：`execute` 统一入队后，**具体实例目标的任务同样走暂存**（不再先上传到实例再排队），
> 因此排队期间改派到别的实例也能正确重传。

## 5. 分组（自动分配）提供商

### 5.1 配置与成员

- `group` 类型**自身不执行任务**（无自有端点），作为自动分配载体：
  配置为 `{ dispatchPolicy: 'priority'|'random', members: [{ providerId, weight }] }`；
- **实例是否参与自动分配 = 它是否被某个分组选为成员**（没有独立的「可被自动分配」开关）；
  成员权重即算力性能权重（正数，缺省 1，非法值规范化为 1）；
- 分组成员仅限 `comfyui` / `runninghub`（**分组不可嵌套**）；停用或已删除的成员自动跳过；
- 提交到分组时若没有任何可参与自动分配的成员 → 400 `provider_no_available_instance`。

### 5.2 候选挑选规则

从「健康（未处于冷却）+ 有空闲槽位 + 本轮未失败过」的成员中：

- `priority`（缺省）：按权重降序取第一个；权重相同时按分组成员配置顺序；
- `random`：等概率随机挑选一个。

### 5.3 可用性检测与冷却

| 项 | 取值 |
|---|---|
| 探测方式 | `GET {baseUrl}/system_stats`（RunningHub 的 proxy 同为 ComfyUI 兼容接口） |
| 单次探测超时 | 3s（`connectivityProbeConfig.timeoutMs`） |
| 巡检间隔 | 30s（`healthCheckConfig.sweepIntervalMs`） |
| 失败阈值 | 连续 2 次（`failureThreshold`） |
| 冷却时长 | 60s（`cooldownMs`） |
| 巡检范围 | 启用中的分组所引用、且自身启用的成员实例（按实例 ID 去重） |

- 冷却结束即自动恢复可用（冷却语义是"暂停使用一段时间"而非永久拉黑），恢复后由提交前的即时探测兜底；
- 提交探测成功、巡检探测成功都会清零失败计数并解除冷却；
- **提交失败或媒体上传失败**按实例故障即时冷却（`markFailedNow`）并改投下一个候选，任务保留在队列。

## 6. 人工干预（仅 queued 任务）

分类原则：**「修改执行实例」只影响自动调度，「立即提交」才是插队**。

### 6.1 修改执行实例

`PATCH /api/tasks/:taskId/provider`，请求体 `{ providerId }`。

- 目标可以是**任意启用中的实例（含分组）**；
- 语义：改写调度归属，**不会立即提交**——目标实例空闲时才由调度器按队列顺序提交；
- 目标为具体实例 → `provider_id`/`provider_name` 与 `actual_provider_id`/`actual_provider_name`
  一并写为该实例，`comfyui_url` 更新为其提交地址；
- 目标为分组 → `provider_id` 写为分组、`actual_provider_id` 清空（待调度器选定成员后回填）；
- 目标分组当前没有可分配成员时**允许保存**，但响应附带 `warning` 提示任务将持续排队，
  直到分组配置成员或再次调整执行实例；
- 处理完立刻调度一轮并等待完成，响应中的 `status` 即调度后的真实状态。

### 6.2 立即提交（插队）

`POST /api/tasks/:taskId/submit`，请求体 `{ providerId }`。

- **必须显式传具体实例**：分组没有自有提交端点，传分组返回 400 `provider_not_configured`；
- 目标实例连通即**无视并发上限**直接提交工作流（真插队）；
- **插队即改道**：归属一并改为该实例（`provider_id` 与 `actual_provider_id` 都指向它），
  使任务日志体现实际提交到的实例；
- 目标实例探测/上传失败 → 返回 502 `comfyui_unreachable`，任务**保持 queued**（不置 failed），
  用户可改选其他实例重试。

### 6.3 取消

`POST /api/tasks/:taskId/cancel`：queued 任务直接置 failed 并触发一轮调度（让后续排队任务补位）；
pending 任务先向执行端发中断并确认停止（走 `actualProviderId`），未能确认时返回 502
`interrupt_unconfirmed` 且任务保持 pending。

## 7. 前端展示

`packages/client/src/pages/TaskListPage.vue`：

- 【任务日志】页分为**【待调度】**与**【已提交】**两个页签（带数量角标）；
  待调度 = `status==='queued'`，已提交 = 其余（含 `failed`，历史记录不丢失）；
- 待调度页签列：提交时间 / 工作流 / 选择的提供商 / 状态 / 操作（**修改实例**、**立即提交**、详情），
  分组目标在提供商列标注「分组」标签；
- 已提交页签列：提交时间 / 工作流 / 选择的提供商 / **实际执行实例** / 状态 / 输出 / 执行耗时 /
  完成时间 / 操作（中断、详情）；实际执行实例列对分组自动分配的任务标注「自动分配」标签；
- 「修改实例」弹窗列出全部启用实例（分组带「（分组）」后缀），目标分组无成员时内联警告；
- 「立即提交」弹窗**只列具体实例**，并按「当前分组的成员实例 / 其他实例」分组展示；
- 详情弹窗区分展示「选择的提供商」与「实际执行实例」（待调度任务显示"待调度（尚未提交到具体实例）"）。

## 8. 代码位置索引

| 模块 | 职责 |
|---|---|
| `services/dispatcher.service.ts` | 统一调度器：实例队列 + 分组队列消费、候选挑选、提交、媒体上传与文件名回写、插队入口 |
| `services/execution.service.ts` | 启动健康巡检与调度器；按实例维护状态跟踪器（WebSocket / 轮询终态、进度、输出回填、终态清理） |
| `services/providers/group.provider.ts` | `GroupProvider`：分组配置与成员列表，执行类方法显式报错 |
| `services/providers/health.service.ts` | 健康状态表、巡检定时器、冷却与恢复判定 |
| `services/providers/provider.service.ts` | 实例 CRUD、成员解析（过滤/去重/排除分组）、摘要与空闲槽位 |
| `services/task-staging.service.ts` | 暂存文件写入/读取/释放/过期清理 |
| `services/task.service.ts` | `listQueuedByTarget`、`setTargetProvider`、`setActualProvider` / `updateActualProvider`、`addUploadedFiles` |
| `services/executor.service.ts` | `applyAliases`、`processMediaParams`（预览路径上传）、`collectUploadedFilenames` |
| `controllers/workflow.controller.ts` | `execute` 统一入队（媒体暂存 + 立即调度）、`simulateBuild` 预览 |
| `controllers/task.controller.ts` | 改派、插队、取消、输出回源与下载 |
| `pages/TaskListPage.vue` | 待调度/已提交两页签、改派与插队弹窗、详情弹窗 |

## 9. 错误码

| code | 场景 |
|---|---|
| `provider_no_available_instance` | 提交到分组时该分组没有任何可参与自动分配的成员（400） |
| `provider_not_configured` | 工作流/改派/插队显式指定的实例不存在、已停用或配置非法；插队目标为分组（400） |
| `invalid_status` | 对非 queued 任务执行改派或插队、对终态任务执行取消（400） |
| `comfyui_unreachable` | 插队提交时目标实例探测/上传失败（502，任务保持 queued） |
| `interrupt_unconfirmed` | 中断请求已发出但未能确认执行端已停止（502，任务保持 pending） |
| `missing_parameter` | 改派/插队缺少 `providerId`，或任务缺少请求体（400） |
| `task_not_found` | 任务不存在（404） |

## 10. 测试覆盖

| 测试文件 | 覆盖点 |
|---|---|
| `services/dispatcher.service.test.ts` | 权重优先与同权重次序、跳过满载成员、全满留队列、探测失败改投、冷却成员跳过、随机策略、单轮填满并发、4xx 永久失败、5xx 保留队列、并发触发不重复提交、缺请求体失败、停用分组/实例不消费队列、实例队列独立调度、插队（无视并发、探测失败保持排队）、暂存媒体上传与文件名回写 |
| `services/execution.service.test.ts` | 启动消费队列、实例变更重建、显式触发全量调度、槽位释放后的周期性自愈、提交失败日志、状态探测数据源（RunningHub 平台接口 / ComfyUI history） |
| `routes/task.routes.test.ts` | 改派到具体实例/分组（空分组警告、槽位满仍排队）、改派与插队的参数/状态校验、插队改道与不可达保持排队、取消触发的队列自愈 |
| `routes/workflow-group.routes.test.ts` | 分组直接执行、无成员 400、满载入队后投递、按指定成员插队、插队到分组被拒、媒体暂存到成员上传、分组任务中断 |
| `routes/workflow.routes.test.ts` | execute 统一入队（含动态构建、显式 providerId 覆盖、类型覆盖、媒体暂存与清理名单） |
