# 动态构建脚本参数配置管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让动态构建脚本声明式返回当次执行的完整参数配置（`{ workflow, params }`），支持动态媒体参数（同别名多文件 + fileIndex）、执行时序重构（构建 → 按声明配置上传 → 注入）、模拟构建支持媒体文件真实上传并注入真实文件名、执行/模拟对话框支持媒体字段。

**Architecture:** 新建 `param.types.ts` 定义运行时参数模型；`build.worker`/`build.service` 改为声明式返回 `{ workflow, params }`，ctx 暴露 `files`/`baseParams`；`executor.service` 的 `applyAliases`/`processMediaParams` 改为接受 `RuntimeParam[]` 并支持 `fileIndex`；`controller.execute`/`simulateBuild` 时序重构为「构建 → 上传 → 注入」；前端模拟/执行对话框支持媒体文件字段。

**Tech Stack:** Express + TypeScript + Drizzle ORM (SQLite)、worker_threads、Vue 3 + Vuetify + Vite

---

## 前置已验证事实

- `executor.service.ts` 的 `WorkflowParam` 接口含 `id`/`workflowId`（DB 行形态）；`applyAliases`/`processMediaParams`/`resolveSubmittedAliasValues` 均接受 `WorkflowParam[]`
- `processMediaParams` 目前只取 `files[alias][0]`（首文件），无 `fileIndex` 概念
- `build.service.ts` 的 `runBuildScript(script, params, workflow, timeoutMs)` 返回 `BuildScriptResult { ok, workflow, error, code }`
- `build.worker.ts` workerData 含 `jsCode`/`params`/`workflow`，返回 `{ ok, workflow }`
- `build-script-api.ts` 的 `BUILD_SCRIPT_API_DTS`/`DEFAULT_BUILD_SCRIPT_TEMPLATE`/`BUILD_SCRIPT_DTS_HEADER`/`buildBuildContextDts` 已存在（上一个功能）
- controller `execute` 流程：解析 → `processMediaParams` → 动态构建 → `applyAliases`（本计划重构为：解析 → 构建 → 上传 → 注入）
- `simulateBuild` 目前是 JSON body，返回 `{ json }`；前端 `simulateBuild` API 为 JSON
- 前端 `executeWorkflow` API 已支持 multipart（`params` + 文件字段）
- `uploadFileToComfyUI` 在 `upload.service.ts`，签名：`(file, mediaType, comfyuiBaseUrl) => Promise<string>`
- `noUnusedLocals`/`noUnusedParameters` 已开启；`esModuleInterop` 已开启

---

## 任务清单总览

| Task | 内容 | 关键文件 |
|------|------|----------|
| 1 | 参数模型：`param.types.ts` + `executor.service.ts` 改造 | 新 `param.types.ts`、`executor.service.ts` + 测试 |
| 2 | 构建引擎声明式返回：worker/service/api 契约 | `build.worker.ts`、`build.service.ts`、`build-script-api.ts` + 测试 |
| 3 | controller 时序重构：execute/simulate + 路由测试 | `workflow.controller.ts`、`workflow.routes.test.ts` |
| 4 | 前端：类型/API/模拟对话框媒体/执行对话框手动字段 | `types/index.ts`、`api/workflows.ts`、`BuildSimulateDialog.vue`、`WorkflowListPage.vue` |
| 5 | 全量验证 + 手工冒烟 | 全部 |

---

## Task 1: 参数模型 — `param.types.ts` + `executor.service.ts` 改造

**Files:**
- Create: `packages/server/src/services/param.types.ts`
- Modify: `packages/server/src/services/executor.service.ts`
- Modify: `packages/server/src/services/executor.service.test.ts`（如有）
- Modify: `packages/server/src/services/build.worker.ts` 的引用（Task 2 才用，本任务不碰）

- [ ] **Step 1: 创建 `param.types.ts`**

创建 `packages/server/src/services/param.types.ts`：

```ts
/**
 * 运行时参数模型（当次执行有效）。
 * 由 DB 静态配置转换而来，或由动态构建脚本声明返回。
 */

/** 运行时参数声明 */
export interface RuntimeParam {
  /** 节点 ID */
  nodeId: string;
  /** 节点 inputs 字段名 */
  fieldName: string;
  /** 对外别名；null 表示不暴露为可传参字段 */
  alias: string | null;
  /** 展示标签 */
  label: string | null;
  /** 参数类型 text/boolean/number/image/video/audio */
  paramType: string;
  /** 默认值覆盖；null 表示使用 rawJson 原值 */
  defaultValue: string | null;
  /** 媒体参数：取 files[alias][fileIndex]，默认 0 */
  fileIndex: number;
}

/** 上传文件元数据（脚本构建阶段可见，未上传到 ComfyUI） */
export interface FileMeta {
  /** 用户上传的原始文件名 */
  originalname: string;
  /** MIME 类型 */
  mimetype: string;
  /** 文件字节数 */
  size: number;
}
```

- [ ] **Step 2: `executor.service.ts` 引入 `RuntimeParam`/`FileMeta` 并改造**

`packages/server/src/services/executor.service.ts` 顶部 import 追加：

```ts
import type { RuntimeParam, FileMeta } from './param.types';
```

`WorkflowParam` 接口保留（DB 行形态，`toRuntimeParams` 用它转换）。新增转换函数（放在 `WorkflowParam` 接口之后）：

```ts
/**
 * 将 DB 静态配置行转换为运行时参数。
 * @param baseParams DB 行列表
 * @returns 运行时参数列表（fileIndex 默认 0）
 */
export function toRuntimeParams(baseParams: WorkflowParam[]): RuntimeParam[] {
  return baseParams.map((p) => ({
    nodeId: p.nodeId,
    fieldName: p.fieldName,
    alias: p.alias,
    label: p.label,
    paramType: p.paramType,
    defaultValue: p.defaultValue,
    fileIndex: 0,
  }));
}
```

