# 执行对话框：本次执行手动指定字段类型 + 媒体字段文本值设计

## 背景

在工作流列表页执行工作流时，弹出对话框按已配置参数的 `paramType` 渲染输入控件（boolean→开关、text→文本域、image/video/audio→文件上传）。存在两个使用痛点：

1. **已配置字段类型固定**：已配置参数的类型由工作流持久化配置决定，无法在本次执行时临时更改（如把 `text` 字段临时当图片上传、把 `image` 字段临时当文本传值），只能通过「自定义字段」额外新增，无法覆盖既有字段。
2. **媒体字段只能传文件**：`image/video/audio` 字段只能选择本地文件上传，无法直接输入一个字符串值（如 ComfyUI 服务端已存在的文件名），限制了引用服务端已有资产的场景。

目标：在执行对话框内为**已配置字段**提供「仅本次执行」的类型覆盖能力，并为媒体字段提供「上传文件 / 输入值」双模式，且不修改工作流持久化配置。

## 关键决策（已与用户确认）

| 决策点 | 结论 |
|--------|------|
| 实现方案 | **方案 A：后端支持本次执行类型覆盖（`paramTypeOverrides`）+ 前端类型下拉 + 媒体文本值模式** |
| 覆盖范围 | 仅作用于**已配置/声明字段**；「自定义字段」保持现状（本身就带类型选择） |
| 生效时机 | 覆盖在动态构建脚本之后应用（用户显式覆盖优先于脚本声明） |
| 持久化 | 覆盖仅本次请求有效，不写回 workflow_params 表 |
| API 格式 | JSON 保留键 `paramTypeOverrides` / multipart 表单字段 `paramTypeOverrides`（JSON 字符串） |
| 安全 | 覆盖值仅接受白名单类型 `text/boolean/number/image/video/audio`，非法值忽略 |
| 自动清理 | 修复 `collectUploadedFilenames`：仅收集**确实上传过文件**的别名，避免文本值被误加入清理名单 |

## 后端设计

### 1. `executor.service.ts`：新增 `applyParamTypeOverrides`

```ts
const VALID_PARAM_TYPES = new Set(['text', 'boolean', 'number', 'image', 'video', 'audio']);

/**
 * 应用本次执行类型覆盖（别名 → 覆盖类型），返回新数组（不可变）。
 * 仅对非空 alias 的参数生效；覆盖类型不在白名单内时忽略该覆盖。
 */
export function applyParamTypeOverrides(
  params: RuntimeParam[],
  overrides: Record<string, string>,
): RuntimeParam[]
```

覆盖后 `paramType` 被替换，下游 `processMediaParams`（是否上传/上传到哪个媒体端点）、`applyAliases`/`coerceParamValue`（类型转换）、`resolveSubmittedAliasValues`、`collectUploadedFilenames` 全部自动使用覆盖类型，无需改动核心逻辑。

### 2. `workflow.controller.ts` execute：解析并应用覆盖

- multipart：`JSON.parse(req.body.paramTypeOverrides || '{}')`
- JSON：从 `req.body` 提取保留键 `paramTypeOverrides`（对象则解析，否则忽略），其余字段仍作别名值
- 在 `effectiveParams`（动态构建后）上调用 `applyParamTypeOverrides`

### 3. 修复 `collectUploadedFilenames` 自动清理误删

新增第三参 `files: Record<string, { buffer: Buffer; originalname: string; mimetype: string }[]>`：

- 仅收集 `files[alias]` 非空（即本次确实上传了文件）的媒体别名
- 媒体字段传文本值时，字符串不会进入 `uploaded_files`，避免自动清理误删服务端已有文件
- `simulate`（simulateBuild）路径同步修复

## API 客户端（`packages/client/src/api/workflows.ts`）

`executeWorkflow` 新增可选参数：

```ts
export async function executeWorkflow(
  workflowId: string,
  aliasValues: Record<string, string | number | boolean>,
  files?: Record<string, File[]>,
  paramTypeOverrides?: Record<string, string>,
): Promise<ExecuteResult>
```

- 无覆盖时不发该字段（保持既有请求完全一致）
- JSON 模式：`{ ...aliasValues, paramTypeOverrides }`
- multipart 模式：追加表单字段 `paramTypeOverrides`（JSON 字符串）

## 前端设计（`packages/client/src/pages/WorkflowListPage.vue`）

### 数据结构

```ts
interface ExecuteField {
  alias: string;
  label: string;
  fieldName: string;
  nodeTitle: string;
  paramType: string;       // 持久化/声明类型
  dynamic?: boolean;
  /** 本次执行覆盖类型（默认 = paramType，仅本次有效） */
  overrideType: string;
  /** 媒体字段输入模式：'file' 上传文件 / 'text' 直接输入值 */
  mediaMode: 'file' | 'text';
}
```

### UI

- 每个已配置字段行新增一个**类型下拉**（6 种类型），`v-model` 绑定 `field.overrideType`，默认显示 `paramType`；改动后输入控件按 `overrideType` 渲染，关闭对话框即丢弃
- boolean → `v-switch`；text/number → 文本域；媒体 → 「上传文件 / 输入值」模式切换（`v-btn-toggle`）+ 对应控件
- 媒体「输入值」模式：`v-text-field` 绑定 `executeForm[alias]`（字符串），提交进 `aliasValues`
- 媒体「上传文件」模式：`v-file-input` 绑定 `executeFiles[alias]`

### 提交逻辑（confirmExecute）

- 对每个 `executeFields` 字段按 `overrideType` 组装：
  - boolean → `aliasValues[alias] = Boolean(executeForm[alias])`
  - number → `aliasValues[alias] = Number(...)`（空串传 `''`）
  - text → `aliasValues[alias] = String(...)`
  - 媒体 + 文件模式且有文件 → `files[alias]`
  - 媒体 + 文本模式且有值 → `aliasValues[alias] = String(...)`
  - 媒体无值 → 跳过（节点保留原值）
- 收集 `paramTypeOverrides[alias] = overrideType`（仅当与 `paramType` 不同），随请求提交
- `manualFields` 自定义字段逻辑保持不变

## 测试

### 后端

- `executor.service.test.ts`：
  - `applyParamTypeOverrides`：合法覆盖生效、非法类型忽略、无别名忽略、返回新数组不修改原参数
  - `collectUploadedFilenames`：媒体别名无文件（文本值）不收集；有文件才收集
- `workflow.routes.test.ts`：
  - JSON 模式：text 参数覆盖为 image 并传文件 → 文件被上传、文件名注入节点、上传端点用 image
  - multipart 模式：image 参数覆盖为 video 并传文件 → 上传到 video 端点
  - 覆盖仅本次生效（后续执行不受影响）

### 验证命令

```bash
pnpm --filter server exec tsc --noEmit
pnpm --filter client exec tsc --noEmit
pnpm test
```
