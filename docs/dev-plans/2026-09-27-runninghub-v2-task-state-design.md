# RunningHub 任务状态与产出改用「查询任务生成结果 V2」（已实施）

- 状态：**已实施**
- 目标接口：[查询任务生成结果 V2](https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306) — `POST https://www.runninghub.cn/openapi/v2/query`
- 触发原因：RunningHub 实例原先经 proxy 原生 ComfyUI 接口的 `GET /history/{prompt_id}` 判定终态并解析 `outputs`，再按 `{baseUrl}/view?filename=...` 拼下载地址。改为使用平台官方结果接口后，状态与产出都来自权威数据源，下载地址由平台直接给出，不再依赖 proxy 的 history 语义。

---

## 1. 接口契约

```
POST https://www.runninghub.cn/openapi/v2/query
Authorization: Bearer <apiKey>
Content-Type: application/json

{ "taskId": "<prompt_id>" }
```

`taskId` **就是** proxy `POST /proxy/{apiKey}/prompt` 返回的 `prompt_id`，两者是同一个值，因此无需改动提交链路或新增字段。

响应（HTTP 200，扁平结构；实测还包含文档未列出的 `failedReason` / `usage` / `parentTaskId` / `taskUsageList`）：

```json
{
  "taskId": "2009191190196789249",
  "status": "SUCCESS",
  "errorCode": "",
  "errorMessage": "",
  "results": [{ "url": "https://rh-images-….cos.ap-beijing.myqcloud.com/….jpg", "outputType": "jpg" }],
  "clientId": "",
  "promptTips": "",
  "failedReason": {}
}
```

## 2. 状态映射

| 平台 `status` | 归一化结果 | 说明 |
|---|---|---|
| `SUCCESS` + `results` 非空 | `completed` | 产出文件带平台绝对地址 |
| `SUCCESS` + `results` 空 / `null` | `failed` | 「平台判定成功却无产出」属异常，直接暴露而非静默完成 |
| `FAILED` / `CANCEL` / `CANCELLED` | `failed` | 原因优先取 `failedReason.exception_message`，其次 `errorMessage`，并拼接 `errorCode` |
| `CREATE` / `QUEUED` / `RUNNING` / `PENDING` | `running` | 本轮不终态化，下一轮继续探测 |
| 其它未识别状态 + `errorCode` 非空 | `failed` | 覆盖 API Key 失效等平台侧报错（实测 `status: ""`、`errorCode: "806"`） |
| 其它未识别状态 + `errorCode` 为空 | `running` | 保守处理，避免误判终态 |
| HTTP 非 2xx / 网络异常 / 响应缺 `status` | 抛错 | 由跟踪器「连续失败计数」兜底，连续 5 次后置 `failed` |

**任一失败路径都不回退到 proxy `/history`**：RunningHub 任务的终态与产出只认平台接口，因此不会出现「状态已完成但本地无输出」的静默状态。

## 3. 架构改动

### 3.1 提供商抽象新增单一可选能力

`packages/server/src/services/providers/types.ts`：

```ts
export interface ProviderOutputFile {
  filename: string;
  fileType: 'image' | 'video' | 'audio';
  url: string;                    // 平台给出的绝对下载地址
}

export type ProviderTaskState =
  | { kind: 'running' }
  | { kind: 'completed'; files: ProviderOutputFile[]; raw: unknown }
  | { kind: 'failed'; errorMessage: string; raw: unknown };
```

`ExecutionProvider` 新增可选方法 `queryTaskState?(taskId): Promise<ProviderTaskState>`。未实现该方法的提供商（`comfyui`）行为完全不变。

选择「状态 + 产出一体化」而不是拆分两个方法，是为了与轮询循环一一对应：一个 pending 任务每轮只打一次 RunningHub 接口。`raw` 字段让原始响应体能落进 `comfyui_response`，便于在任务详情「响应」页排查。

### 3.2 跟踪器统一探测

`packages/server/src/services/execution.service.ts`：

```
probeTask(promptId): TaskProbeOutcome
  ├─ provider.queryTaskState 存在 → 平台接口，ProviderOutputFile[] → OutputFile[]
  └─ 否则                        → fetchHistory + resolveHistoryOutcome + parseHistoryOutputs

applyProbeOutcome(taskId, outcome): boolean   // 取代原 applyHistoryOutcome
  ├─ running   → false，下一轮继续
  ├─ completed → completed + comfyui_response = raw + 落库 outputFiles
  └─ failed    → failed + errorMessage + comfyui_response = raw
  终态统一：清失败计数 → cleanupTaskUploads → releaseStaged → afterSlotReleased
```

