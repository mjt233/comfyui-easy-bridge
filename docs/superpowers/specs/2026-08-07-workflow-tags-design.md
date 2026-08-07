# 工作流标签系统（多标签 + 分级 + 元数据）设计

## 背景

当前系统的工作流没有任何分类/标签能力。需求：工作流支持打**多个标签**，标签**分级管理**（父/子两级），标签可定义**元数据**；并提供标签管理、打标签、按标签筛选等能力。

## 需求

1. 工作流可打多个标签；标签分父子两级
2. **层级不变量**：工作流打子标签时必然同时打父标签；不允许脱离父标签直接选择子标签（前后端均校验）
3. 标签支持元数据定义：固定字段（键、显示名、类型、默认值）
4. 系统预设标签（只读参考模板）：
   - 文生图 `text-to-image`
   - 图片编辑 `image-edit`
   - 文生视频 `text-to-video`
   - 图生视频 `image-to-video`（父标签，含 6 个子标签）
     - 全能参考 `reference`（元数据：图片数量 9 / 音频数量 3 / 视频数量 3 / 参考总数量 12）
     - 首帧 `first-frame`
     - 首尾帧 `first-last-frame`
     - 导演台 `director`
     - 音频输入 `audio-input`
     - 音频输出 `audio-output`
   - TTS 音色设计 `tts-voice-design`
5. 用户可添加自定义标签及其子标签（标签管理页面）
6. 工作流列表与工作流详情支持对工作流打标签
7. 工作流列表支持按标签筛选
8. 获取工作流列表的接口需包含标签结构（嵌套层级对象）
9. 工作流导入导出需支持标签

## 关键决策（已与用户确认）

| 决策点 | 结论 |
|--------|------|
| 数据模型 | **方案 A：双表规范化**（`tags` 定义表 + `workflow_tags` 关联表） |
| 元数据形态 | 标签定义一组固定字段（键 / 显示名 / 类型 / 默认值）；类型支持 `number` / `string` / `boolean` |
| 元数据开放范围 | **所有标签**（预设 + 自定义）都可在管理页定义元数据字段；【全能参考】的 4 字段只是初始内置数据 |
| 预设标签 | **只读参考模板**：不可改名、不可编辑、不可删除；仅可被参考 |
| 自定义标签 | 可新建（含子标签）、编辑 name/metadataDef、删除（有约束，见下） |
| 自定义标签 id | `uuid`（预设用固定英文标识） |
| 打标签元数据 UX | 默认隐藏、可展开编辑、非必填；未填写时用字段默认值 |
| 列表元数据双字段 | `metadata`（合并默认值后的完整对象）与 `configuredMetadata`（用户原始配置值）分开返回 |
| 筛选语义 | 多标签 **AND**；选父标签未选子标签 = 视为选中其全部子标签（向下包含）；子标签精确匹配 |
| 删除策略 | 自定义标签：有子标签或被工作流引用时**拒绝删除**（需先清理） |
| 导入导出 | manifest **v2**：顶层带标签定义 + 工作流带关联数组；向后兼容 v1 |
| 子标签层级 | 仅两级（父 → 子），不支持更深层级 |

## 数据模型

### 新增 `tags` 表（标签定义）