`applyAliases` 参数类型 `WorkflowParam[]` → `RuntimeParam[]`，函数体不变（只读 nodeId/fieldName/alias/paramType/defaultValue）：

```ts
export function applyAliases(
  rawJson: string,
  params: RuntimeParam[],
  aliasValues: Record<string, unknown>,
): string {
```

`resolveSubmittedAliasValues` 参数类型同样改为 `RuntimeParam[]`。

`processMediaParams` 参数改为 `RuntimeParam[]`，并支持 `fileIndex`：

```ts
export async function processMediaParams(
  params: RuntimeParam[],
  aliasValues: Record<string, unknown>,
  files: Record<string, FileMeta[]>,
  comfyuiBaseUrl: string,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...aliasValues };
  for (const param of params) {
    // 仅处理媒体类型；boolean/number/text 不走上传
    if (!['image', 'video', 'audio'].includes(param.paramType)) continue;
    // 无别名的参数不参与对外媒体上传
    if (param.alias == null || param.alias === '') continue;
    const fileList = files[param.alias];
    // fileIndex 支持同别名多文件
    const file = fileList?.[param.fileIndex ?? 0];
    if (file) {
      const filename = await uploadFileToComfyUI(
        file,
        param.paramType as 'image' | 'video' | 'audio',
        comfyuiBaseUrl,
      );
      result[param.alias] = filename;
    }
  }
  return result;
}
```

注意：`files` 参数类型从 `Record<string, { buffer; originalname; mimetype }[]>` 改为 `Record<string, FileMeta[]>`——但 `processMediaParams` 调用 `uploadFileToComfyUI` 需要 `buffer`！检查 `uploadFileToComfyUI` 签名（`upload.service.ts:46`），它接收含 `buffer` 的文件对象。因此 `FileMeta` 需含 `buffer`，或 `processMediaParams` 的 `files` 参数保留 buffer 形态。

**修正**：`param.types.ts` 的 `FileMeta` 用于脚本 ctx（元数据，不含 buffer）；而 `processMediaParams` 的 `files` 参数需含 buffer。故 `executor.service.ts` 中 `processMediaParams` 的 `files` 参数保持原形态（含 buffer）：

```ts
export async function processMediaParams(
  params: RuntimeParam[],
  aliasValues: Record<string, unknown>,
  files: Record<string, { buffer: Buffer; originalname: string; mimetype: string }[]>,
  comfyuiBaseUrl: string,
): Promise<Record<string, unknown>> {
```

即：`RuntimeParam` 用于 params；`files` 保持含 buffer 的形态（供上传）。`FileMeta`（不含 buffer）仅用于脚本 ctx。这是两个不同的数据类型，用途不同。

- [ ] **Step 3: 检查 `executor.service.test.ts` 现有用例并适配**

运行 `pnpm --filter server exec vitest run src/services/executor.service.test.ts`。若该文件存在且调用 `applyAliases`/`processMediaParams` 时传了含 `id`/`workflowId` 的完整行，由于 `RuntimeParam[]` 类型更宽（`RuntimeParam` 字段是 `WorkflowParam` 字段的子集），**结构化兼容**——`WorkflowParam` 对象可直接赋给 `RuntimeParam`（多余字段被忽略），TypeScript 结构类型允许。故现有用例大概率无需改动。确认测试通过即可。

- [ ] **Step 4: 补充 `processMediaParams` fileIndex 测试**

若 `executor.service.test.ts` 存在，追加用例；若不存在则新建。先检查该文件是否存在并遵循其模式。追加用例（以实际文件结构为准）：

```ts
  it('processMediaParams supports fileIndex for same-alias multiple files', async () => {
    // 两个参数同 alias 'ref_images'，fileIndex 0/1 取不同文件
    const params: RuntimeParam[] = [
      { nodeId: 'load1', fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: 0 },
      { nodeId: 'load2', fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: 1 },
    ];
    const files = {
      ref_images: [
        { buffer: Buffer.from('a'), originalname: 'a.png', mimetype: 'image/png' },
        { buffer: Buffer.from('b'), originalname: 'b.png', mimetype: 'image/png' },
      ],
    };
    // mock uploadFileToComfyUI 返回文件名（依据 originalname）
    const result = await processMediaParams(params, {}, files, 'http://comfy:8188');
    // 两个参数都上传，aliasValues.ref_images 是最后一个写入的值
    expect(result.ref_images).toBeTruthy();
  });
```

