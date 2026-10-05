# 执行提供商（Provider）

> 本文是执行提供商实例的类型、配置、解析语义与资产清理的完整说明。
> `AGENTS.md` 只保留摘要与指引，实现细节以本文为准。
>
> 相关文档：[任务调度与队列](task-scheduling.md)（分组队列、成员挑选、冷却与人工干预）、
> [错误码](error-codes.md)、[数据库与迁移](database.md)、
> [工作流 API 文档](../workflow-api.md)（提供商 CRUD 端点与请求示例）。

## 1. 模型概览

工作流执行通过「执行提供商」实例进行，取代旧的全局设置 `comfyui_base_url` / `comfyui_concurrency`
（旧设置**仅迁移期读取一次**，见 `packages/server/src/models/migrations/v4-execution-providers.ts`）。

- 实例持久化在 `providers` 表：`id` / `name` / `type` / `config`(JSON) / `concurrency`(并发上限) / `enabled`(0/1)
- 抽象接口定义在 `services/providers/types.ts` 的 `ExecutionProvider`；
  新增提供商类型 = 实现该接口 + 在 `ProviderService.instantiate` 注册工厂
- 连通性探测统一为 `GET {baseUrl}/system_stats`，单次超时 3s（`connectivityProbeConfig.timeoutMs`）；
  RunningHub 的 `proxy` 同为 ComfyUI 兼容接口，因此探测方式一致

| 类型 | 配置 | 执行方式 |
|---|---|---|
| `comfyui` | `{ baseUrl, autoCleanup?, inputDir? }` | 直连本机 / 局域网 ComfyUI 原生服务 |
| `runninghub` | `{ apiKey, gpuSize: '24G' \| '48G' }` | RunningHub 云端；基础地址由 `https://www.runninghub.cn/proxy/<apiKey>`（24G）或 `/proxy-plus/<apiKey>`（48G）推导 |
| `group` | `{ dispatchPolicy, members: [{ providerId, weight }], noOnlineInstanceBehavior? }` | **自身不执行任务**（无自有端点），作为自动分配的载体 |

