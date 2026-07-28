# 可选别名 + 默认值覆盖 设计文档

## 概述

编辑工作流节点参数时，允许**只修改默认值而不配置字段别名**，且**不修改原始 `rawJson`**。

默认值以覆盖形式单独存储；执行时按优先级注入。清空覆盖后回退到 `rawJson` 中的原始默认值。

## 背景与现状

当前 `workflow_params` 要求 `alias` 非空，前端「默认值」只读展示 `rawJson` 中的值。用户若只想改模板默认值、不暴露对外参数，必须：

1. 强行配置别名，或
2. 直接改 `rawJson`

两者都不符合「只改默认值、不改原始 JSON」的诉求。

## 目标

| 目标 | 说明 |
|------|------|
| 可选别名 | 可不填 `alias`，仅保存默认值覆盖 |
| 不改 rawJson | 覆盖值存在 `workflow_params.default_value`，永不写回 `raw_json` |
| 清空回退 | `default_value` 清空（`null`）后，执行与展示回退到 `rawJson` 原值 |
| 类型约束 | 无 `alias` 时不允许修改 `paramType`（固定为 `text`） |
| 本地库 | 不写代码级 SQLite 迁移；改 schema 声明后，直接改本地 `data/bridge.db` |

## 非目标

- 不提供自动 schema migration 代码
- 不拆分独立的 defaults 表
- 不改变对外执行 API 的请求形态（仍按 alias 传参）
- 不支持对数组连接字段（node link）做默认值覆盖（与现有一致，跳过）

## 数据模型

### `workflow_params` 变更

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK AUTOINCREMENT | 不变 |
| workflow_id | TEXT | NOT NULL, FK CASCADE | 不变 |
| node_id | TEXT | NOT NULL | 不变 |
| field_name | TEXT | NOT NULL | 不变 |
| alias | TEXT | **可空** | 对外参数名；空表示不暴露为可传参字段 |
| label | TEXT | 可空 | 不变 |
| param_type | TEXT | NOT NULL DEFAULT `'text'` | 无 alias 时必须为 `text` |
| default_value | TEXT | **可空（新增）** | 默认值覆盖；`null` 表示使用 rawJson 原值 |

### 约束

1. **非空 alias 唯一**：`UNIQUE(workflow_id, alias)` 仅对非空 alias 生效  
   - SQLite 中 `UNIQUE` 允许多个 `NULL`，因此多个无 alias 的参数行可共存
2. **同一字段一行**：建议业务层保证同一 `(workflow_id, node_id, field_name)` 最多一行（现有 UI 已按字段打开对话框，天然单行）
3. **有效配置**：至少具备 `alias`（非空）或 `default_value`（非 null）之一；否则删除该行更合理
4. **无 alias 时 paramType**：强制 `text`；请求若带非 text 类型则拒绝或忽略并置为 `text`

### 本地数据库调整（无代码迁移）

直接修改实体声明与 `CREATE TABLE` 语句；对本地已有库手动执行等价结构变更，例如：

```sql
-- 示意：重建 workflow_params 以放宽 alias 并增加 default_value
-- 实际操作时保留现有数据
CREATE TABLE workflow_params_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  alias TEXT,
  label TEXT,
  param_type TEXT NOT NULL DEFAULT 'text',
  default_value TEXT,
  UNIQUE(workflow_id, alias)
);
INSERT INTO workflow_params_new (id, workflow_id, node_id, field_name, alias, label, param_type, default_value)
SELECT id, workflow_id, node_id, field_name, alias, label, param_type, NULL FROM workflow_params;
DROP TABLE workflow_params;
ALTER TABLE workflow_params_new RENAME TO workflow_params;
```

测试用的 `:memory:` 建表语句同步更新。

## 执行语义

### 优先级（`applyAliases`）

对每个 `workflow_params` 行，目标字段非数组时：

1. **请求值优先**：`alias` 非空 **且** `alias in aliasValues` → 使用请求值  
2. **覆盖默认值**：否则若 `default_value != null` → 写入 `default_value`  
3. **原始默认值**：否则跳过，保留 `rawJson` 中的值  

`rawJson` 永不被持久化修改。

### 媒体参数

- 仅当 `alias` 非空且 `paramType` 为 image/video/audio 时参与 `processMediaParams` 与文件上传
- 无 alias 的行不参与对外传参与媒体上传

### 对外 API 文档含义

- 仅配置了非空 `alias` 的字段才是可调用参数
- 仅配置 `default_value` 的字段对调用方不可见，只影响模板执行时的默认输入

## API 变更

### `POST /api/workflows/:id/params`

请求体：

```ts
{
  nodeId: string;
  fieldName: string;
  alias?: string | null;       // 可选
  label?: string;
  paramType?: string;          // 仅 alias 非空时允许非 text
  defaultValue?: string | null;
}
```

校验：