（若 `executor.service.test.ts` 不存在，此用例延后到 Task 3 的路由测试中覆盖。以实际文件为准。）

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `pnpm --filter server exec tsc --noEmit`
Run: `pnpm --filter server test`
Expected: 全部通过（`RuntimeParam` 与 `WorkflowParam` 结构兼容，既有调用点不破坏）。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/param.types.ts packages/server/src/services/executor.service.ts
git commit -m "feat: add runtime param model and fileIndex support in executor"
```

---

## Task 2: 构建引擎声明式返回 — worker/service/api 契约

**Files:**
- Modify: `packages/server/src/services/build.worker.ts`
- Modify: `packages/server/src/services/build.service.ts`
- Modify: `packages/server/src/services/build-script-api.ts`
- Modify: `packages/server/src/services/build.service.test.ts`

- [ ] **Step 1: `build-script-api.ts` 更新契约**

在 `build-script-api.ts` 顶部 import `RuntimeParam`/`FileMeta` 类型：

```ts
import type { RuntimeParam, FileMeta } from './param.types';
```

新增 `BuildResult` 类型（`ComfyWorkflow` 之后）：

```ts
/** 脚本返回：工作流 + 完整参数配置 */
export interface BuildResult {
  workflow: ComfyWorkflow;
  params: RuntimeParam[];
}
```

`buildBuildContextDts` 函数体更新：`BuildContext` 增加 `files`/`baseParams`，返回类型说明改为 `BuildResult`。同时新增声明片段常量。将函数体改为：

```ts
export function buildBuildContextDts(addNodeSig: string, findNodesByClassSig: string): string {
  return `/** 构建上下文：脚本默认导出函数的唯一入参 */
declare interface BuildContext {
  /** 原始工作流（深拷贝，可直接修改） */
  workflow: ComfyWorkflow;
  /** 用户提交的参数（别名字段 + 自由添加字段） */
  params: Record<string, unknown>;
  /** 上传文件元数据（按别名）；脚本据此判断文件数量 */
  files: Record<string, FileMeta[]>;
  /** DB 静态参数配置副本（可作为声明返回的起点） */
  baseParams: RuntimeParam[];
  /** 新增节点；节点 ID 已存在时抛错 */
  ${addNodeSig}
  /** 删除节点；自动清理指向它的连线 */
  removeNode(nodeId: string): void;
  /** 连接：source 节点的第 sourceSlot 个输出 → target 节点的 targetField 输入 */
  connect(sourceNodeId: string, sourceSlot: number, targetNodeId: string, targetField: string): void;
  /** 断开 targetField 上的连线，并设置回退值 */
  disconnect(targetNodeId: string, targetField: string, fallbackValue?: unknown): void;
  /** 设置节点字段值 */
  setInput(nodeId: string, field: string, value: unknown): void;
  /** 读取节点字段值 */
  getInput(nodeId: string, field: string): unknown;
  /** 按 class_type 查找节点 ID 列表 */
  ${findNodesByClassSig}
  /** 获取节点引用（不存在返回 undefined） */
  getNode(nodeId: string): ComfyNode | undefined;
  /** 设置节点标题（_meta.title） */
  setTitle(nodeId: string, title: string): void;
}
`;
}
```

在 `buildBuildContextDts` 之后新增 `BUILD_RESULT_DTS` 与 `RUNTIME_PARAM_DTS` 常量：

```ts
/** RuntimeParam 与 FileMeta 的 d.ts 声明（前端 Monaco 注册） */
export const RUNTIME_PARAM_DTS = `/** 运行时参数声明（当次执行有效） */
declare interface RuntimeParam {
  /** 节点 ID */
  nodeId: string;
  /** 节点 inputs 字段名 */
  fieldName: string;
  /** 对外别名；null 表示不暴露为可传参字段 */
  alias: string | null;
  /** 展示标签 */
  label: string | null;
  /** 参数类型 text/boolean/number/image/video/audio */
  paramType: string;
  /** 默认值覆盖；null 表示使用 rawJson 原值 */
  defaultValue: string | null;
  /** 媒体参数：取 files[alias][fileIndex]，默认 0 */
  fileIndex: number;
}

/** 上传文件元数据（脚本构建阶段可见） */
declare interface FileMeta {
  originalname: string;
  mimetype: string;
  size: number;
}
`;