- `startFallback`（10s 兜底轮询）与 `startCompletionPoll` 改用 `probeTask` + `applyProbeOutcome`
- WebSocket 路径（`completeTask` / `failTask` / `backfillCompletedOutputs`）仅由原生 ComfyUI 触发（RunningHub 的 `trackingMode` 为 `polling`），但也统一复用 `probeTask`，保证数据源只有一处口径
- `historyErrorCounts` → `statusErrorCounts`，文案 `History check failed:` → `Task status check failed:`（该文案不再只针对 history）
- 并发统计、队列调度、分组调度、健康巡检均不受影响

`guessFileType` 从 `execution.service.ts` 上提到 `providers/shared.ts` 导出，供 history 解析与 RunningHub `outputType` 推断共用。

### 3.3 输出文件模型

`task.service.ts` 的 `OutputFile` 新增可选 `url?: string`。`output_files` 是 JSON 列，**无数据库迁移**。

### 3.4 下载与列表路由

`controllers/task.controller.ts`：

- `listOutputFiles`：`proxy` 模式恒返回后端代理路径；`direct` 模式优先用文件自身的平台绝对地址，无则回退 `/view` 拼装
- `downloadOutputFile`：先按 `filename` 在任务 `output_files` 中查平台地址，命中则直接回源转发（RH COS 预签名地址，不带鉴权头）；否则维持 `/view` 路径。**没有 provider 但文件带平台地址时同样可下载**
- 回源兜底 `fetchOutputsFromProvider` 同样优先 `queryTaskState`；改造后该路径实际只对「改造前已完成」的历史任务可达

前端无改动：`OutputFile.url` 由服务端统一填充，`api/tasks.ts` 与 `TaskListPage.vue` 契约不变。

## 4. 进度（明确不做）

RunningHub 结果查询 V2 **不含任何进度字段**。实测确认（无效 Key 探测，零额度消耗）：

| 探测 | 结果 |
|---|---|
| `POST /openapi/v2/query` | `{..., "failedReason":{},"usage":null,"parentTaskId":null,"taskUsageList":null}` —— 无进度 |
| `POST /task/openapi/outputs`（V1，已 deprecated） | 仍在线（`code: 806`），运行中时 `data.netWssUrl` 是**唯一**已知进度入口 |
| `wss://…/proxy/{key}/ws?clientId=x` | 握手成功，但无效 Key 亦然，**无法据此判定能否收到本任务事件** |

即：进度的可行路径只有「V1 `/task/openapi/outputs` 取 `netWssUrl` 后接 WebSocket」或「proxy 的 ComfyUI WebSocket」，两者对 **proxy 创建的任务**是否有效均未经验证，且都要求 WS 仅用于展示、终态仍以 HTTP 为准。

**决定：本次不做进度**，RunningHub 任务的 `progress` 保持 `null`。将来若要接入，接缝已留好（`provider.trackingMode` 驱动的 WS 分支与 `progress` 落库路径均未改动，无需重构）。

## 5. 测试

| 文件 | 覆盖 |
|---|---|
| `providers/runninghub.provider.test.ts` | 请求 URL / Bearer / body；`SUCCESS` 产出解析（含 `outputUrl` 别名、`outputType` 扩展名与关键字两种形态）；`SUCCESS` 空产出 → `failed`；`FAILED`（含 `failedReason` 优先与 `errorCode` 拼接）/ `CANCEL`；非终态 → `running`；未识别状态按 `errorCode` 分流；非 2xx 与缺 `status` 抛错 |
| `services/execution.service.test.ts` | RunningHub：`SUCCESS` 落库带 `url` 的产出、`FAILED` 带平台原因、`SUCCESS` 无产出置失败、非终态保持 pending、连续报错后置失败**且不产生任何 `/history` 请求**；ComfyUI：仍走 proxy history（产出不带 `url`） |
| `routes/task.routes.test.ts` | 带平台地址的文件在 `proxy` 模式返回后端路径、`direct` 模式返回绝对地址；下载回源平台地址（断言 fetch 的 URL）；无 provider 时仍可下载；回源兜底打到 `/openapi/v2/query` 并携带该实例的 API Key |

验证命令（全部通过）：

```bash
pnpm --filter server exec tsc --noEmit
pnpm --filter client exec vue-tsc --noEmit
pnpm test
```

> 注：`pnpm --filter client exec tsc --noEmit` 会因 `.vue` 模块解析失败而报错，属既有问题（项目自身的 `build:client` 用的是 `vue-tsc`）。本次未改动任何前端文件。

## 6. 边界与后续

1. **中断 / 取消**仍走 proxy `POST /interrupt` + `/queue` 轮询确认，未接 RunningHub 的取消任务接口。
2. **`comfyui_response` 语义**：RunningHub 任务完成后该字段记录的是 V2 查询响应体（含 `errorCode` / `errorMessage` / `promptTips`），不再是 history 响应体。
3. **同名产出**：下载路由按 `filename` 匹配持久化记录，平台产出的文件名取自 URL 末段（通常为 UUID），重名概率可忽略；若将来需要严格唯一，可改为按索引定位。