- `dispatchPolicy`：`'priority'`（缺省）/ `'random'` / `'failover'`，挑选规则见
  [任务调度 §5.2](task-scheduling.md#52-候选挑选规则)
- `noOnlineInstanceBehavior`：`'queue'`（缺省）/ `'error'`，见
  [任务调度 §5 分组提供商](task-scheduling.md#5-分组自动分配提供商)
- 分组成员仅限 `comfyui` / `runninghub`（**分组不可嵌套**）；停用或已删除的成员自动跳过

## 2. 实例级启用 / 停用

- `providers.enabled`（0/1，建实例默认 1）适用于**全部类型**；字段未配置即视为启用
- 停用的实例**既不参与解析，也不参与自动分配**（不会成为某个分组的可候选成员）

## 3. 默认实例与解析语义

### 3.1 全局默认实例

- 由设置 `default_provider_id` 指定（`PUT /api/settings`，`{ key: 'default_provider_id', value: '<实例 ID>' }`）
- 默认实例被停用即视为未配置
- 切换默认实例会触发 `notifyProviderChange()`，执行服务重建跟踪器使其立即生效
- 全局默认实例**禁止删除**（返回 409 `default_provider_not_deletable`）；
  删除实例时引用它的工作流自动回退默认（`providerId` 置空）

### 3.2 工作流覆盖与本次执行覆盖

| 层级 | 字段 | 说明 |
|---|---|---|
| 本次执行 | `providerId` 保留键 | `POST /api/workflows/:id/execute` 请求体顶层字段（multipart 模式为同名表单字段），仅本次有效 |
| 工作流配置 | `workflows.provider_id` | 空（`null` / `''`）表示使用全局默认 |
| 系统默认 | `settings.default_provider_id` | 兜底 |

解析顺序：**本次执行显式指定 → 工作流配置 → 全局默认**。

### 3.3 严格解析（执行路径）

`ProviderService.resolveWorkflowProviderStrict(workflowId)`：

- 工作流**显式指定**的实例不存在 / 已停用 / 配置非法 → 400 `provider_not_configured`，
  **不静默回退全局默认**（避免「我明明选了 A 却跑到 B 上执行」）
- 本次执行显式指定的实例不可用 → 同样 400 `provider_not_configured`（`getEnabledProviderById` 校验）
- 仅当工作流**未指定**时才使用全局默认；默认实例不可用同样报 `provider_not_configured`

### 3.4 宽松解析（只读预览）

`ProviderService.resolveWorkflowProvider(workflowId)`：工作流指定的实例不可用时**回退全局默认**。
仅用于工作流详情等只读预览场景，**执行路径不得使用**。

## 4. 分组（自动分配）

分组自身不执行任务，提交到分组的任务先进入【待调度】队列，由统一调度器挑选成员后投递。
完整规则（队列划分、候选挑选、健康冷却、无在线实例行为、人工改派与插队）见
**[任务调度与队列](task-scheduling.md)**。

此处仅记录与提供商模型直接相关的两条边界：

- 分组**无成员 / 成员全部停用**：提交时直接返回 400 `provider_no_available_instance`
  （成员资格 = 被某个分组选为成员，没有独立的「可被自动分配」开关）
- 分组内**没有任何在线成员**：按 `noOnlineInstanceBehavior` 决定
  （`queue` 留在队列等待 / `error` 任务立即置 `failed`，失败原因含 `provider_no_online_instance`）；
  注意「满载 ≠ 无在线实例」——并发额度已满但在线的成员仍算在线，任何取值下都继续排队

## 5. 资产自动清理

ComfyUI **没有删除文件的 API**，因此清理只能在本机文件系统上完成（仅同机部署有效）。

### 5.1 配置项

| 配置 | 默认 | 语义 |
|---|---|---|
| `config.autoCleanup` | `false` | 是否允许在任务终态删除本次上传的资产；`false` 时**任何路径都不删除** |
| `config.inputDir` | 空 | ComfyUI 输入目录的**本机**文件系统路径，**仅用于删除**，不用于解析工作流中的文件路径 |

- `autoCleanup=true` 且 `inputDir` 非空：任务到达终态（成功 / 失败）后，按任务记录的
  `uploaded_files` 删除本次上传的文件
- `autoCleanup=false`（默认）：**任何路径都不删除**（含提交失败路径），文件留存需人工清理；
  此时填写 `inputDir` 不会导致任何删除
- `inputDir` 为空：跳过清理并记日志
- 只删除本项目追踪到的上传文件，不影响输入目录中的其他文件
- 清理使用任务所属实例的配置：执行服务在实例增删改 / 默认切换时**整体重建跟踪器**
  （`ProviderService.onChange` → `startAll`），因此执行期间修改开关对在途任务同样生效，
  最终以任务到达终态时跟踪器持有的配置为准

### 5.2 判断入口

`services/cleanup.service.ts` 的 `cleanupTaskUploads(provider, uploadedFilesJson, reason)`：

| `reason` | 场景 | 开关 |
|---|---|---|
| `'terminal'`（缺省） | 任务终态（成功 / 失败）后的常规清理 | **必须遵循** `getAutoCleanup() === true`，否则直接跳过 |
| `'preview'` | `POST /api/workflows/:id/build/simulate` 预览上传的文件 | **忽略开关**，在返回前立即清理（预览文件从无 prompt 提交、必然无人引用） |

- 提供商未实现 `cleanupUploadedFiles`（RunningHub / group）时直接跳过
- 清理为 fire-and-forget，失败仅记日志，不影响任务结果
- 执行路径调用点在 `services/execution.service.ts`（终态、中断、输出回填等），预览路径在
  `controllers/workflow.controller.ts`
- `ComfyUIProvider.cleanupUploadedFiles` 内部**再判一次开关**作为双保险，并做路径安全校验
  （拒绝绝对路径与 `..` 越界名）

## 6. API Key 回显与编辑原则

RunningHub 的 `apiKey` 属于敏感凭据：

- **永不回显明文**：列表 / 摘要一律打码（`getDisplayBaseUrl()` 负责脱敏），编辑弹窗留空不预填
- **保存时留空 = 不修改原 Key**：前端留空则**省略 `config` 回传**；后端**仅在显式提供 `config` 时**才覆盖
- 仅输入新值时才更新 Key；`getConfig()` 返回的明文配置仅服务端可见，不得回传客户端

## 7. 代码位置索引

| 模块 | 职责 |
|---|---|
| `services/providers/types.ts` | `ExecutionProvider` 抽象接口、`ProviderConfig` 判别联合、`connectivityProbeConfig` |
| `services/providers/shared.ts` | 各类型共用的 HTTP 请求封装 |
| `services/providers/comfyui.provider.ts` | ComfyUI 原生实现（`/prompt`、`/upload/image`、`/history`、`/interrupt`、`/view`、上传资产清理） |
| `services/providers/runninghub.provider.ts` | RunningHub 实现（proxy 提交、平台结果查询 V2、平台产出地址） |
| `services/providers/group.provider.ts` | `GroupProvider`：分组配置与成员列表，执行类方法显式报错 |
| `services/providers/provider.service.ts` | 实例 CRUD、配置校验、实例解析（严格 / 宽松）、摘要与空闲槽位 |
| `services/providers/health.service.ts` | 健康状态表、30s 巡检、冷却与恢复判定 |
| `services/cleanup.service.ts` | `cleanupTaskUploads` / `parseUploadedFiles`：上传资产的终态与预览清理 |
| `services/dispatcher.service.ts` | 统一调度器（分组队列、成员挑选、提交与媒体上传） |
| `services/execution.service.ts` | 启动健康巡检与调度器；按实例维护任务状态跟踪器 |

## 8. API 端点

提供商管理端点（`/api/providers`）的完整请求 / 响应示例见
[工作流 API 文档 §2 提供商管理](../workflow-api.md#2-提供商管理)：

| 端点 | 说明 |
|---|---|
| `GET /api/providers` | 列出全部实例（脱敏摘要） |
| `POST /api/providers` | 新建实例 |
| `PUT /api/providers/:id` | 部分更新（`config` 缺省沿用原配置，见 §6） |
| `DELETE /api/providers/:id` | 删除（全局默认实例返回 409） |
| `POST /api/providers/test` | 用未保存的配置测试连通性 |
| `POST /api/providers/:id/test` | 测试已保存实例 |
| `GET /api/providers/:id/health` | 实例健康快照（分组返回成员明细与空闲槽位） |

## 9. 测试覆盖

| 测试文件 | 覆盖点 |
|---|---|
| `services/providers/provider.service.test.ts` | CRUD、配置校验、默认实例、严格 / 宽松解析差异、删除默认实例被拒 |
| `services/providers/provider-group.test.ts` | 分组配置校验（策略白名单、无在线实例行为缺省与非法值、权重规范化、成员去重）、成员解析过滤 |
| `services/providers/comfyui.provider.test.ts` | 提交、上传、失败语义、`cleanupUploadedFiles` 开关与路径安全 |
| `services/cleanup.service.test.ts` | 终态清理遵循开关、预览清理忽略开关、无能力提供商跳过、异常吞并 |
| `routes/providers.routes.test.ts` | 端点鉴权、脱敏回显、Key 留空不覆盖、默认实例设置 |
