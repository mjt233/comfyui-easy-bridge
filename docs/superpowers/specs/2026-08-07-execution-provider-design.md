# 多执行提供商（ComfyUI 原生 / RunningHub）可配置架构设计

## 背景

当前系统只支持把工作流提交到**单个原生 ComfyUI** 执行：

- 执行地址写死在全局设置 `comfyui_base_url`，所有工作流共用
- 媒体上传固定走 ComfyUI 的 `POST /upload/image`
- 任务跟踪依赖 ComfyUI WebSocket（`execution_success` / `execution_error` / `progress`）+ `/history` 后备轮询
- 并发控制为全局 `comfyui_concurrency`
- 节点速查（`object_info`）也固定从 `comfyui_base_url` 拉取

需求：除原生 ComfyUI 外，还需支持 **RunningHub 的原生 ComfyUI 接口**（`https://www.runninghub.cn/proxy/<api-key>`，48G 为 `/proxy-plus/<api-key>`）作为执行后端；并且**同一个类型的提供商可配置多个实例**（如多台 ComfyUI、多个 RunningHub 账号），系统设置一个**全局默认提供商实例**，每个工作流可覆盖。设计需可拓展、可配置。

## RunningHub 原生接口差异（依据官方文档）

| 能力 | 原生 ComfyUI | RunningHub 原生接口 |
|------|--------------|---------------------|
| 基础地址 | `comfyui_base_url` | `https://www.runninghub.cn/proxy/<api-key>`（24G）/ `/proxy-plus/<api-key>`（48G） |
| 提交执行 | `POST /prompt` | 相同（地址功能等同本地 ComfyUI） |
| 媒体上传 | `POST /upload/image` | `POST /openapi/v2/media/upload/binary`，请求头 `Authorization: Bearer <api-key>`，multipart 字段 `file`；返回 `data.fileName`（相对路径，如 `openapi/xxx.png`）供加载节点使用 |
| 任务跟踪 | WebSocket + 轮询 | 预计不支持 WebSocket，**纯轮询** `/history` / `/queue` |
| 中断 | `POST /interrupt` | 相同（假定支持，实现时验证） |
| 输出下载 | `GET /view?filename=...` | 相同（假定通过 proxy 可访问，实现时验证） |
| 节点速查 | `GET /object_info` | **不使用**（设计约束：node-info 只从原生 ComfyUI 类型提供商获取） |

> RunningHub 上传接口返回的 `fileName` 是服务器相对路径，不是本地文件名；需要注入对应加载节点（`LoadImage` / `LoadAudio` / `LoadVideo` 等）的字段值。ZIP 批量图片（`LoadImages(zip)`）返回的是 hash 值，属于特例，本期不纳入 `image/video/audio` 媒体参数体系，留作未来扩展。

## 关键决策（已与用户确认）

| 决策点 | 结论 |
|--------|------|
| 实现方案 | **方案 A：Provider 抽象层 + 共享任务跟踪器** |
| 配置范围 | **全局默认实例 + 每个工作流可覆盖**（工作流 `provider_id` 为空则用全局默认） |
| 实例数量 | **同一类型可配置多个提供商实例**（新增 `providers` 表） |
| API Key 存放 | **全局唯一**：RunningHub 实例的 apiKey 存在各自实例的 config 中；不做按工作流单独配置 |
| 并发控制 | **按提供商实例控制**：每个实例有自己的 `concurrency`（默认 1），各实例独立排队与调度 |
| node-info | **只从原生 ComfyUI 类型提供商获取**；RunningHub 实例不参与 `object_info` 拉取 |
| 全局默认 | 系统必须存在且指向有效实例；删除默认实例被禁止 |

## 数据模型

### 新增 `providers` 表（提供商实例）

```ts
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),               // uuid
  name: text('name').notNull(),              // 展示名，如 "本地 ComfyUI"、"RunningHub 24G"
  type: text('type').notNull(),              // 'comfyui' | 'runninghub'
  config: text('config').notNull(),          // JSON，按 type 区分（见 ProviderConfig）
  concurrency: integer('concurrency').notNull().default(1), // 该实例的并发上限
  enabled: integer('enabled').notNull().default(1),         // 是否启用
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

**config 判别联合**（不使用 `any`）：

```ts
export type ProviderType = 'comfyui' | 'runninghub';

export type ProviderConfig =
  | { baseUrl: string }                          // comfyui
  | { apiKey: string; gpuSize: '24G' | '48G' };  // runninghub
```

RunningHub 实例的基础地址由 `apiKey + gpuSize` 推导：
`https://www.runninghub.cn/proxy/<apiKey>`（24G）或 `https://www.runninghub.cn/proxy-plus/<apiKey>`（48G）。

### 字段变更

- `workflows` 新增 `provider_id`（text，可空，外键指向 providers，`SET NULL` 语义由应用层处理；空 = 用全局默认实例）
- `task_logs` 新增 `provider_id`（text，可空；记录任务实际使用的实例，供任务跟踪与输出回源使用；历史任务为 null）
- settings 新增 `default_provider_id`（值 = 某 providers.id）
- 旧设置 `comfyui_base_url` / `comfyui_concurrency` 不再参与执行逻辑（仅迁移期读取）