```ts
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),              // 预设固定英文标识（如 "image-to-video"）；自定义为 uuid
  name: text('name').notNull(),             // 显示名（同层级内唯一）
  parentId: text('parent_id'),              // 父标签 id；null = 顶层标签；创建后不可改
  isPreset: integer('is_preset').notNull().default(0), // 1=预设只读，0=用户自定义
  metadataDef: text('metadata_def').notNull().default('[]'), // JSON：元数据字段定义数组
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

**元数据字段定义**（`metadataDef` 的 JSON 数组元素）：

```ts
interface TagMetadataFieldDef {
  /** 字段键，如 "maxImageCount" */
  key: string;
  /** 显示名，如 "图片数量" */
  label: string;
  /** 字段类型：number / string / boolean */
  type: 'number' | 'string' | 'boolean';
  /** 默认值（类型与 type 匹配） */
  defaultValue: number | string | boolean;
}
```

预设【全能参考】的 `metadataDef` 初始值：

```json
[
  { "key": "maxImageCount", "label": "图片数量", "type": "number", "defaultValue": 9 },
  { "key": "maxAudioCount", "label": "音频数量", "type": "number", "defaultValue": 3 },
  { "key": "maxVideoCount", "label": "视频数量", "type": "number", "defaultValue": 3 },
  { "key": "maxTotalCount", "label": "参考总数量", "type": "number", "defaultValue": 12 }
]
```

### 新增 `workflow_tags` 表（多对多关联）

```ts
export const workflowTags = sqliteTable('workflow_tags', {
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  /** 用户为工作流配置的元数据原始值 {key: value}；未配置的键不存在 */
  metadataValues: text('metadata_values').notNull().default('{}'),
}, (table) => ({
  pk: primaryKey({ columns: [table.workflowId, table.tagId] }),
}));
```

- `parentId` 不建外键（与 `workflows.provider_id` 的应用层校验风格一致），层级合法性由 service 校验
- 删除标签的级联由 service 层**先拒绝**（有子 / 被引用），FK cascade 仅作兜底

## 列表接口 tags 结构（嵌套层级对象）

`GET /api/workflows` 与 `GET /api/workflows/:id` 响应中的每个工作流新增 `tags` 字段：

```ts
tags: Array<{
  id: string;          // 父标签 id
  name: string;        // 父标签显示名
  tags: Array<{        // 该父标签下被选中的子标签
    id: string;
    name: string;
    /** 合并默认值后的完整元数据（恒含定义中的全部字段） */
    metadata: Record<string, number | string | boolean>;
    /** 用户原始配置值（仅含用户填写的键；可为空对象） */
    configuredMetadata: Record<string, number | string | boolean>;
  }>;
}>
```

- 顶层标签（无子标签，如文生图）出现在外层数组，`tags: []`
- 选中父标签但未选子标签时，外层数组含该父标签，`tags: []`
- 无元数据定义的标签 `metadata` / `configuredMetadata` 均为空对象
- `metadata[key] = configuredMetadata[key] ?? defaultValue`（按定义合并）

## 后端 API

### 标签管理（`/api/tags`，需认证）

```
GET    /api/tags             # 标签树：{ id, name, parentId, isPreset, metadataDef, children: [...] }
POST   /api/tags             # 新建自定义标签 { name, parentId?, metadataDef? }
PUT    /api/tags/:id         # 编辑 name / metadataDef（预设 403；parentId 不可改）
DELETE /api/tags/:id         # 删除自定义标签（预设 / 有子 / 被引用 → 拒绝）
```

校验规则：

- `name` 必填非空，**同层级内唯一**（违反 → `tag_conflict`）
- `parentId` 必须指向存在的标签（违反 → `tag_not_found`）；仅允许一级子标签（parentId 指向的标签不能再有父标签）
- `metadataDef`：数组元素须含 `key`（非空、同标签内唯一）、`label`、`type`（`number`/`string`/`boolean` 白名单）、`defaultValue`（类型与 type 匹配）
- 预设标签（`isPreset=1`）：任何写操作返回 403 `tag_preset_readonly`
- 删除拒绝场景：`tag_preset_readonly`（预设）/ `tag_has_children`（存在子标签）/ `tag_in_use`（被工作流引用）

### 工作流打标签（`/api/workflows/:id/tags`，需认证）

```
PUT /api/workflows/:id/tags   # 整组替换 { tags: [{ tagId, metadataValues? }] }
```

校验（在事务内替换全部关联）：

- 每个 `tagId` 必须存在（`tag_not_found`）
- **子必带父**：集合中含子标签时必须同时含其父标签（`parent_tag_required`）
- `metadataValues` 的键必须 ⊆ 该标签 `metadataDef` 的 key，且值类型与字段 `type` 匹配（`invalid_metadata`）
- 未配置 `metadataValues` 或配置为空对象时存 `{}`

### 工作流列表筛选（`GET /api/workflows?tags=...`）

- `tags` 查询参数可重复（`?tags=image-to-video&tags=reference`），值为标签 id
- **AND 语义**：工作流须对每个选中标签至少命中一个「有效标签」
- 有效标签展开规则：
  - 选中**父标签** → 有效集合 = {父} ∪ {全部直接子标签}
  - 选中**子标签** → 有效集合 = {该子标签}
- SQL 实现：每个选中标签一个 `EXISTS` 子查询（`workflow_tags` 中 `tagId IN (有效集合)`），多条件 AND

## 导入导出（manifest v2）

ZIP 结构不变（`manifest.json` + `attachments/`），`manifest.json` 升级为 v2：

```json
{
  "version": 2,
  "exportedAt": "2026-08-07T...",
  "tags": [
    { "id": "image-to-video", "name": "图生视频", "parentId": null, "isPreset": true, "metadataDef": [] },
    { "id": "reference", "name": "全能参考", "parentId": "image-to-video", "isPreset": true, "metadataDef": [ ... ] }
  ],
  "workflows": [
    {
      "id": "...", "name": "...", "rawJson": "...", "description": "",
      "providerId": null, "createdAt": "...", "updatedAt": "...",
      "params": [ ... ], "declaredParams": [ ... ], "attachments": [ ... ],
      "tags": [
        { "tagId": "reference", "metadataValues": { "maxImageCount": 12 } }
      ]
    }
  ]
}
```

- **导出**：收集选中工作流用到的全部标签定义（去重）进顶层 `tags`（按 `parentId` 排序，父在前）；每个工作流带 `tags` 关联数组（含用户元数据原始值）
- **导入**：
  1. 处理标签定义：id 已存在 → 复用（不覆盖）；不存在 → 按导出字段创建（先父后子；`isPreset` 按导出值保留，导入的预设与迁移种子同 id 故正常复用）
  2. 创建/更新工作流后写入 `workflow_tags` 关联（含 `metadataValues`）
  3. 防御校验：若关联含子标签但缺父标签 → 自动补父标签关联（正常导出的数据不会出现，仅防御）
- **向后兼容**：v1 包（无 `tags` 字段）导入行为不变，标签忽略

## 前端

### 新增标签管理页 `TagManagementPage.vue`（`/admin/tags`）

- 从工作流列表页 app bar 进入（新增「标签管理」按钮）
- 树形展示标签（父节点可展开显示子标签）
- 新建标签弹窗：显示名 + 父标签选择（可选）+ 元数据字段编辑器（增删行：键 / 显示名 / 类型下拉 / 默认值控件——数字框 / 文本框 / 开关按类型切换）
- 编辑弹窗：预设标签只读展示（禁用编辑）；自定义标签可改 name / metadataDef
- 删除按钮：自定义标签可用；后端拒绝时展示原因（有子 / 被引用）

### 工作流详情页 `WorkflowDetailPage.vue`

- 新增「标签」卡片：父标签 chip + 其下子标签 chip 分组展示（无标签时显示"暂无标签"）
- 「编辑标签」弹窗：
  - 层级选择器：父标签 checkbox + 子标签 checkbox；**父标签未勾选时子标签禁用**（满足不变量）
  - 选中带元数据定义的标签时，显示元数据输入区（**默认收起**，可展开编辑；非必填；数字框 / 文本框 / 开关按类型渲染；清空 = 用默认值）

### 工作流列表页 `WorkflowListPage.vue`

- 列表项显示标签 chips（父标签 + 子标签分组展示）
- 每项新增「标签」编辑按钮（复用与详情页相同的编辑弹窗），编辑后刷新列表
- 顶部新增标签筛选条：按父/子分组的多选 chips；选择后以 `?tags=...` 调用列表接口（AND 语义）；可清空筛选

### 新增 API 模块与类型

- `client/src/api/tags.ts`：`listTags` / `createTag` / `updateTag` / `deleteTag` / `setWorkflowTags`
- `client/src/types/index.ts` 新增：`Tag` / `TagTreeNode` / `WorkflowTagGroup` / `TagMetadataFieldDef` / `WorkflowTagsResponse` 等；`Workflow` 增加 `tags` 字段

## 数据库迁移（版本化）

新增迁移 `v5-workflow-tags.ts`（注册到 `migrations/index.ts` 表尾）：

1. 建 `tags` 表
2. 建 `workflow_tags` 表
3. **种子预设标签**（全部 `is_preset=1`，幂等——已存在同 id 则跳过）：
   - `text-to-image` 文生图（顶层）
   - `image-edit` 图片编辑（顶层）
   - `text-to-video` 文生视频（顶层）
   - `image-to-video` 图生视频（顶层）
   - `reference` 全能参考（子，metadataDef 含 4 个 number 字段）
   - `first-frame` 首帧 / `first-last-frame` 首尾帧 / `director` 导演台 / `audio-input` 音频输入 / `audio-output` 音频输出（子）
   - `tts-voice-design` TTS 音色设计（顶层）

## 错误码（新增）

| code | 场景 |
|------|------|
| `tag_not_found` | 标签不存在 |
| `tag_conflict` | 同层级标签名重复 |
| `tag_preset_readonly` | 预设标签不可编辑 / 删除 |
| `tag_has_children` | 删除的标签存在子标签 |
| `tag_in_use` | 删除的标签被工作流引用 |
| `parent_tag_required` | 打子标签未同时包含父标签 |
| `invalid_metadata` | 元数据键不属于字段定义或值类型不匹配 |

## 服务端实现结构

新增 `packages/server/src/services/tag.service.ts`（沿用 routes → controllers → services 分层）：

- `TagService`：标签 CRUD（含预设只读、层级、重名校验）+ 标签树组装
- `WorkflowTagService`（或并入 `WorkflowService`）：工作流标签整组替换（含子必带父与元数据校验）、按工作流查询、列表筛选（AND + 父展开）、合并默认值
- `WorkflowIOService` 扩展：导出收集标签定义、导入重建标签定义与关联

## 测试策略

- `tag.service.test.ts`：CRUD、预设只读（403 分支）、同层重名、层级校验、metadataDef 校验、删除拒绝（预设/有子/被引用）
- `workflow.service`（或 controller）测试：整组替换、子必带父（`parent_tag_required`）、元数据键/类型校验、列表响应 tags 嵌套结构与双字段合并
- 筛选测试：多标签 AND、父标签向下包含（未选子 = 全部子）、父+部分子精确匹配
- `workflow-io` 测试：标签导出→导入往返（预设复用 / 自定义标签重建 / 元数据保留 / v1 包兼容）
- 迁移测试：v5 应用后 tags 表种子数据正确（幂等）

## 不在本期范围

- 更深层级（三级及以上）标签
- 标签拖拽排序 / 自定义排序
- 按标签统计工作流数量等聚合报表
- 元数据字段类型扩展（如枚举、日期等）
