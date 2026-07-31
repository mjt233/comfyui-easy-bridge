# 工作流附件与批量导入导出设计

## 背景

当前 ComfyUI Easy Bridge 中，工作流只能保存 `name` + `rawJson` + 参数配置，无法绑定额外的资源文件（如参考图、模型说明、脚本等）。同时缺少工作流的备份/迁移能力，用户无法把工作流连同资源一起导出到另一台机器。

## 目标

1. 新增/编辑工作流时支持**上传、下载、删除附件**，附件与工作流绑定。
2. 工作流支持**多选导出**和**批量导入**，导出内容包含工作流本体、参数配置以及附件。

## 方案选型（已确认）

- **附件存储**：服务端磁盘 `<DATA_DIR>/attachments/<stored_name>`，stored_name 为 uuid+扩展名（扁平目录，工作流改 ID 时无需迁移文件）。
- **新建工作流附件**：新建页可选附件暂存，点保存时先创建工作流，再自动逐个上传附件。
- **导出/导入格式**：ZIP 压缩包，包含 `manifest.json` + `attachments/` 二进制文件。
- **导入 ID 冲突**：自动生成新 ID（追加 `-import-<随机>` 后缀）并导入，返回新旧 ID 映射。

## 详细设计

### 1. 数据库 Schema 变更

新增 `workflow_attachments` 表（`packages/server/src/models/schema.ts`）：

| 列名 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK AUTOINCREMENT | 附件行 ID |
| `workflow_id` | TEXT NOT NULL FK → workflows.id ON DELETE CASCADE | 所属工作流 |
| `filename` | TEXT NOT NULL | 用户上传的原始文件名 |
| `stored_name` | TEXT NOT NULL | 磁盘存储名（uuid + 扩展名） |
| `size` | INTEGER NOT NULL | 文件字节数 |
| `mimetype` | TEXT | MIME 类型（可空） |
| `created_at` | TEXT NOT NULL | 创建时间 |

DDL 同步到 `packages/server/src/models/db.ts`（`CREATE TABLE IF NOT EXISTS`）。

### 2. 后端新增/修改文件

#### 2.1 新增 `services/attachment.service.ts`

职责：附件记录的 CRUD + 磁盘文件读写。

```typescript
export class AttachmentService {
  list(workflowId: string): WorkflowAttachment[]
  create(workflowId, { filename, buffer, mimetype }): WorkflowAttachment
  getById(id: number): WorkflowAttachment | null
  getFilePath(attachment): string   // <DATA_DIR>/attachments/<stored_name>
  readBuffer(attachment): Buffer
  delete(id: number): void          // 删磁盘文件 + 删行
  deleteByWorkflow(workflowId: string): void  // 删该工作流所有附件文件 + 行
}
```

- `create` 用 `randomUUID()` + 清理后的扩展名生成 `storedName`；扩展名从原始文件名提取并做安全字符过滤（复用 `upload.service.ts` 的 sanitize 思路）。
- `attachmentsDir` 由 `DATA_DIR` 环境变量决定（与 `db.ts` 一致），目录不存在时自动创建。
- 文件写入使用 `fs.writeFileSync`，读取用 `fs.readFileSync`。
- 删除工作流时（`workflow.controller.ts` 的 `delete`）调用 `deleteByWorkflow` 清理磁盘文件，DB 行由 FK 级联删除。

#### 2.2 新增 `services/workflow-io.service.ts`

职责：多选导出 + 批量导入（依赖 `jszip`）。

```typescript
export class WorkflowIOService {
  async exportWorkflows(ids: string[]): Promise<Buffer>
  async importWorkflows(zipBuffer: Buffer): Promise<ImportResult>
}
```

**ZIP 结构**：
```
manifest.json
  { version: 1, exportedAt: ISO, workflows: [ { id, name, rawJson, createdAt, updatedAt, params: [...], attachments: [{filename, storedName, size, mimetype}] } ] }
attachments/<storedName>   附件二进制
```

**导出**：遍历 ids → 查询工作流、参数、附件 → 写入 manifest + 附件文件 → `zip.generateAsync({ type: 'nodebuffer' })`。

**导入**：
- 读取 manifest，逐个处理：
  - 若 ID 已存在 → 生成 `{id}-import-<随机>` 直到唯一，记录 `renamed: {oldId, newId}`。
  - 插入 workflow 行（保留 createdAt/updatedAt）。
  - 插入 params 行（保留 alias/label/paramType/defaultValue）。
  - 附件：从 zip 读取 buffer → 生成新 storedName 写入磁盘 → 插入附件行。
- 返回 `{ imported: number, renamed: Array<{old,new}>, failed: Array<{id, reason}> }`。
- 附件项缺失对应 zip 文件时计入 `failed` 但不中断整个导入。

#### 2.3 修改 `controllers/workflow.controller.ts`

