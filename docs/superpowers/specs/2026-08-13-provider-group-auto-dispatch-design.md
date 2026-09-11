# 分组（自动分配）执行提供商设计

日期：2026-08-13

## 背景与目标

同一套工作流可能需要在多个 ComfyUI / RunningHub 实例之间分摊负载。此前后端只支持
「一个实例 = 一个执行目标」，用户必须为每个工作流手工指定实例，无法表达
「这台机器强、那台机器弱，优先用强的，强的忙了再用弱的」。

本设计新增第三种提供商类型 **分组（group）**：分组自身不执行任务，而是把提交上来的任务
先放入一个独立队列，待某个成员实例出现空闲并发时，按配置的调度规则挑选成员并最终提交。

## 关键决策（与需求澄清一致）

| 决策点 | 结论 |
|---|---|
| 自动分配的载体 | 新增提供商类型 `group`，由用户动态创建、启用/停用 |
| 全局「自动分配」开关 | 不需要：停用分组实例即关闭该分组的自动分配 |
| 「是否可被自动分配」字段 | 已取消：**实例是否被某个分组选为成员**即表示它参与自动分配 |
| 成员范围 | 仅 `comfyui` / `runninghub`；分组不可嵌套 |
| 算力性能权重 | 存在分组 config 的成员项上（正整数，缺省 1） |
| 调度规则 | `priority`（按权重优先，缺省）/ `random`（随机） |
| 启用/停用 | 实例级开关，任意类型通用，未配置视为启用 |
| 工作流显式指定已停用实例 | 硬报错 400 `provider_not_configured`，不静默回退默认实例 |
| 分组无可用成员 | 提交时 400 `provider_no_available_instance` |
| 可用性检测 | 后台 30s 巡检 + 连续 2 次失败进入 60s 冷却；提交前对候选再即时探测一次 |

## 数据模型

### providers 表（无结构变更）

分组配置整体存入 `config` JSON：

```jsonc
{
  "dispatchPolicy": "priority",          // priority | random
  "members": [
    { "providerId": "<实例 ID>", "weight": 3 }   // 权重正整数，缺省 1
  ]
}
```

`enabled`（0/1）沿用既有语义，作为所有类型的实例级启用开关。

### task_logs 表（迁移 v11）

| 列 | 说明 |
|---|---|
| `actual_provider_id` | 实际执行任务的成员实例 ID；仅分组任务调度成功后写入 |
| `actual_provider_name` | 实际执行任务的成员实例名称（冗余，实例改名/删除后可溯源） |

`provider_id` / `provider_name` 语义不变，仍记录**用户选择**的实例（分组任务即为分组本身）。

**回填**：并发统计口径改为按 `actual_provider_id`，为避免升级前已在执行的
pending 任务不再占用槽位，迁移把非分组任务的 pending 行回填为原 `provider_id`。

## 调度流程

```
POST /api/workflows/:id/execute  (providerId 解析到分组)
  ├─ 动态构建（若启用）→ 失败按既有逻辑记 failed
  ├─ 媒体参数：生成存储名 → 落盘 <DATA_DIR>/task-staging/<taskId>/ → 注入本地存储名
  ├─ 解析可分配成员（启用 + 非分组 + 可实例化）→ 为空则 400 provider_no_available_instance
  ├─ 建任务记录（providerId = 分组）→ status = queued
  └─ 立即触发一次该分组的调度（同步），据实返回 pending / queued
后台调度（提交时 / 成员槽位释放后 / 巡检后 / 30s 兜底扫描 / 服务启动）
  └─ 逐分组消费队列（FIFO）：
       1. 挑候选：健康（未冷却）+ 有空闲槽位 + 本轮未失败过
          - priority：权重降序取首个（权重相同按成员配置顺序）
          - random：在候选中等概率随机
       2. 对候选即时探测 GET /system_stats
          - 失败 → 该成员进入冷却，改投下一个候选
       3. 二次确认槽位仍空闲
       4. 上传暂存媒体到该成员（各实例文件存储相互独立）
       5. 提交 prompt → 成功则写 actual_provider_*，任务转 pending
          - 4xx（工作流问题）→ 任务置 failed，继续处理下一个任务
          - 其他（实例故障）→ 成员进入冷却，任务留在队列改投其他候选
```

### 为什么媒体要在调度阶段上传

