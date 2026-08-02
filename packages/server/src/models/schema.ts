import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rawJson: text('raw_json').notNull(),
  /** 动态构建脚本源码；空串表示未配置 */
  buildScript: text('build_script').notNull().default(''),
  /** 是否启用动态构建（0/1） */
  buildScriptEnabled: integer('build_script_enabled').notNull().default(0),
  /** 备注说明（Markdown 格式）；空串表示未填写 */
  description: text('description').notNull().default(''),
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
  promptId: text('prompt_id'),
  aliasValues: text('alias_values').notNull(),
  comfyuiUrl: text('comfyui_url').notNull(),
  comfyuiRequestBody: text('comfyui_request_body'),
  comfyuiResponse: text('comfyui_response'),
  outputFiles: text('output_files'),
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

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