| 条件 | 结果 |
|------|------|
| 缺少 `nodeId` / `fieldName` | `400 missing_parameter` |
| `alias` 与 `defaultValue` 皆空/null | `400 missing_parameter`（无有效配置） |
| 无 alias 且 `paramType` 非 `text` | `400` 或强制 `paramType='text'`（实现取强制 text） |
| 非空 alias 冲突 | `409 alias_conflict` |

### `PUT /api/workflows/:id/params/:paramId`

可更新：`alias`（可清空为 null）、`label`、`paramType`、`defaultValue`（可清空为 null）。

校验：

| 条件 | 结果 |
|------|------|
| 更新后既无 alias 又无 defaultValue | `400` 或自动删除该行（推荐：返回 400，由前端走删除） |
| 清空 alias 时 | `paramType` 强制回 `text` |
| 无 alias 时尝试设非 text 类型 | 拒绝或强制 text |
| 非空 alias 冲突 | `409 alias_conflict` |

### 响应字段

参数对象增加：

```ts
{
  id: number;
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string | null;
  label: string | null;
  paramType: string;
  defaultValue: string | null;
}
```

## 前端（WorkflowDetailPage）

### 对话框

| 控件 | 行为 |
|------|------|
| 字段名 | 只读 |
| 默认值 | **可编辑**；展示当前生效值（有覆盖用覆盖，否则 rawJson 原值） |
| 接口字段别名 | **可选** |
| 标签 | 可选 |
| 参数类型 | **仅当 alias 非空时可编辑**；无 alias 时禁用并固定 `text` |

### 保存逻辑

1. 计算 `defaultValue`：
   - 若输入与 rawJson 原值相同 → 存 `null`（无覆盖）
   - 若输入为空字符串且原值非空 → 视为显式覆盖为空字符串，或按产品选择；**约定：用户清空输入框表示清除覆盖（`null`），回退 rawJson**  
   - 为区分「清空覆盖」与「覆盖为空串」：提供「恢复原始默认值」动作或保存时若内容等于原值则写 `null`；用户改成其他内容（含空串）则写该内容  
   - **简化约定（采用）**：
     - 保存时若 `fieldValue === rawOriginalValue` → `defaultValue = null`
     - 否则 → `defaultValue = fieldValue`（可为空字符串）
     - UI 可加提示：「与原始值相同则不保存覆盖」
2. 无 `alias` 且 `defaultValue === null` → 若已有 paramId 则提示删除或调用删除；若无 paramId 则禁止保存
3. 有 `alias` 或有效 `defaultValue` → add/update
4. 无 alias 时 `paramType` 固定提交 `text`

### 列表/Chip 展示

- 默认值列：显示**生效值**（覆盖优先）
- 已配置高亮：存在 `paramId`（有 alias 或有 defaultValue 覆盖）
- 无 alias 但有覆盖：chip/列表仍标记为已配置，别名列可显示「仅默认值」或留空

### 删除

删除整行参数配置（别名 + 默认值覆盖一并移除）。

## 后端分层改动

| 层 | 改动 |
|----|------|
| `schema.ts` / `db.ts` | `alias` 可空；新增 `default_value` |
| `workflow.service` | add/update 支持可选 alias、defaultValue；校验规则 |
| `workflow.controller` | 请求校验放宽 alias；透传 defaultValue |
| `executor.service` | `applyAliases` 增加 defaultValue 回退逻辑；媒体处理跳过无 alias |
| 测试建表 SQL | 同步新结构 |
| 前端 types / api / DetailPage | 类型与 UI 如上 |

## 测试计划

### workflow.service

- 可添加仅 `defaultValue`、无 alias 的参数
- 可添加仅 alias、无 defaultValue 的参数
- 两者皆空应失败
- 多个 null alias 不冲突
- 非空 alias 仍唯一
- 更新 defaultValue 为 null 表示清除覆盖
- 无 alias 时 paramType 为 text

### executor.service

- 仅 defaultValue：执行 JSON 使用覆盖值
- alias + 请求值：请求值优先
- alias + 未传 + defaultValue：用 defaultValue
- alias + 未传 + 无 defaultValue：保留 rawJson
- defaultValue 为 null：保留 rawJson
- 数组连接字段仍跳过

### 路由/集成（如有）

- POST 无 alias 有 defaultValue → 201
- POST 皆空 → 400
- 别名冲突 → 409

## 实现顺序建议

1. Schema + 本地 DB 结构调整  
2. Service / Executor + 单测  
3. Controller 校验  
4. 前端 Detail 页与 types/api  
5. tsc 前后端验证 + 测试  

## 验收标准

1. 可只改某字段默认值并保存，不填别名，`raw_json` 不变  
2. 执行工作流时使用覆盖默认值  
3. 将默认值改回与原始值一致并保存后，覆盖清除，执行用 rawJson 原值  
4. 无别名时参数类型不可改为 image/video/audio  
5. 配置别名后行为与现网一致（传参覆盖、媒体上传等）  