## Provider 抽象层

新增目录 `packages/server/src/services/providers/`：

```
providers/
  types.ts               — ProviderType / ProviderConfig / ExecutionProvider 接口 / 摘要类型
  provider.service.ts    — ProviderService：实例 CRUD + 解析（工作流 / 默认 / node-info 提供商）+ 变更事件
  comfyui.provider.ts    — ComfyUIProvider
  runninghub.provider.ts — RunningHubProvider
```

### ExecutionProvider 接口（核心可拓展点）

```ts
export interface ExecutionProvider {
  readonly id: string;
  readonly name: string;
  readonly type: ProviderType;
  /** 任务跟踪模式：comfyui=websocket；runninghub=polling */
  readonly trackingMode: 'websocket' | 'polling';
  /** 解析后的 HTTP 基础地址（RunningHub 为 proxy 地址） */
  getBaseUrl(): string;
  /** 提交 prompt，返回 prompt_id；不抛网络/HTTP 异常，错误经 ExecutionResult 返回 */
  submitPrompt(body: string): Promise<ExecutionResult>;
  /** 上传媒体文件，返回注入工作流节点的文件名（RunningHub 为返回的 fileName） */
  uploadMedia(
    file: { buffer: Buffer; originalname: string; mimetype: string },
    mediaType: 'image' | 'video' | 'audio',
  ): Promise<string>;
  /** 拉取指定 prompt 的 history */
  fetchHistory(promptId: string): Promise<unknown>;
  /** 中断任务，可带 promptId 轮询确认停止 */
  interrupt(promptId?: string): Promise<boolean>;
  /** 查询 prompt 是否仍在执行队列 */
  isPromptRunning(promptId: string): Promise<boolean>;
  /** 构造输出文件下载地址（/view?filename=...&subfolder=...&type=...） */
  buildOutputViewUrl(outputFile: { filename: string; subfolder: string; type: string }): string;
}
```

实现说明：

- 公共 HTTP 行为（`submitPrompt` 注入 `client_id`、`fetchHistory`、`interrupt` + `/queue` 轮询确认、`isPromptRunning`）放共享基类/工具，从 `executor.service.ts` 迁入
- `ComfyUIProvider`：`uploadMedia` 走 `POST {base}/upload/image`（沿用现有 `uploadFileToComfyUI` 逻辑）
- `RunningHubProvider`：`uploadMedia` 走 `POST https://www.runninghub.cn/openapi/v2/media/upload/binary`，请求头 `Authorization: Bearer <apiKey>`，multipart 字段 `file`（用唯一文件名），解析 `data.fileName` 返回
- `provider.service.ts` 的 `getProvider(id)` / `getDefaultProvider()` / `resolveWorkflowProvider(workflowId)` 返回实例化后的 `ExecutionProvider`

### executor.service.ts 的收敛

- `submitPrompt` / `interruptPrompt` / `isPromptRunning` / `processMediaParams` 改为接收 `ExecutionProvider` 而非 `comfyuiBaseUrl` 字符串
- `applyAliases` / `coerceParamValue` / `resolveSubmittedAliasValues` / `toRuntimeParams` 等纯函数保持不变
- `upload.service.ts` 的 `buildUniqueUploadFilename` 保留；`uploadFileToComfyUI` 收敛进 `ComfyUIProvider.uploadMedia`

## 任务跟踪（改造 comfyui.service.ts）

`comfyui.service.ts` 改名为通用执行服务 `execution.service.ts`（`startExecutionService(db)`），**为每个启用的提供商实例启动一个独立跟踪器**：

- **队列调度**：`drainQueue(providerId)` 按实例过滤 queued 任务（`taskService.listQueued(providerId)`），并发判断按实例（`countByStatus('pending', providerId)` 与实例 `concurrency` 比较）
- **WebSocket**：仅 `trackingMode === 'websocket'` 的实例建立连接（现有逻辑复用，`client_id` 与 `/prompt` 注入一致）
- **轮询**：`polling` 实例纯轮询 `/history` / `/queue`；现有 `startFallback`（10s）与 `startCompletionPoll`（progress=100 补查，1s）按实例运行
- **变更重建**：`ProviderService` 提供变更事件（实例增删改、默认切换、启用/禁用）；`index.ts` 订阅后 `stop()` 旧服务并重新 `startExecutionService(db)`。重启后 queued 任务按各自 `provider_id` 重新入队调度

`TaskService` 增加按实例查询：`listQueued(providerId?)`、`countByStatus(status, providerId?)`、`listPending(providerId?)`（不传则全部，兼容现有调用与测试）。

## node-info 规则（仅原生 ComfyUI）

`getNodeInfoCached(db)` 的提供商解析顺序：

1. **全局默认实例**（`default_provider_id`）若为 `comfyui` 类型 → 用它
2. 否则取**第一个启用的 `comfyui` 类型实例**
3. 都没有 → 返回 null（前端提示"未配置可用的 ComfyUI 提供商"）