ComfyUI / RunningHub 的文件存储各自独立（`uploadMedia` 返回的是该实例上的文件名）。
分组任务在排队期间**尚无执行实例**，因此先把文件落到本地暂存目录并提前确定存储名，
调度选定成员后再把暂存文件上传到该成员；注入工作流的值与暂存阶段一致，
因此无需在调度阶段改写请求体。

暂存目录在任务成功提交、进入终态、提交失败时统一释放；进程启动时清理超过 24h 的残留目录。

## 并发与队列隔离

- 分组任务入队时 `provider_id = 分组`、`actual_provider_id = NULL`，因此**不会被任何成员实例的
  跟踪器消费**（成员跟踪器按 `actual_provider_id` 过滤）。
- 分组自身不注册跟踪器（没有可执行端点），其队列只由分组调度器消费，天然隔离、无双重提交。
- 所有并发统计统一按 `actual_provider_id`：普通任务该字段即其 `provider_id`，
  分组任务则是真正执行任务的成员实例。

## 可用性检测

| 项 | 取值 |
|---|---|
| 探测方式 | `GET {baseUrl}/system_stats`（RunningHub 的 proxy 同为 ComfyUI 兼容接口） |
| 单次探测超时 | 3s（`connectivityProbeConfig.timeoutMs`） |
| 巡检间隔 | 30s（`healthCheckConfig.sweepIntervalMs`） |
| 失败阈值 | 连续 2 次（`failureThreshold`） |
| 冷却时长 | 60s（`cooldownMs`） |
| 巡检范围 | 启用中的分组所引用、且自身启用的成员实例（按实例 ID 去重） |

冷却结束即自动恢复可用：冷却语义是「暂停使用一段时间」而非永久拉黑，恢复后由挑选前的
即时探测兜底。巡检与提交探测成功都会清零失败计数并解除冷却。

## 对外接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/providers` | 列表；分组附带 `dispatchPolicy` / `memberCount` / `availableSlots` / `members[]` / `health` |
| GET | `/api/providers/:id/health` | 单个实例的健康快照（分组返回成员明细与空闲槽位） |
| POST | `/api/providers` | 新建，`type: "group"` 时 `config = { dispatchPolicy, members }` |
| PUT | `/api/providers/:id` | 更新（分组始终回传 config） |
| POST | `/api/providers/:id/test` | 分组测试「是否至少有一个成员可用」 |
| POST | `/api/tasks/:id/submit` | 分组排队任务等价于「立即触发一次自动分配」 |

## 错误码

| code | 场景 |
|---|---|
| `provider_no_available_instance` | 提交到分组时该分组没有任何可参与自动分配的成员（400） |
| `provider_not_configured` | 工作流显式指定的实例不存在/已停用/配置非法，或默认实例不可用（400） |

## 涉及模块

| 模块 | 职责 |
|---|---|
| `services/providers/types.ts` | `ProviderType` + `group`、`GroupProviderConfig`、`testConnection()` |
| `services/providers/group.provider.ts` | `GroupProvider`：承载分组配置与成员列表，执行类方法显式报错 |
| `services/providers/provider.service.ts` | 分组校验、成员解析（过滤/去重/排除分组）、摘要与空闲槽位 |
| `services/providers/health.service.ts` | 健康状态表、巡检定时器、冷却判定 |
| `services/dispatcher.service.ts` | 分组队列调度、候选挑选、提交与暂存媒体上传 |
| `services/task-staging.service.ts` | 暂存文件的写入/读取/释放/过期清理 |
| `services/execution.service.ts` | 启动巡检与调度器；跟踪器按 `actual_provider_id` 统计与消费 |
| `services/executor.service.ts` | `processMediaParams` 支持预置上传文件名 |
| `services/task.service.ts` | `actualProvider*` 读写与按实际执行实例的查询 |

## 测试覆盖

- `providers/provider-group.test.ts`：分组配置校验、权重规范化、成员过滤与去重、嵌套拒绝、
  巡检成员集合、摘要槽位、分组连通性、严格解析（停用/缺失/回退默认）
- `services/dispatcher.service.test.ts`：权重优先与同权重次序、跳过满载成员、全满留队列、
  探测失败改投、冷却成员跳过、随机策略、单轮填满并发、4xx 永久失败、5xx 保留队列、
  并发触发不重复提交、缺请求体失败、停用分组不消费队列；健康阈值/冷却/恢复/巡检范围
- `routes/workflow-group.routes.test.ts`：分组直接执行、无成员 400、满载入队后手动触发投递、
  列表与健康接口、显式指定停用实例 400、显式覆盖为分组、媒体暂存到成员上传、分组任务中断