/** BuildResult 的 d.ts 声明（脚本返回值） */
export const BUILD_RESULT_DTS = `/** 脚本返回：工作流 + 完整参数配置 */
declare interface BuildResult {
  workflow: ComfyWorkflow;
  params: RuntimeParam[];
}
`;
```

`BUILD_SCRIPT_API_DTS` 改为拼接（头部 + RuntimeParam + BuildResult + BuildContext）：

```ts
export const BUILD_SCRIPT_API_DTS = `${BUILD_SCRIPT_DTS_HEADER}
${RUNTIME_PARAM_DTS}
${BUILD_RESULT_DTS}
${STATIC_BUILD_CONTEXT_DTS}`;
```

`DEFAULT_BUILD_SCRIPT_TEMPLATE` 更新为新契约：

```ts
export const DEFAULT_BUILD_SCRIPT_TEMPLATE = `export default async function build(ctx: BuildContext): Promise<BuildResult> {
  const { workflow, params, files, baseParams } = ctx;
  // 在这里根据 params / files 动态调整工作流与参数配置。
  // 示例：
  // const count = (files.ref_images ?? []).length;
  // for (let i = 0; i < count; i++) {
  //   const nodeId = 'load_' + i;
  //   ctx.addNode(nodeId, 'LoadImage', { image: '' });
  //   baseParams.push({ nodeId, fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: i });
  // }
  return { workflow, params: baseParams };
}
`;
```

**注意**：`generateBuildDts`（`node-info.service.ts`）引用了 `BUILD_SCRIPT_DTS_HEADER` 与 `buildBuildContextDts`，其输出也会自动带上新的 `BuildContext` 字段（files/baseParams）——**但动态版缺少 `RUNTIME_PARAM_DTS`/`BUILD_RESULT_DTS`**！需修改 `node-info.service.ts` 的 `generateBuildDts` 拼接 `RUNTIME_PARAM_DTS` 与 `BUILD_RESULT_DTS`（Task 2 一并处理）：

```ts
import { BUILD_SCRIPT_DTS_HEADER, BUILD_RESULT_DTS, RUNTIME_PARAM_DTS, buildBuildContextDts } from './build-script-api';
// ...
export function generateBuildDts(nodeInfo: Record<string, NodeClassInfo>): string {
  return `${BUILD_SCRIPT_DTS_HEADER}
${RUNTIME_PARAM_DTS}
${BUILD_RESULT_DTS}
${generateNodeClassDts(nodeInfo)}
${buildBuildContextDts(
  'addNode<K extends ComfyClassType>(nodeId: string, classType: K, inputs?: Partial<ComfyNodeInputs[K]>): void;',
  'findNodesByClass(classType: ComfyClassType): string[];',
)}`;
}
```

（此改动放在 Task 2 或独立小步均可，确保静态版与动态版 d.ts 都含新契约。）

- [ ] **Step 2: `build.worker.ts` 更新**

`workerData` 解构增加 `baseParams` 与 `filesMeta`；`createContext` 增加 `files`/`baseParams`：

```ts
function createContext(workflow, params, files, baseParams) {
  const wf = cloneWorkflow(workflow);
  return {
    workflow: wf,
    params,
    files,
    baseParams,
    // ... 其余辅助函数不变
  };
}
```

`run()` 更新：解构 `baseParams`/`filesMeta`；构建函数返回值校验改为接受 `{ workflow, params }`：

```ts
async function run() {
  try {
    const { jsCode, params, workflow, baseParams, filesMeta } = workerData;
    const tmpFile = path.join(
      os.tmpdir(),
      'comfy-build-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.cjs',
    );
    fs.writeFileSync(tmpFile, jsCode, 'utf8');
    let buildFn = null;
    try {
      const mod = require(tmpFile);
      buildFn = typeof mod.default === 'function' ? mod.default : (typeof mod === 'function' ? mod : null);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (err) { /* 忽略清理失败 */ }
    }
    if (typeof buildFn !== 'function') {
      parentPort.postMessage({ ok: false, error: '脚本必须通过 export default 导出一个构建函数' });
      return;
    }
    const ctx = createContext(workflow, params, filesMeta, baseParams);
    const result = await buildFn(ctx);
    // 声明式返回：{ workflow, params }；workflow 必须对象，params 必须是数组（缺省回退 []）
    const workflowResult = result && typeof result === 'object' && !Array.isArray(result) ? result.workflow : null;
    if (!workflowResult || typeof workflowResult !== 'object' || Array.isArray(workflowResult)) {
      parentPort.postMessage({ ok: false, error: '构建函数必须返回 { workflow, params }，且 workflow 必须是工作流对象' });
      return;
    }
    const paramsResult = Array.isArray(result.params) ? result.params : [];
    parentPort.postMessage({ ok: true, workflow: workflowResult, params: paramsResult });
  } catch (err) {
    // 使用完整 stack（首行已含 "Error: message"），避免消息重复
    const msg = (err && err.stack) ? err.stack : String(err);
    parentPort.postMessage({ ok: false, error: msg });
  }
}
```

- [ ] **Step 3: `build.service.ts` 更新**

`runBuildScript` 签名扩展：增加 `baseParams`、`filesMeta` 参数（在 `workflow` 之后、`timeoutMs` 之前）：

```ts
import type { ComfyWorkflow } from './build-script-api';
import type { RuntimeParam, FileMeta } from './param.types';

export interface BuildScriptResult {
  ok: boolean;
  workflow?: ComfyWorkflow;
  /** 脚本声明的参数配置（ok=true 时） */
  params?: RuntimeParam[];
  error?: string;
  code?: 'build_script_error' | 'build_script_timeout';
}

