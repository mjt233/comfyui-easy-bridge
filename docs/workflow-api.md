# 工作流相关 API 文档

本文档覆盖五个核心 API：提供商管理、提交工作流执行、查看任务状态、中断任务、下载输出文件。

**基础路径**: `/api`

---

## 1. 提交工作流执行

```
POST /api/workflows/:id/execute
```

公开端点，无需认证。支持 JSON 和 multipart/form-data 两种请求格式。

### 请求格式

**方式 A：纯 JSON（无文件上传）**

```
Content-Type: application/json
```

```json
{
  "prompt": "a cute cat",
  "steps": 20
}
```

每个 key 为工作流参数中定义的 **alias**，value 为要注入工作流 JSON 的值。

**方式 B：multipart/form-data（含文件上传）**

当参数类型为 `image` / `video` / `audio` 时使用。

| 字段 | 说明 |
|------|------|
| `params` | JSON 字符串，包含所有文本参数值，如 `{"steps": 20, "prompt": "cat"}` |
| `<alias>` | 每个文件类型参数对应一个字段，字段名为 alias，值为上传的文件 |

示例：

```
params: {"prompt": "a cute cat"}
input_image: <file>
```

### 响应

**直接执行（未达并发限制）** `200`:

```json
{
  "task_id": "uuid-string",
  "status": "pending",
  "comfyui_response": {
    "prompt_id": "comfyui-prompt-id"
  }
}
```

**排队（超过并发限制）** `200`:

```json
{
  "task_id": "uuid-string",
  "status": "queued",
  "comfyui_response": null
}
```

**错误响应**:

| 状态码 | code | 说明 |
|--------|------|------|
| `400` | `missing_parameter` | 必填参数缺失 |
| `400` | `provider_not_configured` | 未配置默认执行提供商 / 工作流指定的提供商不存在或已禁用 |
| `404` | `workflow_not_found` | 工作流不存在 |
| `502` | `comfyui_unreachable` | 执行提供商服务不可达 |

> 说明：工作流执行通过「执行提供商」实例进行（见第 2 节「提供商管理」），执行端可能是 ComfyUI 原生或 RunningHub。`comfyui_response` 为执行端的原始响应体、`prompt_id` 语义不变，执行端地址不再来自全局 `comfyui_base_url` 设置。

---

## 2. 提供商管理

执行提供商（Provider）实例负责工作流的实际执行，类型分为：

| 类型 | 配置 | 说明 |
|------|------|------|
| `comfyui` | `config.baseUrl` | ComfyUI 原生服务地址 |
| `runninghub` | `config.apiKey` + `config.gpuSize` (`'24G'` / `'48G'`) | RunningHub 云端执行；基础地址由 `https://www.runninghub.cn/proxy/<apiKey>`（24G）或 `/proxy-plus/<apiKey>`（48G）推导 |

以下端点均需认证 (`Authorization: Bearer <token>`)。

### 列出提供商实例

```
GET /api/providers
```

返回所有实例的脱敏摘要（runninghub 的 `apiKey` 已打码）：

```json
[
  {
    "id": "uuid-string",
    "name": "本地 ComfyUI",
    "type": "comfyui",
    "config": { "baseUrl": "http://localhost:8188" },
    "concurrency": 1,
    "enabled": true,
    "resolvedBaseUrl": "http://localhost:8188",
    "trackingMode": "websocket"
  }
]
```

### 新建提供商实例

```
POST /api/providers
```

**请求体**:

```json
{
  "name": "本地 ComfyUI",
  "type": "comfyui",
  "config": { "baseUrl": "http://localhost:8188" },
  "concurrency": 1,
  "enabled": true
}
```

RunningHub 示例：

```json
{
  "name": "RunningHub 24G",
  "type": "runninghub",
  "config": { "apiKey": "sk-xxxx", "gpuSize": "24G" }
}
```

**响应** `201`: 与列表项相同的实例摘要；校验失败返回 `400`。

### 更新提供商实例

```
PUT /api/providers/:id
```

支持部分更新：仅提交需要修改的字段，`config` 缺省时沿用原配置、未显式提供 `type` 时沿用原类型。校验失败返回 `400`，实例不存在返回 `404`。

> **API Key 编辑约定**：runninghub 的 `apiKey` 永不明文回显（列表/详情均为打码值），编辑时省略 `config`（或省略 `apiKey`）表示沿用原 Key；仅在需要更换 Key 时才提交新的 `config.apiKey`。

### 删除提供商实例

```
DELETE /api/providers/:id
```

删除成功返回 `204`。全局默认实例禁止删除（返回 `409`，code `default_provider_not_deletable`）；被删除实例引用的工作流自动回退到全局默认（`providerId` 置空）。

### 测试连接

用未保存的配置测试连通性（测试失败不阻止保存）：

```
POST /api/providers/test
```

