# Boolean / Number 参数类型设计文档

## 概述

配置工作流字段时，支持将 `paramType` 指定为 `boolean` 或 `number`。执行替换参数时，后台按类型做转换（例如字符串 `"false"` → 布尔 `false`），再写入 ComfyUI prompt JSON。

## 背景

当前 `paramType` 仅有 `text | image | video | audio`，`applyAliases` 将请求值与 `defaultValue` 一律按字符串写入。ComfyUI 部分节点需要真正的 boolean/number，字符串会导致节点行为异常。

## 目标

| 目标 | 说明 |
|------|------|
| 扩展类型 | `paramType` 支持 `boolean`、`number` |
| 执行转换 | 注入 prompt 时按类型转换 |
| 无 alias 可用 | 仅默认值覆盖时也可设 boolean/number |
| 失败降级 | 转换失败时按**原样字符串**写入，不拒绝执行 |

## 非目标

- 不拆分 integer/float
- 不做前端专用 switch/number 控件（仍用文本输入）
- 不改 DB schema 结构（仅扩展 `param_type` 取值语义）
- 不从 rawJson 自动推断类型

## 类型枚举

| paramType | 含义 | 无 alias | 有 alias |
|-----------|------|----------|----------|
| `text` | 字符串（默认） | ✅ | ✅ |
| `boolean` | 布尔 | ✅ | ✅ |
| `number` | 数字 | ✅ | ✅ |
| `image` / `video` / `audio` | 媒体 | ❌ | ✅ |

相对「可选别名」设计的调整：无 alias 时不再强制 `text`，允许 `text | boolean | number`；媒体类型仍要求有 alias。

## 转换规则

在 `applyAliases` 写入字段前调用 `coerceParamValue(paramType, raw)`。

### boolean

| 输入 | 结果 |
|------|------|
| 已是 `boolean` | 原样 |
| 字符串（trim，大小写不敏感）`true` / `1` / `yes` / `on` | `true` |
| 字符串 `false` / `0` / `no` / `off` | `false` |
| 其它 | 原样字符串（失败降级） |

### number

| 输入 | 结果 |
|------|------|
| 已是有限 `number` | 原样 |
| 字符串可解析为有限数字 | `number` |
| `NaN` / `Infinity` / 非数字 | 原样字符串（失败降级） |

### text / media

不转换，按字符串写入。

### defaultValue

DB 仍存 TEXT；应用覆盖时同样走 `coerceParamValue`。

## 请求值类型

- JSON body 可能含 string / number / boolean
- `applyAliases` 的 `aliasValues` 放宽为 `Record<string, unknown>`（或等价），避免过早 `String()` 丢失类型
- multipart 的 `params` JSON 解析后同样处理

## 后端校验

- 无 alias 且 `paramType` 为 image/video/audio → 强制 `text` 或 400（与现有「无 alias 禁媒体」一致，实现取强制非媒体：回退 `text`）
- 无 alias 且 boolean/number/text → 允许

## 前端

- 类型下拉增加 `boolean`、`number`
- 无 alias：仅可选 `text | boolean | number`；媒体禁用
- 有 alias：全部可选
- 默认值仍用文本框

## 测试

- `"false"` + boolean → JSON 中为 `false`
- `"3.14"` + number → `3.14`
- `"abc"` + number → `"abc"`
- 无 alias + defaultValue `"true"` + boolean → `true`
- 请求 JSON 布尔 `false` → 保持 boolean
- image 无 alias 仍不允许（强制 text）

## 实现落点

| 层 | 改动 |
|----|------|
| `executor.service.ts` | `coerceParamValue` + `applyAliases` 使用转换；`aliasValues` 类型放宽 |
| `workflow.service.ts` | `resolveParamType`：无 alias 允许 boolean/number，禁媒体 |
| `WorkflowDetailPage.vue` | 类型选项与无 alias 时的禁用逻辑 |
| 测试 | executor / workflow service |
