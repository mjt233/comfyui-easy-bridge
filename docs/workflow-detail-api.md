# 获取单个工作流详情 API 文档

本文档说明如何调用桥接服务获取**单个工作流的完整详情**，返回结构比列表接口（[workflow-list-api.md](./workflow-list-api.md)）更丰富：包含已解析的动态字段声明（`declaredParams` 数组）、参数配置（`params`）、执行提供商摘要（`resolvedProvider`）与标签分组（`tags`）。

**基础路径**: `/api`
**默认服务端口**: `10721`（可通过 `PORT` 环境变量覆盖）

---

## 1. 认证

获取工作流详情是**受保护端点**，需要先登录获取 Token：

```
GET /api/auth/status      # 查询是否启用认证
POST /api/auth/login      # 登录，body: { "password": "0d000721" }，返回 { "token": "<JWT>" }
```

调用详情接口时请求头携带：

```
Authorization: Bearer <token>
```

Token 失效（`401 unauthorized`）时需重新登录获取新 Token。详细说明见 [workflow-list-api.md](./workflow-list-api.md) 第 1 节。

---

## 2. 获取单个工作流详情

```
GET /api/workflows/:id
Authorization: Bearer <token>
```

`id` 为工作流唯一 ID（路径参数）。

### 2.1 响应结构（`200 OK`）

```json
{
  "id": "text_to_image",
  "name": "文生图",
  "rawJson": "{\"3\":{\"inputs\":{\"seed\":1,\"steps\":20,\"cfg\":8,\"sampler_name\":\"euler\"},\"class_type\":\"KSampler\",\"_meta\":{\"title\":\"采样器\"}}}",
  "buildScript": "",
  "buildScriptEnabled": false,
  "declaredParams": [
    {
      "alias": "prompt",
      "label": "提示词",
      "paramType": "text",
      "defaultValue": null
    }
  ],
  "description": "示例工作流",
  "providerId": null,
  "resolvedProvider": {
    "id": "local-comfyui",
    "name": "本地 ComfyUI",
    "type": "comfyui",
    "resolvedBaseUrl": "http://localhost:8188"
  },
  "createdAt": "2026-08-08T00:00:00.000Z",
  "updatedAt": "2026-08-08T00:00:00.000Z",
  "params": [
    {
      "id": 1,
      "workflowId": "text_to_image",
      "nodeId": "3",
      "fieldName": "seed",
      "alias": "seed",
      "label": "随机种子",
      "paramType": "number",
      "defaultValue": null
    }
  ],
  "tags": [
    {
      "id": "text-to-image",
      "name": "文生图",
      "metadata": {},
      "configuredMetadata": {},
      "tags": []
    }
  ]
}
```

### 2.2 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 工作流唯一 ID |
| `name` | string | 工作流名称 |
| `rawJson` | string | 工作流原始 JSON（ComfyUI 格式） |
| `buildScript` | string | 动态构建脚本源码；空串表示未配置 |
| `buildScriptEnabled` | boolean | 是否启用动态构建（详情接口返回 **boolean**，列表接口返回整数 `0/1`） |
| `declaredParams` | object[] | 动态字段静态声明，**已解析为数组**（列表接口返回 JSON 数组字符串）。元素结构见 2.3 |
| `description` | string | 备注说明（Markdown 格式）；空串表示未填写 |
| `providerId` | string \| null | 指定的执行提供商实例 ID；`null` 表示使用全局默认实例 |
| `resolvedProvider` | object \| null | 解析后的执行提供商摘要（见 2.4）；工作流未指定且全局默认不可用时为 `null` |
| `createdAt` | string | 创建时间（ISO 8601） |
| `updatedAt` | string | 更新时间（ISO 8601） |
| `params` | object[] | 工作流参数配置列表（见 2.5） |
| `tags` | object[] | 工作流标签嵌套分组结构（见 2.6） |

