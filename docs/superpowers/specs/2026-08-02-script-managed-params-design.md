# 动态构建脚本的参数配置管理设计

## 背景

当前动态构建脚本只能修改工作流节点（增删改节点、连线、参数值），**无法声明或修改字段别名与参数类型**。`workflow_params` 表中的静态配置是脚本无法触及的。这导致无法实现"根据上传图片数量动态构建工作流"这类场景：用户想上传 N 张参考图，脚本根据 N 动态创建 N 个 LoadImage 节点并连接到工作流，但媒体上传目前只按静态配置执行，脚本无法声明新的媒体别名或把字段类型改为 image。

## 目标

让动态构建脚本能够**声明当次执行的完整参数配置**（字段别名、标签、类型、默认值、媒体文件索引），从而：

1. 脚本可新增/修改/删除字段别名、修改字段类型（如 text → image）
2. 支持"动态上传多张图片，根据图片数量动态构建工作流"
3. 继承提交到 ComfyUI 前的文件自动上传功能（按脚本声明的配置上传）
4. 模拟构建时支持配置 image/video/audio 类型字段（文件选择器 + 真实上传 + 注入真实文件名）

## 关键决策（已与用户确认）

| 决策点 | 结论 |
|--------|------|
| 脚本声明参数的作用域 | **仅当次执行**，不持久化 DB |
| 多图映射模型 | **同别名多参数 + 文件索引**：脚本为每个目标节点声明一条参数（同 alias、同/不同 fileIndex），上传时按序取文件 |
| 模拟时媒体文件处理 | **真实上传**到 ComfyUI，模拟结果与真实执行完全一致（注入真实文件名） |
| 脚本 API 形态 | **声明式返回 `{ workflow, params }`**，不兼容旧脚本（用户明确"不需要考虑旧数据"） |
| params 返回语义 | **完整配置 + `ctx.baseParams` 起点**：脚本返回完整参数配置，可基于 `ctx.baseParams`（静态配置副本）增删改 |
| 动态媒体字段上传入口 | **执行对话框支持手动添加任意类型字段**（含媒体+文件选择器） |

## 方案选型

### 选定方案：声明式返回 + 完整配置（方案 B）

- 脚本 `return { workflow, params }`，`params` 是当次执行完整参数配置
- `ctx` 暴露 `baseParams`（DB 静态配置副本）供脚本作为起点
- 已排除：命令式 ctx 辅助函数 + 增量覆盖（方案 A，与声明式风格不一致且隐式）、ctx 暴露可变 paramConfig 对象（方案 C，易误用）

## 详细设计

### 1. 脚本契约（声明式）

```ts
/** 运行时参数声明（当次执行有效） */
interface RuntimeParam {
  nodeId: string;
  fieldName: string;
  alias: string | null;
  label: string | null;
  paramType: string;        // text/boolean/number/image/video/audio
  defaultValue: string | null;
  fileIndex: number;        // 媒体参数：取 files[alias][fileIndex]，默认 0
}

/** 上传文件元数据 */
interface FileMeta {
  originalname: string;
  mimetype: string;
  size: number;
}

/** 脚本返回：工作流 + 完整参数配置 */
interface BuildResult {
  workflow: ComfyWorkflow;
  params: RuntimeParam[];
}

interface BuildContext {
  workflow: ComfyWorkflow;
  params: Record<string, unknown>;      // 输入别名值（只读）
  files: Record<string, FileMeta[]>;    // 上传文件元数据（按别名）
  baseParams: RuntimeParam[];           // DB 静态配置副本（起点）
  request: BuildRequestInfo;            // 本次 HTTP 请求快照（敏感头已剥离）
  provider: BuildProviderInfo;          // 本次执行解析到的提供商快照
}

export default function build(ctx: BuildContext): BuildResult | Promise<BuildResult>;
```

- 脚本不再 `return ctx.workflow`，而是 `return { workflow, params }`（**破坏性变更**，旧脚本需迁移，用户已确认不需要考虑旧数据）
- 脚本基于 `ctx.files.ref_images.length` 等元数据决定创建多少节点、声明多少条媒体参数

