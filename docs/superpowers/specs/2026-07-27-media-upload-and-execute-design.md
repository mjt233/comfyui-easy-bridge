# 媒体文件上传并执行工作流设计

## 背景

ComfyUI 的 API 工作流中，`LoadImage`/`LoadVideo`/`LoadAudio` 类节点需要通过 `inputs.image`（或其对应字段）以**文件名字符串**引用已在 ComfyUI `input/` 目录中的文件。用户要使用自己的图片/视频/音频文件，必须先手动上传到 ComfyUI，然后才能在 aliasValues 中传入文件名。这破坏了单一调用体验（"一次 submitPrompt 完成所有操作"）。

## 目标

让用户只需调用**一次** `POST /api/workflows/:id/execute`，即可完成：
1. 上传媒体文件到 ComfyUI
2. 自动将对应节点的字段值设为上传后的文件名
3. 提交 Prompt 到 ComfyUI 执行

同时支持：
- **上传本地文件**：用户在请求中附加二进制文件，服务端自动上传到 ComfyUI
- **引用已有文件**：用户直接传入 ComfyUI 上已存在的文件名

## 方案选型

### 选定方案：单端点 multipart 执行（方案 A）

- 复用现有 `POST /api/workflows/:id/execute` 端点
- 检测 `Content-Type: multipart/form-data` 时同时接收 alias JSON + 文件上传
- `Content-Type: application/json` 时保持完全向后兼容

## 详细设计

### 1. 数据库 Schema 变更

**`workflow_params` 表新增 `param_type` 列**

| 列名 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `param_type` | `TEXT` | `'text'` | 参数类型：`text`、`image`、`video`、`audio` |

Drizzle schema 变更（`packages/server/src/models/schema.ts`）：
```typescript
export const workflowParams = sqliteTable('workflow_params', {
  // ... 现有字段不变
  paramType: text('param_type').notNull().default('text'),
});
```

DDL 同步（`packages/server/src/models/db.ts`）建表语句增加该列。

### 2. 后端新增/修改文件

#### 2.1 新增 `upload.service.ts`

职责：将文件上传到 ComfyUI 的对应端点。

```typescript
/** 将文件上传到 ComfyUI，返回 ComfyUI 存储的文件名 */
export async function uploadFileToComfyUI(
  file: { buffer: Buffer; originalname: string; mimetype: string },
  mediaType: 'image' | 'video' | 'audio',
  comfyuiBaseUrl: string,
): Promise<string>
```

- 构建 FormData 调用 `POST ${comfyuiBaseUrl}/upload/${mediaType}`
- 从 ComfyUI 响应中提取 `name` 字段返回
- 失败时抛出异常

支持的 ComfyUI 上传端点：
- `POST /upload/image` — 返回 `{ name, subfolder, type }`
- `POST /upload/video` — 同 image
- `POST /upload/audio` — 同 image（ComfyUI 可能不支持，预留）

#### 2.2 修改 `executor.service.ts`

- `WorkflowParam` 接口新增 `paramType` 字段
- 新增 `processMediaParams()` 函数：
  ```typescript
  async function processMediaParams(
    params: WorkflowParam[],
    aliasValues: Record<string, string>,
    files: Record<string, Express.Multer.File>,
    comfyuiBaseUrl: string,
  ): Promise<Record<string, string>>
  ```
  遍历 params，对于 `paramType !== 'text'` 的条目：
  - 如果 `files[alias]` 存在 → 上传到 ComfyUI，用返回的文件名覆盖 aliasValues
  - 如果不存在 → 保留 aliasValues 原值（已有文件引用）
- `executeWorkflow()` 签名增加可选 `files` 参数

#### 2.3 修改 `workflow.controller.ts` 的 `execute` 方法

```typescript
async execute(req: Request, res: Response): Promise<void> {
  const isMultipart = req.is('multipart/form-data');
  let aliasValues: Record<string, string>;
  let files: Record<string, Express.Multer.File>;

  if (isMultipart) {
    aliasValues = JSON.parse(req.body.params || '{}');
    // multer 将文件放到 req.files
    files = (req.files as { [fieldname: string]: Express.Multer.File[] }) || {};
  } else {
    aliasValues = req.body;
    files = {};
  }

  // ... 验证参数（applyAliases 会检查缺失参数）

  // 处理媒体文件上传
  const finalAliasValues = await processMediaParams(params, aliasValues, files, baseUrl);

  // 后续逻辑不变（并发检查、executeWorkflow、创建任务日志）
  const result = await executeWorkflow(wf.rawJson, params, finalAliasValues, baseUrl);
}
```

#### 2.4 修改 `workflow.routes.ts`

引入 multer 中间件：
```typescript
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage() });

// execute 路由添加 multer 解析
router.post('/:id/execute', upload.any(), controller.execute);
```

#### 2.5 修改 `workflow.service.ts`

`addParam()` 和 `updateParam()` 支持 `param_type` 字段。

### 3. 前端改动

#### 3.1 类型

`packages/client/src/types/index.ts`：
```typescript
export interface WorkflowParam {
  // ... 现有字段
  paramType: 'text' | 'image' | 'video' | 'audio';
}
```

#### 3.2 API 模块

`packages/client/src/api/workflows.ts`：
- `executeWorkflow()` 新增可选 `files` 参数，检测有文件时使用 FormData

#### 3.3 执行对话框 (`WorkflowListPage.vue`)

根据 `param.paramType` 切换控件：
- `text` → `<v-textarea>`（现有行为）
- `image` → `<v-file-input accept="image/*">`
- `video` → `<v-file-input accept="video/*">`
- `audio` → `<v-file-input accept="audio/*">`

提交时收集文件，通过 FormData 发送。

#### 3.4 参数编辑 (`WorkflowDetailPage.vue`)

参数列表显示类型标签；编辑时支持选择类型。

### 4. 数据流

```
用户请求 (multipart/form-data)
  │
  ├─ params: JSON 字符串 { "text_prompt": "cat", "input_image": "old.png" }
  └─ input_image: <File>  (文件名: new_photo.png)
        │
        ▼
  服务端解析
        │
        ├─ param_type=image, alias="input_image"
        │   └─ 有上传文件 → uploadFileToComfyUI(new_photo.png)
        │       └─ ComfyUI 返回 { name: "new_photo.png" }
        │       └─ finalAliasValues["input_image"] = "new_photo.png"
        │
        └─ param_type=text, alias="text_prompt"
            └─ finalAliasValues["text_prompt"] = "cat"
        │
        ▼
  applyAliases(rawJson, params, finalAliasValues)
        │
        ▼
  submitPrompt(modifiedJson, baseUrl)
        │
        ▼
  ComfyUI 执行
```

### 5. 排队任务兼容性

`task_logs.comfyuiRequestBody` 在排队时已经包含替换后的完整 prompt JSON。文件只需在首次提交时上传一次，后续队列重放（`drainQueue` / `POST /tasks/:id/submit`）不需要重新上传文件。无需额外改动排队逻辑。

### 6. 错误处理

- 文件上传到 ComfyUI 失败 → 任务标记为 `failed`，`errorMessage` 记录 ComfyUI 错误
- 文件格式不匹配 → 由 multer 或 ComfyUI 校验
- 参数缺失（必填 alias 无值且无对应文件） → `applyAliases` 抛出 `Missing required parameter`
- multipart 解析失败 → express/multer 返回 400

### 7. 向后兼容

- 纯 JSON 请求 (`Content-Type: application/json`) 完全不受影响
- 已有 `workflow_params` 记录 `param_type` 默认为 `'text'`，行为不变
- 前端文本类型参数流程不变
