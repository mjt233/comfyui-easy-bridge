# 第三方获取工作流列表调用说明

本文档面向**第三方系统**，说明如何调用桥接服务获取工作流列表（含工作流标签及其元数据）。配套的执行/任务/输出相关接口见 [workflow-api.md](./workflow-api.md)。

**基础路径**: `/api`
**默认服务端口**: `10721`（可通过 `PORT` 环境变量覆盖）

---

## 1. 认证

获取工作流列表是**受保护端点**，需要先登录获取 Token。

### 1.1 查询是否启用认证

```
GET /api/auth/status
```

```json
{ "authEnabled": true }
```

- `authEnabled: true` → 必须登录获取 Token 才能访问受保护端点
- `authEnabled: false` → 认证关闭，无需 Token 即可调用（但建议仍按带 Token 的方式实现）

### 1.2 登录获取 Token

```
POST /api/auth/login
Content-Type: application/json
```

```json
{ "password": "0d000721" }
```

响应（`200`）：

```json
{ "token": "<JWT>" }
```

> 说明：系统使用全局管理密码，默认密码为 `0d000721`，实际以部署方配置为准。

### 1.3 调用受保护端点

所有受保护接口请求头携带：

```
Authorization: Bearer <token>
```

Token 失效（`401 unauthorized`）时需重新登录获取新 Token。

---

## 2. 获取工作流列表

```
GET /api/workflows
Authorization: Bearer <token>
```

### 2.1 请求参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `tags` | 字符串（可重复） | 按标签筛选，可传多个；多标签为 **AND** 语义（见 3.3） |

示例（筛选出「图生视频」及其子标签相关的全部工作流）：

```
GET /api/workflows?tags=image-to-video
```

### 2.2 响应结构

返回工作流数组（`200 OK`），每个元素字段如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 工作流唯一 ID |
| `name` | string | 工作流名称 |
| `rawJson` | string | 工作流原始 JSON（ComfyUI 格式） |
| `buildScript` | string | 动态构建脚本源码；空串表示未配置 |
| `buildScriptEnabled` | integer | 是否启用动态构建：`0` 关闭 / `1` 启用（列表接口返回整数；详情接口返回 boolean） |
| `declaredParams` | string | 动态字段静态声明，**JSON 数组字符串**（如 `"[]"`）；详情接口返回解析后的数组 |
| `description` | string | 备注说明（Markdown 格式）；空串表示未填写 |
| `providerId` | string \| null | 指定的执行提供商实例 ID；`null` 表示使用全局默认实例 |
| `createdAt` | string | 创建时间（ISO 8601） |
| `updatedAt` | string | 更新时间（ISO 8601） |
| `tags` | object[] | 工作流标签（嵌套层级结构，见 2.3） |

> 注：列表接口 `buildScriptEnabled` / `declaredParams` 返回数据库原始形态（整数 / JSON 字符串）；
> 单个工作流详情接口 `GET /api/workflows/:id` 返回已解析形态（boolean / 数组）。第三方解析列表时请注意区分。

### 2.3 `tags` 字段结构（嵌套层级）

工作流的标签按**父标签分组**返回，每个父标签对象包含该工作流实际选中的子标签：

```json
"tags": [
  {
    "id": "image-to-video",
    "name": "图生视频",
    "tags": [
      {
        "id": "reference",
        "name": "全能参考",
        "metadata": {
          "maxImageCount": 9,
          "maxAudioCount": 3,
          "maxVideoCount": 3,
          "maxTotalCount": 12
        },
        "configuredMetadata": {}
      }
    ]
  },
  {
    "id": "text-to-image",
    "name": "文生图",
    "tags": []
  }
]
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| 外层 `id` / `name` | 父标签 ID / 显示名 |
| 外层 `tags` | 该父标签下被选中的子标签数组；仅打了父标签未打子标签时为空数组 `[]` |
| 内层 `id` / `name` | 子标签 ID / 显示名 |
| `metadata` | **合并默认值后的完整元数据**：始终包含标签定义中的全部字段，值为「用户配置值 ?? 字段默认值」 |
| `configuredMetadata` | **用户原始配置值**：仅包含用户显式填写的字段；未填写任何字段时为空对象 `{}` |

> 对第三方最实用的读取方式是 `metadata`（可直接用于业务判断，无需关心用户是否显式配置）。
> 标签属性（层级关系、元数据字段定义、是否预设）可通过 `GET /api/tags` 获取，见 4.2。

---

## 3. 标签体系与预设标签

### 3.1 标签规则

- 标签为**父 / 子两级**结构，仅支持一级子标签
- 工作流可打多个标签；打子标签时**必然同时**包含其父标签
- 系统预设标签**只读**（不可编辑、删除）；用户可自行添加自定义标签（及其子标签）
- 标签可定义**元数据字段**（类型：`number` / `string` / `boolean`，含默认值）

### 3.2 系统预设标签总览

系统内置以下预设标签（`GET /api/tags` 返回同一结构，`isPreset` 均为 `1`）：

| 父标签 ID | 父标签名 | 子标签 ID | 子标签名 | 元数据字段（键=默认值，类型） |
|-----------|----------|-----------|----------|-------------------------------|
| `text-to-image` | 文生图 | — | — | 无 |
| `image-edit` | 图片编辑 | — | — | 无 |
| `text-to-video` | 文生视频 | — | — | 无 |
| `image-to-video` | 图生视频 | `reference` | 全能参考 | `maxImageCount=9` (number)、`maxAudioCount=3` (number)、`maxVideoCount=3` (number)、`maxTotalCount=12` (number) |
| `image-to-video` | 图生视频 | `first-frame` | 首帧 | 无 |
| `image-to-video` | 图生视频 | `first-last-frame` | 首尾帧 | 无 |
| `image-to-video` | 图生视频 | `director` | 导演台 | 无 |
| `image-to-video` | 图生视频 | `audio-input` | 音频输入 | 无 |
| `image-to-video` | 图生视频 | `audio-output` | 音频输出 | 无 |
| `tts-voice-design` | TTS音色设计 | — | — | 无 |

**「全能参考」元数据字段定义**（`reference`）：

| 键 | 显示名 | 类型 | 默认值 | 含义 |
|----|--------|------|--------|------|
| `maxImageCount` | 图片数量 | number | 9 | 参考图片数量上限 |
| `maxAudioCount` | 音频数量 | number | 3 | 参考音频数量上限 |
| `maxVideoCount` | 视频数量 | number | 3 | 参考视频数量上限 |
| `maxTotalCount` | 参考总数量 | number | 12 | 参考素材总数量上限 |

> 用户可为工作流显式覆盖这些值（写入 `configuredMetadata`）；未覆盖时 `metadata` 中返回默认值。
> 除预设外，系统支持用户自定义标签，其 ID 与元数据定义以 `GET /api/tags` 实际返回为准。

### 3.3 按标签筛选语义

`GET /api/workflows?tags=...` 的筛选规则：

1. **多标签为 AND**：工作流须命中每一个传入的标签条件才会返回
2. **父标签向下包含**：选中父标签且未选其子标签时，命中打了该父标签**或**其任一子标签的工作流
3. **子标签精确匹配**：选中子标签时，只匹配显式打了该子标签的工作流
4. **组合语义**：如同时传入父标签与某子标签，则须命中「父标签（含全部子）」**且**「该子标签」

示例：

```
# 命中：打了 图生视频 或其任一子标签的工作流
GET /api/workflows?tags=image-to-video