### 2. 执行时序重构（核心变化）

**旧**：解析 → 上传（按静态配置）→ 构建（脚本只看 params）→ 注入
**新**：解析 → **构建（脚本声明配置）→ 上传（按脚本声明的配置）→ 注入**

```
1. 解析请求：aliasValues + uploadedFiles（fieldname=别名）
2. 动态构建：runBuildScript(script, aliasValues, workflow, baseParams, filesMeta)
   → 返回 { workflow, params: RuntimeParam[] }
3. 媒体上传：按有效 params 中媒体类型 + 有别名 + files[alias][fileIndex] 存在的项上传
   → aliasValues[alias] = 上传后的真实文件名（多文件时每个参数取对应 fileIndex）
4. applyAliases：用有效 params + 上传后 aliasValues 注入 workflow
5. 提交
```

- **无脚本时**（未启用/未保存）：走原静态流程，`params = toRuntimeParams(baseParams)`，行为不变（回归安全）

### 3. `build.worker.ts` 改动

- `workerData` 增加 `baseParams`（DB 静态配置运行时形态）与 `filesMeta`（上传文件元数据）
- `createContext` 增加 `files`、`baseParams`（只读引用）
- `run()` 中构建函数返回值校验：接受 `{ workflow, params }`；`workflow` 必须是对象，`params` 必须是数组（缺省回退 `[]`）；结构非法 → 报错
- 回传结构变为 `{ ok, workflow, params }`

### 4. `build.service.ts` 改动

- `runBuildScript(script, params, workflow, baseParams, filesMeta, timeoutMs?)`
- `BuildScriptResult` 增加 `params?: RuntimeParam[]`
- 新增 `packages/server/src/services/param.types.ts` 导出 `RuntimeParam` 与 `FileMeta`，供 executor/worker/build 三处引用（避免循环依赖）

### 5. `executor.service.ts` 改动

- `processMediaParams` 参数改为 `RuntimeParam[]`，支持 `fileIndex`：
  ```ts
  const file = fileList?.[param.fileIndex ?? 0];
  ```
- `applyAliases` / `resolveSubmittedAliasValues` 参数改为 `RuntimeParam[]`（结构兼容，仅类型名变化 + 新增 fileIndex，逻辑不变）
- 新增 `toRuntimeParams(baseParams)` 工具：DB 行 → `RuntimeParam[]`（fileIndex 默认 0）

### 6. `workflow.controller.ts` 改动

**`execute`：**
```ts
const baseParams = toRuntimeParams(workflowService.getParams(id));
let effectiveParams = baseParams;
let buildSource = wf.rawJson;
if (wf.buildScriptEnabled && wf.buildScript) {
  const buildResult = await runBuildScript(
    wf.buildScript, aliasValues, JSON.parse(wf.rawJson),
    baseParams, filesMeta,
  );
  // 失败 → failed 任务（不变）
  buildSource = JSON.stringify(buildResult.workflow);
  effectiveParams = buildResult.params ?? baseParams;
}
// 上传：用 effectiveParams（支持脚本声明的媒体参数与 fileIndex）
const uploadedAliasValues = await processMediaParams(effectiveParams, aliasValues, uploadedFiles, baseUrl);
// 注入：用 effectiveParams
const modifiedJson = applyAliases(buildSource, effectiveParams, uploadedAliasValues);
```

时序变化：媒体上传从"构建前"移到"构建后"（脚本声明了类型才能决定上传哪些文件）。脚本收到的是**未上传的原始值**（字符串/文件名引用），脚本基于 `ctx.files` 元数据而非真实上传文件名构建。

**`simulateBuild`：**
- 支持 multipart（script + params + 文件字段），接收 `baseParams` 与 `filesMeta`
- 与 execute 相同时序：构建 → 上传（按声明配置）→ 注入真实文件名
- 返回 `{ json, params }`：`json` 是最终工作流 JSON（**已注入真实文件名**，用户确认模拟与真实执行完全一致），`params` 是脚本声明的有效参数配置（供前端渲染字段）