> 与列表接口（`GET /api/workflows`）的差异：`buildScriptEnabled` 为 boolean、`declaredParams` 为解析后的数组，并额外包含 `params`、`resolvedProvider` 两个字段。

### 2.3 `declaredParams` 元素结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `alias` | string | 对外参数别名（执行接口 `POST /api/workflows/:id/execute` 使用该别名传参） |
| `label` | string \| null | 展示标签；`null` 表示未设置 |
| `paramType` | string | 参数类型：`text` \| `number` \| `boolean` \| `image` \| `video` \| `audio` |
| `defaultValue` | string \| null | 默认值；`null` 表示未设置 |

### 2.4 `resolvedProvider` 字段说明

执行提供商实例的实际生效摘要（工作流 `providerId` 优先，未指定时回退全局默认）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 提供商实例 ID |
| `name` | string | 实例展示名 |
| `type` | string | 提供商类型：`comfyui` \| `runninghub` |
| `resolvedBaseUrl` | string | 实际执行地址（comfyui 为配置的 `baseUrl`；runninghub 由 apiKey 推导） |

### 2.5 `params` 元素结构

对应 `workflow_params` 表的参数配置行：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 参数行 ID |
| `workflowId` | string | 所属工作流 ID |
| `nodeId` | string | ComfyUI 节点 ID |
| `fieldName` | string | 节点字段名 |
| `alias` | string \| null | 对外参数别名；`null` 表示不暴露为可传参字段 |
| `label` | string \| null | 展示标签 |
| `paramType` | string | 参数类型：`text` \| `number` \| `boolean` \| `image` \| `video` \| `audio` |
| `defaultValue` | string \| null | 默认值覆盖；`null` 表示使用 `rawJson` 原值 |

### 2.6 `tags` 字段结构（嵌套分组）

与列表接口一致，按父标签分组返回：

```json
"tags": [
  {
    "id": "image-to-video",
    "name": "图生视频",
    "metadata": {},
    "configuredMetadata": {},
    "tags": [
      {
        "id": "reference",
        "name": "全能参考",
        "metadata": { "maxImageCount": 9, "maxAudioCount": 3, "maxVideoCount": 3, "maxTotalCount": 12 },
        "configuredMetadata": { "maxImageCount": 12 }
      }
    ]
  }
]
```

| 字段 | 说明 |
|------|------|
| 外层 `id` / `name` | 父标签 ID / 显示名 |
| 外层 `metadata` / `configuredMetadata` | 父标签自身的元数据（合并默认值 / 用户原始配置值） |
| 外层 `tags` | 该父标签下被选中的子标签数组；仅打了父标签未打子标签时为空数组 `[]` |
| 内层 `id` / `name` | 子标签 ID / 显示名 |
| 内层 `metadata` | 合并默认值后的完整元数据（恒含字段定义中的全部键） |
| 内层 `configuredMetadata` | 用户原始配置值（仅含用户显式填写的键） |

> 更完整的标签筛选与打标说明见 [workflow-api.md](./workflow-api.md) 第 3 节与 [workflow-list-api.md](./workflow-list-api.md) 第 3 节。

### 2.7 错误响应

| 状态码 | code | 说明 |
|--------|------|------|
| `401` | `unauthorized` | Token 无效/过期或未携带 |
| `404` | `workflow_not_found` | 工作流不存在 |

错误响应体格式：

```json
{ "error": "Workflow not found", "code": "workflow_not_found" }
```

---

## 3. 示例

### 3.1 cURL

```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:10721/api/workflows/text_to_image
```

### 3.2 相关接口速查

| 接口 | 说明 |
|------|------|
| `GET /api/workflows` | 获取工作流列表（列表形态字段） |
| `GET /api/workflows/:id` | 获取单个工作流详情（本文档） |
| `POST /api/workflows/:id/execute` | 提交工作流执行（公开端点，无需认证） |
| `GET /api/tasks/:taskId` | 查看任务状态 |
| `PUT /api/workflows/:id/tags` | 设置工作流标签 |