**请求体**: `{ "type": "comfyui", "config": { "baseUrl": "..." } }` 或 `{ "type": "runninghub", "config": { "apiKey": "...", "gpuSize": "24G" } }`；`type` 缺省按 `comfyui` 处理。

测试已保存的实例：

```
POST /api/providers/:id/test
```

两者的测试行为一致：请求 `GET {base}/system_stats`，`2xx` 视为连通，返回 `{ "ok": true, "message": "连接成功" }` 或 `{ "ok": false, "message": "<原因>" }`。

### 默认实例与工作流覆盖

- 全局默认实例通过设置 `default_provider_id` 指定（`PUT /api/settings`，body 为 `{ "key": "default_provider_id", "value": "<实例 ID>" }`）；默认实例被禁用时视为未配置。
- 工作流的 `providerId` 字段（可空：`null` 或空字符串 = 使用全局默认）可覆盖默认实例，创建工作流（`POST /api/workflows`）与更新工作流（`PUT /api/workflows/:id`）时均可传入。
- 执行时优先使用工作流指定的**启用中**的实例，否则回退全局默认；均不可用时 `POST /api/workflows/:id/execute` 返回 `400 provider_not_configured`。

---

## 3. 标签管理

标签为父/子两级结构（仅支持一级子标签），预设标签只读；打子标签必须同时打其父标签。工作流可打多个标签，每个标签可定义元数据字段（number / string / boolean，含默认值）。

### 列出标签树

```
GET /api/tags
```

返回顶层标签数组，每项含 `children` 子标签数组：

```json
[
  {
    "id": "image-to-video",
    "name": "图生视频",
    "parentId": null,
    "isPreset": 1,
    "metadataDef": [],
    "children": [
      {
        "id": "reference",
        "name": "全能参考",
        "parentId": "image-to-video",
        "isPreset": 1,
        "metadataDef": [
          { "key": "maxImageCount", "label": "图片数量", "type": "number", "defaultValue": 9 },
          { "key": "maxAudioCount", "label": "音频数量", "type": "number", "defaultValue": 3 },
          { "key": "maxVideoCount", "label": "视频数量", "type": "number", "defaultValue": 3 },
          { "key": "maxTotalCount", "label": "参考总数量", "type": "number", "defaultValue": 12 }
        ]
      }
    ]
  }
]
```

### 新建自定义标签

```
POST /api/tags
```

body：`{ "name": "自定义标签", "parentId": null, "metadataDef": [] }`（`parentId` 可选，须指向顶层标签；`metadataDef` 可选，元素为 `{ key, label, type, defaultValue }`，`type` 白名单 `number | string | boolean`）。同层级重名返回 `409 tag_conflict`。

### 更新标签

```
PUT /api/tags/:id
```

可更新 `name` / `metadataDef`（`parentId` 不可改）。预设标签返回 `403 tag_preset_readonly`。

### 删除标签

```
DELETE /api/tags/:id
```

预设标签返回 `403 tag_preset_readonly`；存在子标签返回 `409 tag_has_children`；被工作流引用返回 `409 tag_in_use`。

### 设置工作流标签（整组替换）

```
PUT /api/workflows/:id/tags
```

body：`{ "tags": [{ "tagId": "image-to-video" }, { "tagId": "reference", "metadataValues": { "maxImageCount": 12 } }] }`。

- 子标签必须同时包含其父标签（否则 `400 parent_tag_required`）
- `metadataValues` 的键必须属于该标签 `metadataDef` 且值类型匹配（否则 `400 invalid_metadata`）
- 返回替换后的标签分组数组

### 工作流标签结构（列表/详情响应）

`GET /api/workflows` 与 `GET /api/workflows/:id` 响应的每个工作流包含 `tags` 嵌套分组结构：

```json
"tags": [
  {
    "id": "image-to-video",
    "name": "图生视频",
    "tags": [
      {
        "id": "reference",
        "name": "全能参考",
        "metadata": { "maxImageCount": 12, "maxAudioCount": 3, "maxVideoCount": 3, "maxTotalCount": 12 },
        "configuredMetadata": { "maxImageCount": 12 }
      }
    ]
  }
]
```

`metadata` 为合并默认值后的完整元数据；`configuredMetadata` 为用户原始配置值。

### 按标签筛选

```
GET /api/workflows?tags=image-to-video&tags=reference
```

`tags` 参数可重复，多标签为 **AND** 语义；选中父标签且未选子标签时视为选中其全部子标签（向下包含）。

---

## 4. 查看任务状态

### 获取单个任务详情

```
GET /api/tasks/:taskId
```

需认证 (`Authorization: Bearer <token>`)。

**响应** `200`:

```json
{
  "id": "uuid-string",
  "workflowId": "my-workflow",
  "workflowName": "我的工作流",
  "promptId": "comfyui-prompt-id",
  "aliasValues": "{\"prompt\":\"cat\"}",
  "status": "pending",
  "errorMessage": null,
  "progress": 45,
  "outputFiles": null,
  "createdAt": "2026-07-27T00:00:00.000Z",
  "completedAt": null
}
```