### 7. 前端改动

**`BuildSimulateDialog.vue`（模拟构建对话框）：**
- 请求改为 multipart（script + params + 文件字段）
- 字段渲染：text/number/boolean 不变；**image/video/audio 渲染为文件选择器**（`v-file-input`，支持多选）
- 模拟接口返回 `{ json, params }`：`json` 已注入真实文件名；`params` 用于结果视图渲染（脚本声明的字段可能不在静态配置里）
- 媒体字段兜底：用户不选文件时可用 `params` 传入的字符串值（引用 ComfyUI 已有文件）

**`WorkflowListPage.vue`（执行对话框）：**
- 现有按静态 `detail.params` 渲染字段 + `executeFiles` 媒体上传
- **新增"手动添加任意类型字段"**：动态追加行 `{ key, type, value }`，type 含 text/number/boolean/image/video/audio
  - 媒体类型 → 追加文件选择器，文件名作为该字段值（真实执行时后端上传）
  - 非媒体 → 文本/开关输入，作为 aliasValues 传入
- 提交时合并静态字段 + 手动添加字段，`executeWorkflow` 已支持 multipart

**`BuildScriptEditor.vue` / 模板 / d.ts：**
- `DEFAULT_BUILD_SCRIPT_TEMPLATE` 更新为新契约：
  ```ts
  export default async function build(ctx: BuildContext): Promise<BuildResult> {
    const { workflow, params, files, baseParams, request, provider } = ctx;
    // ...
    return { workflow, params: baseParams };
  }
  ```
- `build-script-api.ts` 更新 `BuildContext`（增加 files/baseParams/request/provider）与 `BuildResult`/`RuntimeParam` 声明；动态版（node-info）同步
- `types/index.ts` 增加前端侧 `RuntimeParam` 对应类型，`SimulateResult` 扩展 `params` 字段

## 错误处理

| 环节 | 行为 |
|------|------|
| 脚本返回结构非法（无 workflow / workflow 非对象 / params 非数组） | 构建失败 → `build_script_error`，任务 `failed`（execute）/ 400（simulate） |
| 脚本声明的媒体参数 `files[alias][fileIndex]` 不存在 | 软失败：保留 aliasValues 原值（字符串引用），不报错 |
| 上传失败（ComfyUI 不可达） | 沿用 `comfyui_unreachable`，任务 `failed` |
| 无脚本 | `params = baseParams`，行为与现状一致（回归安全） |
| 旧脚本（仍 `return ctx.workflow`） | 构建失败 `build_script_error`（破坏性变更，用户已确认） |

## 测试计划

**`build.service.test.ts`（扩展）**：
- 声明式返回 `{ workflow, params }` 正常构建
- 返回结构非法（缺 workflow / params 非数组）→ `build_script_error`
- `ctx.files` / `ctx.baseParams` 传入正确
- 旧式 `return ctx.workflow` → 失败（破坏性变更锁定）

**`executor.service.test.ts`（扩展）**：
- `processMediaParams` 支持 `fileIndex`（同别名多文件，fileIndex 0/1 取不同文件）
- `applyAliases` 接受 `RuntimeParam[]`（含 fileIndex）正确注入

**`workflow.routes.test.ts`（扩展）**：
- execute 启用脚本 → 构建后上传（脚本声明媒体别名 + fileIndex，验证提交的 `comfyuiRequestBody` 含真实上传文件名——mock 上传）
- execute 脚本返回非法结构 → 任务 failed，不提交
- simulate 返回 `{ json, params }`，媒体字段注入真实文件名（multipart 上传）
- 无脚本时回归不变

**前端**：`vue-tsc --noEmit` + 手动验证（执行对话框手动添加媒体字段、模拟对话框文件选择器、结果含真实文件名）。

## 验证命令

```bash
pnpm --filter server exec tsc --noEmit
pnpm --filter server test
pnpm --filter client exec vue-tsc --noEmit
```