RunningHub 类型实例永不参与 `object_info` 拉取。现有缓存以 baseUrl 为 key，天然支持多实例；调用方 `getBuildApiTypes` / `getNodeReference` / `simulateBuild` 无需感知具体实例。

## API 与前端

### 新增提供商管理接口（`/api/providers`，需认证）

```
GET    /api/providers             # 列表；返回摘要（id/name/type/config 脱敏/config 中 apiKey 打码/concurrency/enabled/resolvedBaseUrl）
POST   /api/providers             # 新建；按 type 校验 config 字段
PUT    /api/providers/:id         # 更新；运行中变更触发跟踪器重建
DELETE /api/providers/:id         # 删除；默认实例禁止删除（409）；被工作流引用的实例：工作流 provider_id 置空（回退默认）
POST   /api/providers/:id/test    # 连通性测试；见下方「测试连接行为」
```

**测试连接行为**：

- comfyui 实例：`GET {baseUrl}/system_stats`，2xx 视为连通
- runninghub 实例：先 `GET {derivedProxyBase}/system_stats`；若 404/405（proxy 未暴露该端点），退化为调用上传接口 `POST /openapi/v2/media/upload/binary` 验证 API Key 是否有效（上传一个最小占位文件，成功即连通）。具体以实现期实测为准，测试结果返回 `{ ok, message }`


校验规则：

- `name` 必填非空；`type` 白名单（`comfyui` / `runninghub`）
- comfyui：`config.baseUrl` 必填，须为 http(s) URL
- runninghub：`config.apiKey` 必填非空；`config.gpuSize` 白名单（`24G` / `48G`，默认 `24G`）
- `concurrency` 正整数，默认 1

### 工作流变更

- `POST /api/workflows` / `PUT /api/workflows/:id` 支持 `providerId`（可空 = 用全局默认）
- 详情响应新增 `providerId` 与解析后的提供商摘要（`resolvedProvider: { id, name, type, resolvedBaseUrl } | null`）
- 执行接口 `POST /api/workflows/:id/execute`：按 `workflow.providerId ?? default_provider_id` 解析实例；无可用实例时返回 400 `provider_not_configured`

### 前端

- `SettingsPage.vue`：新增"执行提供商"管理区
  - 实例列表（名称 / 类型 / 地址或 GPU 档位 / 并发 / 启用开关 / 测试连接 / 编辑 / 删除）
  - 新建 / 编辑对话框按类型显示不同字段
  - **全局默认实例**下拉选择
  - 移除旧的 "ComfyUI 服务地址" 与全局 "ComfyUI 任务执行并发数" 字段
  - 若当前无任何提供商实例，提示引导创建
- `WorkflowEditPage.vue`：提供商选择器（"使用全局默认" 或指定实例）
- 新增 `client/src/api/providers.ts` 与类型定义（`ProviderInstance` / `ProviderSummary` / `ProviderType`）

## 输出下载与错误处理

- `task.controller.ts` 的输出回源与 `/view` 代理下载改为基于 `task.providerId` 解析提供商地址（历史任务 `provider_id` 为 null 时回退全局默认）
- `output_download_mode`（proxy / direct）语义不变
- 新增错误码 `provider_not_configured`：未配置默认提供商 / 工作流指定的实例不存在或已禁用 / 执行所需实例不可用

## 数据库迁移（版本化）

新增迁移 `vN-execution-providers.ts`（注册到 `migrations/index.ts` 表尾）：

1. 建 `providers` 表
2. `workflows` 加 `provider_id` 列（可空）
3. `task_logs` 加 `provider_id` 列（可空）
4. **数据迁移**：
   - 若旧设置 `comfyui_base_url` 非空 → 创建 "ComfyUI 原生" 实例（config 含该 baseUrl）并写入 `default_provider_id`
   - 否则 → 创建一个 config.baseUrl 为空的 ComfyUI 默认实例并设为默认（保证系统始终存在默认提供商指针；该占位实例需在设置页填入地址后才能执行，未配置时执行返回 `provider_not_configured`）
   - 历史 `task_logs.provider_id` 回填为迁移创建的默认实例 id
   - 注：迁移直接写库绕过 API 校验，因此允许空 baseUrl 的占位实例存在

## 测试策略

- `providers/` 各模块单测：config 解析、RunningHub 地址推导、上传请求构造（mock fetch）、接口校验
- `execution.service` 改造后回归：多实例队列调度按实例隔离、polling 模式不建立 WebSocket、progress 补查按实例
- `workflow.controller`：execute 按 `provider_id` 解析实例、`provider_not_configured` 分支、simulateBuild 媒体上传走正确 provider
- `task.controller`：输出回源 / 下载按 `task.provider_id` 解析
- `node-info.service`：默认实例非 comfyui 时回退第一个 comfyui 实例；无 comfyui 实例返回 null
- 迁移测试：从旧库（含 `comfyui_base_url`）升级后 providers 表 / default_provider_id / 历史任务回填正确

## 不在本期范围

- RunningHub ZIP 批量图片（`LoadImages(zip)`）特殊返回值
- RunningHub 标准模型 API（非 ComfyUI 原生接口）的完整对接
- 提供商实例级健康监控 / 自动故障转移