# 命中：打了 图生视频（或任一子标签）且显式打了 全能参考 的工作流
GET /api/workflows?tags=image-to-video&tags=reference

# 命中：同时打了 图生视频(含子) 与 文生图 的工作流（AND）
GET /api/workflows?tags=image-to-video&tags=text-to-image
```

---

## 4. 完整调用示例

### 4.1 cURL

```bash
# ① 登录获取 Token
TOKEN=$(curl -s -X POST http://localhost:10721/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"0d000721"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# ② 获取全部工作流（含标签）
curl -s http://localhost:10721/api/workflows \
  -H "Authorization: Bearer $TOKEN"

# ③ 按标签筛选（图生视频 + 全能参考）
curl -s "http://localhost:10721/api/workflows?tags=image-to-video&tags=reference" \
  -H "Authorization: Bearer $TOKEN"
```

### 4.2 获取标签树（含全部预设/自定义标签定义与元数据字段）

```
GET /api/tags
Authorization: Bearer <token>
```

返回顶层标签数组，每项含 `children` 子标签数组、`isPreset`（1=预设只读）、`metadataDef`（元数据字段定义数组）：

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

### 4.3 Node.js / TypeScript

```ts
import axios from 'axios';

const BASE = 'http://localhost:10721/api';

// ① 登录
const { data: { token } } = await axios.post(`${BASE}/auth/login`, { password: '0d000721' });

// ② 获取工作流列表（可按标签筛选）
const { data: workflows } = await axios.get(`${BASE}/workflows`, {
  headers: { Authorization: `Bearer ${token}` },
  params: { tags: ['image-to-video', 'reference'] }, // 可选；多标签 AND
});

// ③ 读取某工作流的标签与元数据
for (const wf of workflows) {
  for (const group of wf.tags) {
    // group: { id, name, tags: [{ id, name, metadata, configuredMetadata }] }
    for (const child of group.tags) {
      if (child.id === 'reference') {
        // metadata 为合并默认值后的完整元数据，可直接使用
        console.log(child.metadata.maxImageCount); // 9（未配置时）
      }
    }
  }
}
```

### 4.4 Python

```python
import requests

BASE = "http://localhost:10721/api"

# ① 登录
token = requests.post(f"{BASE}/auth/login", json={"password": "0d000721"}).json()["token"]
headers = {"Authorization": f"Bearer {token}"}

# ② 获取工作流列表（可按标签筛选）
workflows = requests.get(f"{BASE}/workflows", headers=headers,
                         params=[("tags", "image-to-video"), ("tags", "reference")]).json()

# ③ 读取标签
for wf in workflows:
    for group in wf["tags"]:
        for child in group["tags"]:
            meta = child["metadata"]  # 合并默认值后的完整元数据
            print(wf["id"], group["id"], child["id"], meta)
```

---

## 5. 错误码

| HTTP 状态 | code | 场景 |
|-----------|------|------|
| 400 | `missing_parameter` | 请求参数缺失或格式错误 |
| 401 | `unauthorized` | Token 无效 / 过期（需重新登录） |
| 404 | `workflow_not_found` | 工作流不存在 |

---

## 6. 相关接口指引

- **提交工作流执行**：`POST /api/workflows/:id/execute`（公开端点）→ 见 [workflow-api.md](./workflow-api.md)
- **任务状态 / 中断 / 输出下载**：`/api/tasks/*` → 见 [workflow-api.md](./workflow-api.md)
- **标签管理（增删改自定义标签、设置工作流标签）**：`/api/tags`、`PUT /api/workflows/:id/tags` → 见 [workflow-api.md](./workflow-api.md) 第 3 章
- **执行提供商实例管理**：`/api/providers` → 见 [workflow-api.md](./workflow-api.md) 第 2 章
