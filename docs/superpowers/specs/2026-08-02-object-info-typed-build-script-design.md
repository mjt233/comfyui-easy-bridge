# 动态构建脚本的 object_info 类型增强设计

## 背景

当前 `ComfyNode.class_type` 的类型是 `string`，用户在 Monaco 编辑器中编写动态构建脚本时，`addNode('9', 'KSampler', ...)` 的类名、`setInput` 的字段名都没有任何补全提示，必须凭记忆或查文档。ComfyUI 提供 `GET /object_info` 接口，返回全部支持的节点类（class_type）及其输入/输出/配置字段定义（实测 1619 个类、2.5MB）。

## 目标

调用 ComfyUI 的 `/object_info` 接口，**动态生成类型声明**，让 Monaco 编辑器能够：
1. 补全 `addNode`/`findNodesByClass` 的 `classType` 参数（所有支持的 class_type 名称）
2. 补全 `addNode` 第三个参数 `inputs` 中该节点类支持的字段名
3. 提供节点类的输入/输出字段摘要类型（`ComfyNodeClassInfo`），供脚本作者查阅

不改变脚本运行时行为（`BuildContext` 不新增运行时能力），仅在编辑器类型层面增强。

## 关键决策（已与用户确认）

| 决策点 | 结论 |
|--------|------|
| 类型粒度 | **联合 + 字段摘要**：class 联合类型（41KB）+ 每类节点的输入/输出字段名与类型摘要（共约 667KB）。不含 tooltip/description/min/max 等全量配置 |
| 运行时能力 | **仅编辑器类型**：不改 `build.worker.ts`，`BuildContext` 不暴露运行时 nodeInfo（避免 2.5MB 每次执行跨线程传输） |
| 缓存刷新 | **TTL 30min 自动刷新**：服务端首次请求 d.ts 时拉取并缓存，过期后下次请求自动刷新 |
| 降级行为 | ComfyUI 未配置/不可达 → 返回现有静态 d.ts（`class_type: string`，无补全） |

## 实测数据（设计依据）

- `GET /object_info`（与 `/api/object_info` 等价）：200、2.5MB、1619 个类、约 400ms
- 纯 class 联合类型 d.ts：约 41KB
- 联合 + 字段名/类型摘要 d.ts：约 667KB（Monaco 可接受）
- 全量（含 options/default 等）：接近原始 2.5MB，会拖慢 Monaco，已排除
- ComfyUI 输入字段两种 COMBO 形态：
  1. `["COMBO", { "options": [...], "default": ... }]`
  2. `[[...options], { config }]`（直接选项数组）
- 现有代码调用 ComfyUI 用无 `/api` 前缀路径（如 `${baseUrl}/prompt`），故 object_info 用 `${baseUrl}/object_info`

## 方案选型

### 选定方案：服务端生成式动态 d.ts（方案 A）

- 服务端按 `comfyui_base_url` 配置拉取 `/object_info`，TTL 30min 缓存，生成摘要 d.ts 片段
- `GET /api/workflows/build-api.d.ts` 动态拼装返回
- 前端零改动（`BuildScriptEditor.vue` 挂载时已拉取并注册）
- 已排除：前端直连 ComfyUI（CORS/地址暴露/浏览器端 TS 编译复杂）、定期生成静态 d.ts（不"动态"）

## 详细设计

### 1. 新增 `packages/server/src/services/node-info.service.ts`

**类型定义：**

```ts
/** 节点输入字段摘要（d.ts 用） */
export interface NodeFieldSpec {
  /** ComfyUI 类型名：INT/FLOAT/STRING/COMBO/IMAGE/... */
  type: string;
  /** COMBO 可选值（如有） */
  options?: string[];
}

/** 节点类摘要（d.ts 用） */
export interface NodeClassInfo {
  display_name: string;
  category: string | null;
  required_inputs: Record<string, NodeFieldSpec>;
  optional_inputs: Record<string, NodeFieldSpec>;
  outputs: string[];
  output_names: string[];
}
```

**函数：**

```ts
/** 拉取 ComfyUI object_info；失败抛错 */
export async function fetchNodeInfo(baseUrl: string): Promise<Record<string, unknown>>;

/** 提取字段名/类型/options，丢弃 tooltip/description/min/max（2.5MB → ~600KB） */
export function summarizeNodeInfo(raw: Record<string, unknown>): Record<string, NodeClassInfo>;

/** 内存缓存 + TTL 30min；未配置/失败返回 null（不抛错） */
export async function getNodeInfoCached(db: ...): Promise<Record<string, NodeClassInfo> | null>;

/** 生成 d.ts 片段（含 ComfyNodeInputs / ComfyClassType / ComfyNodeClassInfo / ComfyNodeInfoMap） */
export function generateNodeClassDts(nodeInfo: Record<string, NodeClassInfo>): string;

/** 拼装完整 d.ts：静态公共声明 + 节点类片段 + 升级后的 addNode/findNodesByClass */
export function generateBuildDts(nodeInfo: Record<string, NodeClassInfo>): string;
```

**summarize 规则：**
- 输入分组：`input.required` → `required_inputs`；`input.optional` → `optional_inputs`；`input.hidden` **剔除**（prompt/extra_pnginfo 等内部字段，用户脚本不应操作）
- 字段规格提取：`[type, config]` 形态取 `type` 与 `config.options`；`[[options], config]` 形态取 `type='COMBO'`、`options` 为数组
- 丢弃：`tooltip`、`description`、`min`/`max`/`step`、`multiline`、`default` 等配置细节
- 元信息：`display_name`（缺省回退类名）、`category`（缺省 null）、`output` → `outputs`、`output_name` → `output_names`

