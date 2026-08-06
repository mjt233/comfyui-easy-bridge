# 工作流相关 API 文档

本文档覆盖四个核心 API：提交工作流执行、查看任务状态、中断任务、下载输出文件。

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
| `400` | `missing_parameter` | ComfyUI 基础 URL 未配置 |
| `404` | `workflow_not_found` | 工作流不存在 |
| `502` | `comfyui_unreachable` | ComfyUI 服务不可达 |

---

## 2. 查看任务状态

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

## 3. 下载工作流输出文件

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
| `url` | 下载 URL（proxy 模式为本站路径，direct 模式为 ComfyUI 直连路径） |

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
| `missing_parameter` | 400 | 必填参数缺失 / ComfyUI URL 未配置 |
| `invalid_status` | 400 | 任务状态不允许当前操作（如取消已完成的任务） |
| `unauthorized` | 401 | Token 无效或过期 |
| `workflow_not_found` | 404 | 工作流不存在 |
| `task_not_found` | 404 | 任务不存在 |
| `comfyui_unreachable` | 502 | ComfyUI 服务不可达 |