新增 handler：
- `uploadAttachment`：multer 解析单个 `file` 字段 → `attachmentService.create` → 201 返回附件记录
- `listAttachments`：返回 `attachmentService.list(id)`
- `downloadAttachment`：查附件行 → 校验属于该工作流 → 设置 `Content-Disposition: attachment; filename*=UTF-8''...` → 返回文件流
- `deleteAttachment`：删除附件（行 + 文件）
- `exportWorkflows`：body `{ ids: string[] }` → `workflowIOService.exportWorkflows` → 返回 zip（`Content-Type: application/zip` + `Content-Disposition`）
- `importWorkflows`：multer 解析 `file` → `workflowIOService.importWorkflows` → 返回摘要
- 修改 `delete`：先调用 `attachmentService.deleteByWorkflow(id)` 再删除工作流

#### 2.4 修改 `routes/workflow.routes.ts`

```typescript
// 挂载顺序：静态路径（export/import）在 :id 之前
router.post('/export', auth, controller.exportWorkflows);
router.post('/import', auth, upload.single('file'), controller.importWorkflows);
router.get('/:id/attachments', auth, controller.listAttachments);
router.post('/:id/attachments', auth, upload.single('file'), controller.uploadAttachment);
router.get('/:id/attachments/:attachmentId/download', auth, controller.downloadAttachment);
router.delete('/:id/attachments/:attachmentId', auth, controller.deleteAttachment);
```

#### 2.5 依赖

`pnpm --filter server add jszip` 与 `pnpm --filter server add -D @types/jszip`。

### 3. 前端改动

#### 3.1 类型 `client/src/types/index.ts`

```typescript
export interface WorkflowAttachment {
  id: number;
  workflowId: string;
  filename: string;
  storedName: string;
  size: number;
  mimetype: string | null;
  createdAt: string;
}
```

#### 3.2 API 模块 `client/src/api/workflows.ts`

- `listAttachments(workflowId)`
- `uploadAttachment(workflowId, file: File)`（FormData）
- `downloadAttachment(workflowId, attachmentId)`（blob，触发浏览器下载）
- `deleteAttachment(workflowId, attachmentId)`
- `exportWorkflows(ids: string[])`（blob 下载 zip）
- `importWorkflows(file: File)`（FormData，返回摘要）

#### 3.3 `WorkflowEditPage.vue` 附件区

- **编辑模式**：附件卡片展示已有附件列表（文件名/大小/时间），提供上传、下载、删除操作；上传立即调用 API。
- **新建模式**：附件卡片展示"待保存"文件队列（`pendingFiles`），保存成功后逐个上传，再跳转列表。
- 上传/删除中显示 loading，错误通过 snackbar 提示。

#### 3.4 `WorkflowListPage.vue` 多选 + 导入导出

- 列表项加复选框（`selectedIds: Set<string>`），表头加"全选"。
- 工具栏（工作流数 > 0 时显示）：
  - **导出选中**：调用 `exportWorkflows(selectedIds)` → 下载 `workflows-export-<时间戳>.zip`。
  - **导入**：隐藏的 `<input type="file" accept=".zip">` → `importWorkflows(file)` → 显示摘要 snackbar（导入数量 + 重命名映射）→ 刷新列表。
- 无选中时导出按钮禁用。

### 4. 数据流

```
上传附件: 前端 File → POST /api/workflows/:id/attachments (multipart) → multer → AttachmentService.create → 磁盘 + DB
下载附件: GET /api/workflows/:id/attachments/:id/download → 读磁盘 → 二进制响应
导出: 前端选中 ids → POST /api/workflows/export → WorkflowIOService 打包 ZIP → 前端下载
导入: 前端 ZIP → POST /api/workflows/import → 解析 manifest + 附件 → 写 DB + 磁盘 → 返回摘要
```

### 5. 错误处理

- 上传无文件 / 工作流不存在 → 400 / 404（沿用 `missing_parameter` / `workflow_not_found` 错误码）
- 附件不属于该工作流 → 404
- 导入的 ZIP 缺少 `manifest.json` 或格式非法 → 400
- 单个工作流导入失败 → 计入 `failed`，其余继续
- 下载附件文件丢失 → 404

### 6. 测试

- `attachment.service.test.ts`：create/list/get/delete/deleteByWorkflow，文件落盘与清理，使用临时 DATA_DIR
- `workflow-io.service.test.ts`：导出 → 导入 round-trip（含附件、参数、ID 冲突改名），非法 ZIP 报错
- `workflow.routes.test.ts`：附件上传/列表/下载/删除、导出/导入 API 集成测试（测试建表语句补 `workflow_attachments`）
- 附件下载测试校验 `Content-Disposition` 与响应体

### 7. 向后兼容

- 新增表/路由/接口均为增量，不影响现有 API
- 旧数据库启动时自动创建新表
- 导出仅包含选中工作流，无副作用