**缓存实现：** 模块级内存 Map，键为 `comfyui_base_url`，值为 `{ data, fetchedAt }`；`Date.now() - fetchedAt > 30*60*1000` 视为过期重新拉取。测试通过注入可覆盖的 `fetchImpl` 与时间源实现确定性。

### 2. d.ts 动态片段结构（实测约 667KB）

```ts
/** ComfyUI 支持的节点类 → 输入字段映射 */
declare type ComfyNodeInputs = {
  'KSampler': { model: unknown; seed: unknown; steps: unknown; ... };
  'SaveVideo': { video: unknown; filename_prefix: unknown; format: unknown; ... };
  // ... 1619 个类
};
/** 全部已知节点类名（供 class_type 补全） */
declare type ComfyClassType = keyof ComfyNodeInputs;
/** 节点类元信息 */
declare interface ComfyNodeClassInfo {
  display_name: string;
  category: string | null;
  required_inputs: Record<string, { type: string; options?: string[] }>;
  optional_inputs: Record<string, { type: string; options?: string[] }>;
  outputs: string[];
  output_names: string[];
}
/** 节点类 → 元信息映射（仅类型提示，无运行时值） */
declare type ComfyNodeInfoMap = { [K in ComfyClassType]: ComfyNodeClassInfo };
```

- 字段值统一为 `unknown`（连接值可为 `[nodeId, slot]`，值类型精确化意义有限），只保证**字段名补全**
- 生成时按类名字母排序（稳定输出，利于 diff 与缓存）

### 3. 端点拼装（`workflow.controller.ts`）

`getBuildApiTypes` 改为 async：

```ts
async getBuildApiTypes(_req, res, next): Promise<void> {
  try {
    const nodeInfo = await getNodeInfoCached(db);
    if (nodeInfo) {
      // 动态版：BUILD_SCRIPT_API_DTS 的模板 + 节点类片段
      res.type('text/plain').send(generateBuildDts(nodeInfo));
    } else {
      // 降级：静态版（ComfyNode.class_type 保持 string）
      res.type('text/plain').send(BUILD_SCRIPT_API_DTS);
    }
  } catch (err) { next(err); }
}
```

**动态版 d.ts 内容（generateBuildDts）：**
- `ComfyNodeInputs` / `ComfyClassType` / `ComfyNodeClassInfo` / `ComfyNodeInfoMap` 片段（上面结构）
- `BuildContext` 声明中 `addNode` 升级为泛型：

```ts
addNode<K extends ComfyClassType>(nodeId: string, classType: K, inputs?: Partial<ComfyNodeInputs[K]>): void;
findNodesByClass(classType: ComfyClassType): string[];
```

- **`ComfyNode.class_type` 保持 `string`**：避免 1619 联合类型拖慢 `ctx.workflow`（`Record<string, ComfyNode>`）上的 TS 操作；补全价值由 `addNode`/`findNodesByClass` 的参数类型承担

**静态版与动态版的 BuildContext 一致性**：`generateBuildDts` 复用静态 d.ts 中除 addNode/findNodesByClass 外的全部声明（单一来源，避免两处漂移）。实现方式：`build-script-api.ts` 将 `BUILD_SCRIPT_API_DTS` 拆为「公共声明 + 静态 addNode/findNodesByClass 行 + 模板常量」，动态版替换这两行并注入片段。

### 4. 前端适配

- **零改动**：`BuildScriptEditor.vue` 挂载时已 `getBuildApiTypes()` → `registerBuildApiTypes()`（同名文件 `comfy-build-api.d.ts` 覆盖注册），服务端返回内容变化后自动生效
- **可选优化（YAGNI 默认不做）**：667KB d.ts 每次打开页签重新拉取；可加 sessionStorage 缓存，但不纳入本次范围

## 测试计划

**`node-info.service.test.ts`（核心）：**
- `summarizeNodeInfo`：样本 object_info（含 COMBO 两种形态、required/optional/hidden、output/output_name）→ 断言摘要结构正确、hidden 剔除、tooltip/min/max 丢弃、display_name 回退
- `getNodeInfoCached`：mock fetch 成功 → 返回摘要；TTL 内走缓存（fetch 计数 1）；过期后重新 fetch；未配置/不可达 → `null` 不抛错
- `generateNodeClassDts`：断言含 `ComfyClassType`、`ComfyNodeInputs`、类名联合、字段名；输出稳定（两次调用一致）

**路由/controller 测试：**
- `GET /build-api.d.ts`（mock `getNodeInfoCached` 有数据）→ 响应含 `ComfyClassType` 与类名
- `GET /build-api.d.ts`（mock 返回 null）→ 响应为静态版（含 `declare interface BuildContext`、不含 `ComfyClassType`）

**前端：** `vue-tsc --noEmit` 类型验证 + 手动验证 Monaco 中 `addNode('9', 'KSampl|')` 有类名补全、`addNode('9', 'KSampler', { se| })` 有字段补全。

## 验证命令

```bash
pnpm --filter server exec tsc --noEmit
pnpm --filter server test
pnpm --filter client exec vue-tsc --noEmit
```
