import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rawJson: text('raw_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workflowParams = sqliteTable('workflow_params', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  fieldName: text('field_name').notNull(),
  alias: text('alias').notNull(),
  label: text('label'),
  paramType: text('param_type').notNull().default('text'),
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
  status: text('status').notNull().default('pending'),
  errorMessage: text('error_message'),
  progress: integer('progress'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