**错误响应**:

| 状态码 | code | 说明 |
|--------|------|------|
| `404` | `task_not_found` | 任务不存在 |

### 状态说明

| 状态 | 说明 |
|------|------|
| `queued` | 排队等待执行（超过并发限制） |
| `pending` | 已提交到 ComfyUI，正在执行 |
| `completed` | 执行完成 |
| `failed` | 执行失败 |

`progress` 字段（0–100）表示进度百分比。

### 中断任务执行

```
POST /api/tasks/:taskId/cancel
```

需认证 (`Authorization: Bearer <token>`)。

中断正在执行（`pending`）或排队中（`queued`）的任务。
- `queued` 任务：直接标记为失败，无需通知 ComfyUI。
- `pending` 任务：向 ComfyUI 发送 `/interrupt` 请求，随后轮询 `GET /queue` 确认任务已停止执行；若仍在执行则重新调用 `/interrupt`，确认停止后再标记为失败。

**响应** `200`:

```json
{
  "task_id": "uuid-string",
  "status": "failed"
}
```

**错误响应**:

| 状态码 | code | 说明 |
|--------|------|------|
| `400` | `invalid_status` | 任务状态不是 `queued` 或 `pending`（如已完成或已失败） |
| `404` | `task_not_found` | 任务不存在 |

---

## 5. 下载工作流输出文件

### 获取输出文件列表

```
GET /api/tasks/:taskId/output-files
```

需认证 (`Authorization: Bearer <token>`)。

当任务状态为 `completed` 但本地尚未写入输出列表时，接口会向 ComfyUI `GET /history/{prompt_id}` 实时补全并回填数据库。  
首次补全为空时会**阻塞约 2 秒再重试一次**，然后返回结果。  
工作流本身无输出时仍返回空数组（最坏约 2 秒延迟）。  
建议外部调用在 `status=completed` 后使用本接口获取文件列表，而不是仅依赖任务详情中的 `outputFiles` 字段。

**响应** `200`:

```json
{
  "files": [
    {
      "filename": "output_001.png",
      "subfolder": "",
      "type": "output",
      "nodeId": "9",
      "fileType": "image",
      "url": "/api/tasks/uuid/output-files/output_001.png?subfolder=&type=output"
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `filename` | 文件名 |
| `subfolder` | ComfyUI output 子目录 |
| `type` | 固定为 `output` |
| `nodeId` | 生成该文件的节点 ID |
| `fileType` | `image` / `video` / `audio` |
| `url` | 下载 URL（proxy 模式为本站路径，direct 模式为执行提供商直连路径） |

### 下载单个文件

```
GET /api/tasks/:taskId/output-files/:filename
```

需认证 (`Authorization: Bearer <token>`)。

**查询参数**:

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `subfolder` | string | `""` | ComfyUI output 子目录 |
| `type` | string | `output` | ComfyUI 文件类型 |

**响应**: 流式返回文件内容，`Content-Type` 自动从 ComfyUI 响应头获取。

示例：

```
GET /api/tasks/abc-123/output-files/output_001.png?subfolder=&type=output
```

---

## 完整流程示例

```bash
# 1. 登录获取 Token
TOKEN=$(curl -s -X POST http://localhost:10721/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password": "0d000721"}' | jq -r '.token')

# 2. 提交工作流执行
EXEC_RESULT=$(curl -s -X POST http://localhost:10721/api/workflows/txt2img/execute \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cute cat"}')
TASK_ID=$(echo $EXEC_RESULT | jq -r '.task_id')
echo "Task ID: $TASK_ID"

# 3. 轮询任务状态
while true; do
  STATUS=$(curl -s http://localhost:10721/api/tasks/$TASK_ID \
    -H "Authorization: Bearer $TOKEN" | jq -r '.status')
  echo "Status: $STATUS"
  [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] && break
  sleep 2
done

# 4. 获取输出文件列表
curl -s http://localhost:10721/api/tasks/$TASK_ID/output-files \
  -H "Authorization: Bearer $TOKEN" | jq

# 5. 下载输出文件
curl -O "http://localhost:10721/api/tasks/$TASK_ID/output-files/output_001.png" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 错误码参考

| code | HTTP 状态码 | 场景 |
|------|------------|------|
| `missing_parameter` | 400 | 必填参数缺失 |
| `provider_not_configured` | 400 | 未配置默认执行提供商 / 工作流指定的实例不存在或已禁用 |
| `invalid_status` | 400 | 任务状态不允许当前操作（如取消已完成的任务） |
| `unauthorized` | 401 | Token 无效或过期 |
| `workflow_not_found` | 404 | 工作流不存在 |
| `task_not_found` | 404 | 任务不存在 |
| `provider_not_found` | 404 | 提供商实例不存在 |
| `default_provider_not_deletable` | 409 | 尝试删除全局默认提供商实例 |
| `comfyui_unreachable` | 502 | 执行提供商服务不可达 |