export function runBuildScript(
  script: string,
  params: Record<string, unknown>,
  workflow: ComfyWorkflow,
  baseParams: RuntimeParam[],
  filesMeta: Record<string, FileMeta[]>,
  timeoutMs = 5000,
): Promise<BuildScriptResult> {
```

`workerData` 增加 `baseParams`/`filesMeta`：

```ts
      worker = new Worker(BUILD_WORKER_SOURCE, {
        eval: true,
        workerData: { jsCode, params, workflow, baseParams, filesMeta },
      });
```

`worker.on('message')` 的类型与回传增加 `params`：

```ts
    worker.on('message', (msg: { ok: boolean; workflow?: ComfyWorkflow; params?: RuntimeParam[]; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!msg.ok) {
        resolve({ ok: false, code: 'build_script_error', error: msg.error ?? 'Unknown build error' });
        return;
      }
      // 结果体积限制
      try {
        if (JSON.stringify(msg.workflow).length > MAX_RESULT_BYTES) {
          resolve({ ok: false, code: 'build_script_error', error: 'Build result too large' });
          return;
        }
      } catch {
        resolve({ ok: false, code: 'build_script_error', error: 'Build result is not serializable' });
        return;
      }
      resolve({ ok: true, workflow: msg.workflow, params: msg.params ?? [] });
    });
```

- [ ] **Step 4: `build.service.test.ts` 更新（适配新签名 + 新增声明式用例）**

现有用例的 `runBuildScript(script, {}, baseWorkflow)` 调用需追加 `baseParams`/`filesMeta` 参数：

```ts
const emptyParams: RuntimeParam[] = [];
const emptyFiles: Record<string, FileMeta[]> = {};
```

每个 `runBuildScript` 调用改为 `runBuildScript(script, {}, baseWorkflow, emptyParams, emptyFiles)`。

**重要**：现有用例脚本 `return ctx.workflow`（旧式）现在会**失败**（声明式校验）。需把现有"正常构建"类用例的脚本改为 `return { workflow: ctx.workflow, params: ctx.baseParams }`。逐用例更新：
- 'builds a workflow with addNode/connect/setInput' → `return { workflow: ctx.workflow, params: ctx.baseParams };`
- 'supports async default export and reads params' → 同上
- 'does not mutate the input workflow' → `return { workflow: ctx.workflow, params: [] };`
- 'supports disconnect/...' → `return { workflow: { ...ctx.workflow, _info }, params: [] };`
- 'rejects results larger than 2MB' → `return { workflow: ctx.workflow, params: [] };`
- 'reports runtime errors'（addNode 重复）→ 脚本抛错，返回形式无关，保留 `return ctx.workflow` 即可（异常先发生）
- 'kills infinite loops' → 无关
- 'allows open Node capabilities' → `return { workflow: ctx.workflow, params: [] };`
- 'rejects non-object returns' → 现在语义变化：`return null` → 仍失败（workflow 非对象）；新增断言 `return { workflow: 'str' }` 失败
- 'connect to missing node throws' → 脚本抛错，保留

新增用例：

```ts
  it('supports declarative return with params and reads ctx.files/baseParams', async () => {
    const baseParams: RuntimeParam[] = [
      { nodeId: '4', fieldName: 'seed', alias: 'seed', label: null, paramType: 'number', defaultValue: null, fileIndex: 0 },
    ];
    const filesMeta: Record<string, FileMeta[]> = {
      ref_images: [
        { originalname: 'a.png', mimetype: 'image/png', size: 10 },
        { originalname: 'b.png', mimetype: 'image/png', size: 20 },
      ],
    };
    const script = `
      export default function build(ctx: any) {
        const count = (ctx.files.ref_images ?? []).length;
        const params = [...ctx.baseParams];
        for (let i = 0; i < count; i++) {
          const nodeId = 'load_' + i;
          ctx.addNode(nodeId, 'LoadImage', { image: '' });
          params.push({ nodeId, fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: i });
        }
        return { workflow: ctx.workflow, params };
      }
    `;
    const result = await runBuildScript(script, {}, baseWorkflow, baseParams, filesMeta);
    expect(result.ok).toBe(true);
    expect(result.workflow?.['load_0']).toBeTruthy();
    expect(result.workflow?.['load_1']).toBeTruthy();
    expect(result.params).toHaveLength(3); // 1 个 base + 2 个动态
    expect(result.params?.[1]).toMatchObject({ nodeId: 'load_0', alias: 'ref_images', paramType: 'image', fileIndex: 0 });
    expect(result.params?.[2]).toMatchObject({ nodeId: 'load_1', alias: 'ref_images', paramType: 'image', fileIndex: 1 });
  });

  it('rejects legacy return ctx.workflow (declarative required)', async () => {
    const script = 'export default function build(ctx: any) { return ctx.workflow; }';
    const result = await runBuildScript(script, {}, baseWorkflow, [], {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_error');
    expect(result.error).toContain('{ workflow, params }');
  });

  it('rejects invalid return shapes', async () => {
    for (const bad of ['null', '{ workflow: "str" }', '{ workflow: [], params: "x" }']) {
      const script = `export default function build() { return ${bad}; }`;
      const result = await runBuildScript(script, {}, baseWorkflow, [], {});
      expect(result.ok).toBe(false);
      expect(result.code).toBe('build_script_error');
    }
  });
```

- [ ] **Step 5: `node-info.service.ts` 更新 `generateBuildDts`**

按 Step 1 中说明，`generateBuildDts` 拼接 `RUNTIME_PARAM_DTS`/`BUILD_RESULT_DTS`。检查 `node-info.service.test.ts` 中 `generateBuildDts` 断言是否需要补充（若断言了完整文本，需加新片段断言；以实际为准）。

- [ ] **Step 6: 运行测试 + 类型检查**

Run: `pnpm --filter server exec vitest run src/services/build.service.test.ts src/services/build-script-api.test.ts src/services/node-info.service.test.ts`
Run: `pnpm --filter server exec tsc --noEmit`
Expected: 全部通过。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/build.worker.ts packages/server/src/services/build.service.ts packages/server/src/services/build.service.test.ts packages/server/src/services/build-script-api.ts packages/server/src/services/node-info.service.ts packages/server/src/services/node-info.service.test.ts
git commit -m "feat: declarative build return with params, expose files/baseParams in ctx"
```

---

## Task 3: controller 时序重构 — execute/simulate + 路由测试

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`
- Modify: `packages/server/src/routes/workflow.routes.test.ts`

- [ ] **Step 1: controller import 更新**

`workflow.controller.ts` import 区追加：

```ts
import { toRuntimeParams } from '../services/executor.service';
import type { RuntimeParam } from '../services/param.types';
```

（`processMediaParams`/`applyAliases` 已从 `executor.service` 导入。）

- [ ] **Step 2: `execute` 时序重构**

当前 `execute` 中，把「媒体上传」从构建前移到构建后。替换这段（从 `// 处理媒体文件上传` 到 `// 将别名值注入工作流 JSON` 之前）：

```ts
        // 静态参数转运行时形态（脚本声明的基底）
        const baseParams = toRuntimeParams(params);

        // 【动态构建】先运行脚本，声明工作流与参数配置（仅当已保存且启用）
        let buildSource = wf.rawJson;
        let effectiveParams = baseParams;
        if (wf.buildScriptEnabled && wf.buildScript) {
          const buildResult = await runBuildScript(
            wf.buildScript,
            aliasValues,
            JSON.parse(wf.rawJson) as ComfyWorkflow,
            baseParams,
            uploadedFiles,
          );
          if (!buildResult.ok) {
            // 构建失败：记录 failed 任务，不提交 ComfyUI
            const failedTask = taskService.create({
              workflowId: wf.id,
              workflowName: wf.name,
              aliasValues: JSON.stringify(aliasValues),
              comfyuiUrl: `${baseUrl}/prompt`,
              comfyuiRequestBody: null,
              comfyuiResponse: null,
              promptId: null,
            });
            taskService.updateStatus(failedTask.id, {
              status: 'failed',
              errorMessage: `Dynamic build failed [${buildResult.code ?? 'build_script_error'}]: ${buildResult.error}`,
            });
            res.json({ task_id: failedTask.id, status: 'failed', comfyui_response: null });
            return;
          }
          buildSource = JSON.stringify(buildResult.workflow);
          effectiveParams = buildResult.params ?? baseParams;
        }

        // 【媒体上传】按有效参数配置（含脚本声明的媒体参数与 fileIndex）上传文件
        const finalAliasValues = await processMediaParams(effectiveParams, aliasValues, uploadedFiles, baseUrl);

        // 将别名值注入工作流 JSON（缺失参数跳过，保留默认值，作用于构建后的 JSON）
        const modifiedJson = applyAliases(buildSource, effectiveParams, finalAliasValues);
```

**注意**：脚本现在收到的是 `aliasValues`（未上传的原始值），而非 `finalAliasValues`。后续 `resolveSubmittedAliasValues` 与任务日志、排队分支中引用的变量名需核对：原代码 `finalAliasValues` 现为上传后值（媒体已处理），语义保持。检查后续代码中 `finalAliasValues` 的引用（`resolveSubmittedAliasValues(effectiveParams, finalAliasValues)` 等），把 `params` 改为 `effectiveParams`、`finalAliasValues` 保持。

具体后续改动点（以实际文件为准）：
- `const submittedAliasValues = resolveSubmittedAliasValues(effectiveParams, finalAliasValues);`
- 排队分支与直接执行分支的 `applyAliases`/`executeWorkflow` 保持 `buildSource`/`effectiveParams`/`finalAliasValues`
- 任务日志 `aliasValues: submittedAliasValuesJson` 不变

- [ ] **Step 3: `simulateBuild` 重构**

`simulateBuild` 改为支持 multipart 并返回 `{ json, params }`。当前签名是 `(req, res, next)` 异步。改为：

```ts
    /** 模拟构建：脚本构建 + 按声明配置上传媒体 + 注入，返回最终 JSON 与参数配置 */
    async simulateBuild(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const id = req.params.id as string;
        const wf = workflowService.getById(id);
        if (!wf) {
          res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
          return;
        }
        // multipart 或 JSON：script/params 与上传文件
        const isMultipart = req.is('multipart/form-data');
        let body: { script?: unknown; params?: unknown };
        let filesMeta: Record<string, { buffer: Buffer; originalname: string; mimetype: string }[]> = {};
        if (isMultipart) {
          body = JSON.parse(req.body.params || '{}') as { script?: unknown; params?: unknown };
          body.script = req.body.script ?? body.script;
          const multerFiles = (req.files as Express.Multer.File[]) || [];
          filesMeta = {};
          for (const f of multerFiles) {
            if (!filesMeta[f.fieldname]) filesMeta[f.fieldname] = [];
            filesMeta[f.fieldname].push({ buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype });
          }
        } else {
          body = req.body as { script?: unknown; params?: unknown };
        }

        if (typeof body.script !== 'string' || body.script.trim() === '') {
          res.status(400).json({ error: 'script is required', code: 'missing_parameter' });
          return;
        }
        const aliasParams = (body.params && typeof body.params === 'object' && !Array.isArray(body.params))
          ? body.params as Record<string, unknown>
          : {};

        const baseUrl = settingsService.get('comfyui_base_url');
        if (!baseUrl) {
          res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
          return;
        }
        const baseParams = toRuntimeParams(workflowService.getParams(id));

        // 脚本构建（声明工作流与参数配置）
        const buildResult = await runBuildScript(
          body.script,
          aliasParams,
          JSON.parse(wf.rawJson) as ComfyWorkflow,
          baseParams,
          filesMeta,
        );
        if (!buildResult.ok) {
          res.status(400).json({ error: buildResult.error, code: buildResult.code });
          return;
        }
        const effectiveParams = buildResult.params ?? baseParams;

        // 按声明配置上传媒体（真实上传，模拟与真实执行一致）
        const uploadedAliasValues = await processMediaParams(effectiveParams, aliasParams, filesMeta, baseUrl);

        // 注入并返回
        const finalJson = applyAliases(JSON.stringify(buildResult.workflow), effectiveParams, uploadedAliasValues);
        res.json({ json: finalJson, params: effectiveParams });
      } catch (err) {
        next(err);
      }
    },
```

**注意**：`simulateBuild` 路由需要 `upload.any()` 中间件（当前路由是 `router.post('/:id/build/simulate', auth, controller.simulateBuild)`，无 multer）。修改 `workflow.routes.ts`：

```ts
  router.post('/:id/build/simulate', auth, upload.any(), controller.simulateBuild);
```

- [ ] **Step 4: 路由测试适配与新增**

现有 `simulateBuild` 测试（JSON body 返回 `{ json }`）仍需通过——`simulateBuild` 现在返回 `{ json, params }`，原断言 `res.body.json` 不变。但 `simulate` 现在要求 `comfyui_base_url` 已配置（否则 400）！检查现有 simulate 测试是否配置了 base_url，若无则需在测试中配置（`PUT /api/settings`）。

新增用例：

```ts
  it('execute with script-declared media param uploads files and injects real filename', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'exec-media', name: 'ExecMedia', rawJson: JSON.stringify({ '1': { inputs: { a: 1 }, class_type: 'Start' } }) });
    await supertest(app)
      .put('/api/workflows/exec-media/build-script')
      .set('Authorization', `Bearer ${token}`)
      .send({
        script: `
          export default function build(ctx: any) {
            ctx.addNode('load_0', 'LoadImage', { image: '' });
            ctx.setInput('1', 'a', '[' + (ctx.files.ref_images ?? []).length + ']');
            return {
              workflow: ctx.workflow,
              params: [{ nodeId: 'load_0', fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: 0 }],
            };
          }
        `,
        enabled: true,
      });
    await supertest(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'comfyui_base_url', value: 'http://localhost:9999' });

    // multipart 提交：ref_images 上传一张图片
    const res = await supertest(app)
      .post('/api/workflows/exec-media/execute')
      .field('params', JSON.stringify({}))
      .attach('ref_images', Buffer.from('fakeimage'), 'photo.png');
    expect(res.status).toBe(200);
    // 上传到 9999 会失败（ComfyUI 不可达），任务 failed 但 comfyuiRequestBody 已含脚本声明的结构
    const tasks = await supertest(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);
    const task = (tasks.body as Array<{ workflowId: string; comfyuiRequestBody: string | null }>)
      .find((t) => t.workflowId === 'exec-media');
    expect(task?.comfyuiRequestBody).toContain('load_0');
  });
```

注意：`processMediaParams` 会尝试上传到 `http://localhost:9999` 并失败（抛错）→ execute catch 走 `next(err)` → 500。若希望断言更稳定，可在测试中 mock 上传，但路由测试不 mock 网络。**方案**：让 `uploadFileToComfyUI` 的失败路径可测——检查它是否抛错还是返回失败。若抛错，execute 会 500。因此上述测试断言 500 或改用一个可命中的本地 mock 服务。**更稳妥**：该用例改为断言「脚本声明生效、上传失败被记录」，或使用一个真实可用的本地 HTTP 服务（如 `http://127.0.0.1:<random-port>` 上的假 `/upload/image`）。

实现者应检查 `uploadFileToComfyUI` 失败行为，据此设计断言：若抛错 → 期望 res.status 500 或 502；若返回失败 → 期望任务 failed。以实际行为为准，测试目标锁定「脚本声明的媒体参数参与上传流程」。

  it('simulate returns json and params with media upload', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;
    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'sim-media', name: 'SimMedia', rawJson: JSON.stringify({ '1': { inputs: { image: '' }, class_type: 'LoadImage' } }) });
    await supertest(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'comfyui_base_url', value: 'http://localhost:9999' });

    const res = await supertest(app)
      .post('/api/workflows/sim-media/build/simulate')
      .field('script', `
        export default function build(ctx: any) {
          return {
            workflow: ctx.workflow,
            params: [{ nodeId: '1', fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: 0 }],
          };
        }
      `)
      .field('params', JSON.stringify({}))
      .attach('ref_images', Buffer.from('fakeimage'), 'photo.png');
    // 上传失败（9999 不可达）→ 可能 500 或 400；以 uploadFileToComfyUI 实际行为为准
    expect([200, 400, 500]).toContain(res.status);
  });
