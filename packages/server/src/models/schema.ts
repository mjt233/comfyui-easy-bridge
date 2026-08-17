import { sqliteTable, text, integer, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rawJson: text('raw_json').notNull(),
  /** 动态构建脚本源码；空串表示未配置 */
  buildScript: text('build_script').notNull().default(''),
  /** 是否启用动态构建（0/1） */
  buildScriptEnabled: integer('build_script_enabled').notNull().default(0),
  /** 动态字段静态声明（JSON 数组：{ alias, label, paramType, defaultValue }）；仅用于执行表单与 API 文档 */
  declaredParams: text('declared_params').notNull().default('[]'),
  /** 备注说明（Markdown 格式）；空串表示未填写 */
  description: text('description').notNull().default(''),
  /** 执行提供商实例 ID；null 表示使用全局默认实例 */
  providerId: text('provider_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workflowParams = sqliteTable('workflow_params', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  fieldName: text('field_name').notNull(),
  /** 对外参数别名；null 表示不暴露为可传参字段 */
  alias: text('alias'),
  label: text('label'),
  paramType: text('param_type').notNull().default('text'),
  /** 默认值覆盖；null 表示使用 rawJson 原值 */
  defaultValue: text('default_value'),
}, (table) => ({
  uniqueAliasPerWorkflow: uniqueIndex('idx_unique_alias_per_workflow').on(table.workflowId, table.alias),
}));

export const taskLogs = sqliteTable('task_logs', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  workflowName: text('workflow_name').notNull(),
  /** 实际使用的提供商实例 ID；历史任务可能为 null */
  providerId: text('provider_id'),
  /** 实际使用的提供商实例名称（冗余存储，实例改名/删除后日志仍可溯源）；历史任务可能为 null */
  providerName: text('provider_name'),
  promptId: text('prompt_id'),
  aliasValues: text('alias_values').notNull(),
  /** 用户原始请求表单 JSON（含参数与上传文件元数据）；旧任务可能为 null */
  originalForm: text('original_form'),
  comfyuiUrl: text('comfyui_url').notNull(),
  comfyuiRequestBody: text('comfyui_request_body'),
  comfyuiResponse: text('comfyui_response'),
  outputFiles: text('output_files'),
  /** 本次上传到执行端的资产文件名 JSON 数组（供终态后自动清理）；旧任务可能为 null */
  uploadedFiles: text('uploaded_files').notNull().default('[]'),
  status: text('status').notNull().default('pending'),
  errorMessage: text('error_message'),
  progress: integer('progress'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const workflowAttachments = sqliteTable('workflow_attachments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  /** 用户上传的原始文件名 */
  filename: text('filename').notNull(),
  /** 磁盘存储名（uuid + 扩展名） */
  storedName: text('stored_name').notNull(),
  /** 文件字节数 */
  size: integer('size').notNull(),
  /** MIME 类型；可空 */
  mimetype: text('mimetype'),
  createdAt: text('created_at').notNull(),
});

/** 执行提供商实例（comfyui / runninghub） */
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  /** 展示名 */
  name: text('name').notNull(),
  /** 提供商类型：comfyui | runninghub */
  type: text('type').notNull(),
  /** 类型化配置 JSON（见 services/providers/types.ts 的 ProviderConfig） */
  config: text('config').notNull(),
  /** 该实例的并发上限 */
  concurrency: integer('concurrency').notNull().default(1),
  /** 是否启用（0/1） */
  enabled: integer('enabled').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** 标签定义（父/子两级；预设标签只读） */
export const tags = sqliteTable('tags', {
  /** 标签 ID：预设为固定英文标识（如 "image-to-video"），自定义为 uuid */
  id: text('id').primaryKey(),
  /** 显示名（同层级内唯一） */
  name: text('name').notNull(),
  /** 父标签 id；null 表示顶层标签 */
  parentId: text('parent_id'),
  /** 是否预设（1=只读参考模板，0=用户自定义） */
  isPreset: integer('is_preset').notNull().default(0),
  /** 元数据字段定义 JSON：TagMetadataFieldDef[] */
  metadataDef: text('metadata_def').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 工作流 ↔ 标签 多对多关联 */
export const workflowTags = sqliteTable('workflow_tags', {
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  /** 用户为工作流配置的元数据原始值 JSON：{key: value}；未配置的键不存在 */
  metadataValues: text('metadata_values').notNull().default('{}'),
}, (table) => ({
  pk: primaryKey({ columns: [table.workflowId, table.tagId] }),
}));