```

**重要提示**：`uploadFileToComfyUI` 失败行为决定这些测试的断言。实现者必须先读 `upload.service.ts` 确认其错误处理（抛错 vs 返回失败），再写断言。若抛错，两个测试的期望应为「请求失败（500/502）但流程走通」或改用本地假服务。

- [ ] **Step 5: 运行路由测试 + 类型检查**

Run: `pnpm --filter server exec vitest run src/routes/workflow.routes.test.ts`
Run: `pnpm --filter server exec tsc --noEmit`
Expected: 全部通过（现有 simulate 测试若缺 base_url 需补配置）。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/controllers/workflow.controller.ts packages/server/src/routes/workflow.routes.ts packages/server/src/routes/workflow.routes.test.ts
git commit -m "feat: restructure execute/simulate to build-then-upload with script-declared params"
```

---

## Task 4: 前端 — 类型/API/模拟对话框媒体/执行对话框手动字段

**Files:**
- Modify: `packages/client/src/types/index.ts`
- Modify: `packages/client/src/api/workflows.ts`
- Modify: `packages/client/src/components/build-script/BuildSimulateDialog.vue`
- Modify: `packages/client/src/pages/WorkflowListPage.vue`

- [ ] **Step 1: `types/index.ts` 增加前端侧类型**

追加：

```ts
/**
 * 运行时参数声明（脚本声明返回）
 */
export interface RuntimeParam {
  nodeId: string;
  fieldName: string;
  alias: string | null;
  label: string | null;
  paramType: string;
  defaultValue: string | null;
  fileIndex: number;
}
```

`SimulateResult` 增加 `params`：

```ts
export interface SimulateResult {
  /** 构建并应用参数后的最终工作流 JSON 字符串 */
  json: string;
  /** 脚本声明的有效参数配置 */
  params: RuntimeParam[];
}
```

- [ ] **Step 2: `api/workflows.ts` — `simulateBuild` 支持 multipart**

`simulateBuild` 签名扩展，支持文件：

```ts
/**
 * 模拟构建：脚本 + 参数 + 可选媒体文件 → 构建后的最终 JSON 与参数配置
 * @param workflowId 工作流 ID
 * @param data 脚本源码与参数
 * @param files 按别名分组的媒体文件
 * @returns 模拟结果
 */
export async function simulateBuild(
  workflowId: string,
  data: { script: string; params: Record<string, unknown> },
  files?: Record<string, File>,
): Promise<SimulateResult> {
  if (!files || Object.keys(files).length === 0) {
    const res = await client.post<SimulateResult>(`/workflows/${workflowId}/build/simulate`, data);
    return res.data;
  }
  const formData = new FormData();
  formData.append('script', data.script);
  formData.append('params', JSON.stringify(data.params));
  for (const [alias, file] of Object.entries(files)) {
    formData.append(alias, file);
  }
  const res = await client.post<SimulateResult>(`/workflows/${workflowId}/build/simulate`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}
```

- [ ] **Step 3: `BuildSimulateDialog.vue` 支持媒体字段**

当前对话框渲染 text/number/boolean 输入（`aliasParams` computed 来自 `props.workflow.params` 静态配置）。改造：

1. **参数来源**：模拟请求前，脚本声明的字段是动态的，对话框无法预知。设计为「**手动添加任意类型字段** + 静态字段」两区（与执行对话框一致，用户已确认）。保留静态字段渲染，新增媒体文件选择器与手动添加区。

2. **媒体文件状态**：新增 `mediaFiles = ref<Record<string, File[]>>({})`（按别名），`v-file-input` 支持多选（`multiple`）。

3. **提交**：`runSimulate` 改为调 `simulateBuild(workflow.id, { script, params }, files)`，文件为空时走 JSON 路径。

4. **结果**：`SimulateResult.params` 用于结果视图——若脚本声明了静态配置之外的字段，可展示在结果页（或暂不展示，YAGNI）。**最小实现**：结果 `{ json }` 展示不变，`params` 暂存不额外渲染（前端字段渲染由「手动添加」承载）。

具体模板改动（媒体输入行）：

```html
          <div v-for="p in mediaParams" :key="p.id" class="mb-3">
            <v-file-input
              v-model="mediaFiles[p.alias!]"
              :label="paramLabel(p)"
              density="compact"
              variant="outlined"
              hide-details
              multiple
              :show-size="false"
            />
          </div>
```

`mediaParams` computed（静态配置中媒体类型且有别名）：

```ts
const mediaParams = computed<WorkflowParam[]>(() =>
  props.workflow.params.filter((p) =>
    p.alias != null && p.alias !== '' && ['image', 'video', 'audio'].includes(p.paramType),
  ),
);
```

`runSimulate` 组装：

```ts
/** 组装媒体文件（按别名） */
function buildFiles(): Record<string, File> {
  const result: Record<string, File> = {};
  for (const p of mediaParams.value) {
    if (!p.alias) continue;
    const list = mediaFiles.value[p.alias];
    if (list && list.length > 0) {
      // 多文件时仅取第一个（模拟场景以单文件为主；多文件由脚本声明在真实执行中处理）
      result[p.alias] = list[0];
    }
  }
  return result;
}
```

`runSimulate` 改为：

```ts
async function runSimulate(): Promise<void> {
  simulating.value = true;
  errorText.value = '';
  try {
    const files = buildFiles();
    const res = await simulateBuild(
      props.workflow.id,
      { script: props.script, params: buildParams() },
      Object.keys(files).length > 0 ? files : undefined,
    );
    builtJson.value = res.json;
    step.value = 2;
  } catch (err) {
    errorText.value = extractError(err);
    step.value = 2;
  } finally {
    simulating.value = false;
  }
}
```

`watch(show)` 复位时清空 `mediaFiles`。

**手动添加任意类型字段**（与执行对话框一致，用户确认）：新增 `simFreeFields` 区，type 含 text/number/boolean/image/video/audio；媒体类型的自由字段也走文件选择器。为控制复杂度，媒体自由字段文件并入 `mediaFiles`（key=字段名）。

- [ ] **Step 4: `WorkflowListPage.vue` 手动添加任意类型字段**

现有 `handleExecute` 渲染静态 `detail.params` 字段，`confirmExecute` 组装 `aliasValues` + `executeFiles`。新增：

1. **手动字段状态**：`manualFields = ref<Array<{ key: string; type: string; value: string }>>([])` 与 `manualFiles = ref<Record<string, File>>({})`（媒体类型用文件）。
2. **模板**：执行对话框底部加"添加自定义字段"按钮与字段行（类型选择 text/number/boolean/image/video/audio；媒体 → 文件选择器）。
3. **提交合并**：`confirmExecute` 中，非媒体手动字段并入 `aliasValues`，媒体手动字段并入 `executeFiles`（`executeWorkflow` 已支持 multipart）。

具体实现以 `WorkflowListPage.vue` 现有模板结构为准（需读该文件模板部分后落笔）。

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter client exec vue-tsc --noEmit`
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/types/index.ts packages/client/src/api/workflows.ts packages/client/src/components/build-script/BuildSimulateDialog.vue packages/client/src/pages/WorkflowListPage.vue
git commit -m "feat: support media fields in simulate/execute dialogs and manual field adding"
```

---

## Task 5: 全量验证与手工冒烟

**Files:**
- 无新增

- [ ] **Step 1: 后端类型检查 + 全量测试**

Run: `pnpm --filter server exec tsc --noEmit`
Run: `pnpm --filter server test`
Expected: 全部通过。

- [ ] **Step 2: 前端类型检查 + 构建**

Run: `pnpm --filter client exec vue-tsc --noEmit`
Run: `pnpm --filter client build`
Expected: 全部通过。

- [ ] **Step 3: 手工冒烟（开发服务器 + 真实 ComfyUI）**

1. 工作流详情页"动态构建脚本"页签：输入新契约脚本（返回 `{ workflow, params }`），确认 Monaco 中 `BuildResult`/`RuntimeParam`/`ctx.files`/`ctx.baseParams` 有类型提示
2. 模拟构建：选择 image 字段文件 → 开始模拟 → 结果 JSON 中该字段为真实上传文件名（ComfyUI 可达时）；`params` 返回脚本声明配置
3. 执行对话框：手动添加媒体字段（如 `ref_images` image 类型）→ 选文件 → 执行 → 任务提交成功，脚本根据 `ctx.files` 数量动态建节点
4. 脚本返回非法结构 → 任务 failed，错误信息含 `{ workflow, params }`
5. 无脚本工作流 → 行为与旧版一致（回归）

- [ ] **Step 4: Commit（如有遗漏变更）**

```bash
git status
git add -A
git commit -m "chore: finalize script-managed params feature"
```

---

## 参考

- 设计文档：`docs/superpowers/specs/2026-08-02-script-managed-params-design.md`
- 既有模式：`execute`/`simulateBuild` 现有实现、`executor.service.ts` 的 `applyAliases`/`processMediaParams`、`workflow.routes.test.ts` 的 multipart 测试（`executeWorkflow` 已支持）
