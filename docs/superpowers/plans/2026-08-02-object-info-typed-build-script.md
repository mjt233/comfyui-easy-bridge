# 动态构建脚本 object_info 类型增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 调用 ComfyUI `/object_info` 动态生成 d.ts 类型声明，让 Monaco 编辑器能补全 `addNode`/`findNodesByClass` 的节点类名与 `addNode` 的输入字段名。

**Architecture:** 服务端新增 `node-info.service.ts`（拉取 `/object_info` + TTL 30min 缓存 + 摘要化 + d.ts 生成）；`build-script-api.ts` 模板化重构（拆分公共声明与 BuildContext 模板）；`getBuildApiTypes` 异步化，有数据返回动态版 d.ts、无数据降级静态版。前端零改动。

**Tech Stack:** Express + TypeScript + Drizzle ORM (SQLite)、Node fetch + AbortController

---

## 前置已验证事实

- ComfyUI `GET /object_info`（与 `/api/object_info` 等价）实测：200、2.5MB、1619 类、约 400ms；代码库现有调用 ComfyUI 用无 `/api` 前缀路径（如 `${baseUrl}/prompt`），故用 `${baseUrl}/object_info`
- 输入字段两种 COMBO 形态：`["COMBO", { options: [...] }]` 与 `[[...options], config]`
- 摘要化 d.ts（联合 + 字段名）约 667KB；纯 class 联合约 41KB
- 现有 `nodeInfoServiceConfig` 覆盖模式参照 `task.controller.ts` 的 `outputHistoryBackfillConfig`
- `settings` 路由为 `PUT /api/settings`（body `{ key, value }`）
- `noUnusedLocals`/`noUnusedParameters` 已开启；`esModuleInterop` 已开启

---

## 任务清单总览

| Task | 内容 | 关键文件 |
|------|------|----------|
| 1 | `build-script-api.ts` 模板化重构（静态输出不变） | `build-script-api.ts` + 测试 |
| 2 | `node-info.service.ts`（拉取/摘要/缓存/d.ts 生成） | 新文件 + 测试 |
| 3 | controller `getBuildApiTypes` 异步化 + 路由测试 | `workflow.controller.ts`、`workflow.routes.test.ts` |
| 4 | 全量验证 + 手工冒烟 | 全部 |

---

## Task 1: `build-script-api.ts` 模板化重构

**Files:**
- Modify: `packages/server/src/services/build-script-api.ts`
- Modify: `packages/server/src/services/build-script-api.test.ts`（补充断言）

**目标：** 拆分 d.ts 为「公共头部」+「BuildContext 模板」，供静态版与动态版复用，静态版 `BUILD_SCRIPT_API_DTS` 输出与当前**逐字符一致**。

- [ ] **Step 1: 重构 `build-script-api.ts`**

将 `BUILD_SCRIPT_API_DTS` 拆为 `BUILD_SCRIPT_DTS_HEADER` + `buildBuildContextDts(addNodeSig, findNodesByClassSig)` 函数。替换现有 `BUILD_SCRIPT_API_DTS` 常量定义（`ComfyNode`/`ComfyWorkflow` TS 类型与 `DEFAULT_BUILD_SCRIPT_TEMPLATE` 保持不变）：

```ts
/** d.ts 头部：节点与工作流基础声明 */
export const BUILD_SCRIPT_DTS_HEADER = `/** ComfyUI API 工作流节点 */
declare interface ComfyNode {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: { title?: string };
}

/** ComfyUI API 工作流（节点 ID → 节点） */
declare type ComfyWorkflow = Record<string, ComfyNode>;
`;

/**
 * 生成 BuildContext 声明文本，注入 addNode / findNodesByClass 的方法签名。
 * 静态版（classType: string）与动态版（classType: ComfyClassType）复用同一模板，避免两处漂移。
 * @param addNodeSig addNode 方法签名行（不含缩进）
 * @param findNodesByClassSig findNodesByClass 方法签名行（不含缩进）
 * @returns BuildContext 的 d.ts 文本
 */
export function buildBuildContextDts(addNodeSig: string, findNodesByClassSig: string): string {
  return `/** 构建上下文：脚本默认导出函数的唯一入参 */
declare interface BuildContext {
  /** 原始工作流（深拷贝，可直接修改） */
  workflow: ComfyWorkflow;
  /** 用户提交的参数（别名字段 + 自由添加字段） */
  params: Record<string, unknown>;
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

/**
 * 静态版（ComfyUI 未配置/不可达时降级）脚本 API 类型声明文本。
 * 由 GET /api/workflows/build-api.d.ts 下发，前端 addExtraLib 注册。
 */
export const BUILD_SCRIPT_API_DTS = `${BUILD_SCRIPT_DTS_HEADER}
${buildBuildContextDts(
  'addNode(nodeId: string, classType: string, inputs?: Record<string, unknown>): void;',
  'findNodesByClass(classType: string): string[];',
)}`;
```

注意：模板中 `${addNodeSig}`/`${findNodesByClassSig}` 前已有两空格缩进，传入的签名**不带**前导缩进。`BUILD_SCRIPT_API_DTS` 的输出必须与重构前逐字符一致（下方测试会验证）。

- [ ] **Step 2: 在 `build-script-api.test.ts` 追加断言**

在现有 describe 内追加用例：

```ts
  it('static dts output is composed from header and static signatures', () => {
    expect(BUILD_SCRIPT_API_DTS).toContain('declare interface ComfyNode');
    expect(BUILD_SCRIPT_API_DTS).toContain('declare interface BuildContext');
    expect(BUILD_SCRIPT_API_DTS).toContain('addNode(nodeId: string, classType: string, inputs?: Record<string, unknown>): void;');
    expect(BUILD_SCRIPT_API_DTS).toContain('findNodesByClass(classType: string): string[];');
    expect(BUILD_SCRIPT_API_DTS).not.toContain('ComfyClassType');
  });

  it('buildBuildContextDts injects custom signatures', () => {
    const dts = buildBuildContextDts(
      'addNode<K extends ComfyClassType>(nodeId: string, classType: K, inputs?: Partial<ComfyNodeInputs[K]>): void;',
      'findNodesByClass(classType: ComfyClassType): string[];',
    );
    expect(dts).toContain('addNode<K extends ComfyClassType>');
    expect(dts).toContain('findNodesByClass(classType: ComfyClassType)');
    expect(dts).toContain('removeNode(nodeId: string): void;');
  });
```

并更新 import：`import { BUILD_SCRIPT_API_DTS, DEFAULT_BUILD_SCRIPT_TEMPLATE, BUILD_SCRIPT_DTS_HEADER, buildBuildContextDts } from './build-script-api';`（若 `BUILD_SCRIPT_DTS_HEADER` 在用例中未用到则不 import，避免 `noUnusedLocals`）。

- [ ] **Step 3: 运行测试**

Run: `pnpm --filter server exec vitest run src/services/build-script-api.test.ts`
Expected: 全部通过（原 2 用例 + 新 2 用例）。

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `pnpm --filter server exec tsc --noEmit`
Run: `pnpm --filter server test`
Expected: 全部通过（重构未改变静态输出，`build.service.test.ts` 等依赖方不受影响）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/build-script-api.ts packages/server/src/services/build-script-api.test.ts
git commit -m "refactor: template build-script dts for static and dynamic variants"
```

---

## Task 2: `node-info.service.ts` 核心服务

**Files:**
- Create: `packages/server/src/services/node-info.service.ts`
- Create: `packages/server/src/services/node-info.service.test.ts`

- [ ] **Step 1: 创建 `node-info.service.ts`**

```ts
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from './settings.service';
import { BUILD_SCRIPT_DTS_HEADER, buildBuildContextDts } from './build-script-api';

/**
 * 节点输入字段摘要（d.ts 用）
 */
export interface NodeFieldSpec {
  /** ComfyUI 类型名：INT/FLOAT/STRING/COMBO/IMAGE/... */
  type: string;
  /** COMBO 可选值（如有） */
  options?: string[];
}

/**
 * 节点类摘要（d.ts 用）
 */
export interface NodeClassInfo {
  /** 展示名；缺省回退类名 */
  display_name: string;
  /** 分类；缺省 null */
  category: string | null;
  /** 必填输入（hidden 已剔除） */
  required_inputs: Record<string, NodeFieldSpec>;
  /** 可选输入 */
  optional_inputs: Record<string, NodeFieldSpec>;
  /** 输出类型列表 */
  outputs: string[];
  /** 输出名列表 */
  output_names: string[];
}

/**
 * 可测试配置：测试可覆盖 fetchImpl 与 now。
 * 模式同 task.controller.ts 的 outputHistoryBackfillConfig。
 */
export const nodeInfoServiceConfig = {
  /** object_info 拉取超时（毫秒） */
  fetchTimeoutMs: 10000,
  /** 缓存 TTL（毫秒） */
  cacheTtlMs: 30 * 60 * 1000,
  /** fetch 实现（测试可覆盖） */
  fetchImpl: async (url: string, init?: { signal?: AbortSignal }) => {
    const res = await fetch(url, init);
    return res;
  },
  /** 时间源（测试可覆盖） */
  now: (): number => Date.now(),
};

/** 缓存：baseUrl → { 摘要数据, 拉取时间戳 } */
const cache = new Map<string, { data: Record<string, NodeClassInfo>; fetchedAt: number }>();
/** 进行中的拉取（并发去重） */
const inflight = new Map<string, Promise<Record<string, NodeClassInfo> | null>>();

/**
 * 清空缓存与进行中拉取（测试用）。
 */
export function clearNodeInfoCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * 拉取 ComfyUI object_info 并解析为对象。
 * 非 2xx、JSON 非法或非对象时抛错。
 * @param baseUrl ComfyUI 基础 URL
 * @returns object_info 原始对象
 */
export async function fetchNodeInfo(baseUrl: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), nodeInfoServiceConfig.fetchTimeoutMs);
  try {
    const res = await nodeInfoServiceConfig.fetchImpl(`${baseUrl}/object_info`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`object_info returned status ${res.status}`);
    }
    const text = await res.text();
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('object_info is not an object');
    }
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 提取单个输入字段的规格摘要。
 * 支持两种 COMBO 形态：["COMBO", {options}] 与 [[...options], config]。
 * @param field object_info 中的字段定义
 * @returns 字段摘要
 */
function extractFieldSpec(field: unknown): NodeFieldSpec {
  if (!Array.isArray(field) || field.length === 0) {
    return { type: 'UNKNOWN' };
  }
  const typeOrOptions = field[0];
  const config = field[1] && typeof field[1] === 'object' && !Array.isArray(field[1]) ? field[1] as { options?: unknown } : null;
  // 直接选项数组形态
  if (Array.isArray(typeOrOptions)) {
    return {
      type: 'COMBO',
      options: typeOrOptions.filter((o): o is string => typeof o === 'string'),
    };
  }
  const spec: NodeFieldSpec = { type: String(typeOrOptions) };
  if (config && Array.isArray(config.options)) {
    spec.options = config.options.filter((o): o is string => typeof o === 'string');
  }
  return spec;
}

/**
 * 提取一组输入字段映射。
 * @param map object_info 的 required/optional/hidden 分组
 * @returns 字段名 → 摘要
 */
function extractInputMap(map: unknown): Record<string, NodeFieldSpec> {
  const result: Record<string, NodeFieldSpec> = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    return result;
  }
  for (const [name, field] of Object.entries(map as Record<string, unknown>)) {
    result[name] = extractFieldSpec(field);
  }
  return result;
}

/**
 * 将原始 object_info 摘要化：提取字段名/类型/options，丢弃 tooltip/min/max 等。
 * hidden 分组剔除（prompt/extra_pnginfo 等内部字段）。
 * @param raw object_info 原始对象
 * @returns 节点类摘要映射
 */
export function summarizeNodeInfo(raw: Record<string, unknown>): Record<string, NodeClassInfo> {
  const result: Record<string, NodeClassInfo> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const cls = value as {
      input?: unknown;
      display_name?: unknown;
      category?: unknown;
      output?: unknown;
      output_name?: unknown;
    };
    const input = (cls.input && typeof cls.input === 'object' && !Array.isArray(cls.input)
      ? cls.input as { required?: unknown; optional?: unknown }
      : {});
    result[name] = {
      display_name: typeof cls.display_name === 'string' ? cls.display_name : name,
      category: typeof cls.category === 'string' ? cls.category : null,
      required_inputs: extractInputMap(input.required),
      optional_inputs: extractInputMap(input.optional),
      outputs: Array.isArray(cls.output) ? cls.output.map(String) : [],
      output_names: Array.isArray(cls.output_name) ? cls.output_name.map(String) : [],
    };
  }
  return result;
}

/**
 * 获取节点类摘要（含 TTL 缓存与并发去重）。
 * ComfyUI 未配置、拉取失败或超时时返回 null（不抛错）。
 * @param db Drizzle 实例（读取 comfyui_base_url 设置）
 * @returns 节点类摘要或 null
 */
export async function getNodeInfoCached(
  db: BetterSQLite3Database<typeof schema>,
): Promise<Record<string, NodeClassInfo> | null> {
  const baseUrl = new SettingsService(db).get('comfyui_base_url');
  if (!baseUrl) return null;

  // TTL 内直接返回缓存
  const cached = cache.get(baseUrl);
  if (cached && nodeInfoServiceConfig.now() - cached.fetchedAt < nodeInfoServiceConfig.cacheTtlMs) {
    return cached.data;
  }

  // 并发去重：已有进行中的拉取则复用
  const existing = inflight.get(baseUrl);
  if (existing) return existing;

  const promise = (async (): Promise<Record<string, NodeClassInfo> | null> => {
    try {
      const raw = await fetchNodeInfo(baseUrl);
      const data = summarizeNodeInfo(raw);
      cache.set(baseUrl, { data, fetchedAt: nodeInfoServiceConfig.now() });
      return data;
    } catch {
      // 拉取失败/超时：降级为 null，不抛错
      return null;
    }
  })().finally(() => {
    inflight.delete(baseUrl);
  });

  inflight.set(baseUrl, promise);
  return promise;
}

/**
 * 生成节点类 d.ts 片段（ComfyNodeInputs / ComfyClassType / ComfyNodeClassInfo / ComfyNodeInfoMap）。
 * 字段值统一 unknown（连接值可为 [nodeId, slot]），只保证字段名补全；按类名字母排序稳定输出。
 * @param nodeInfo 节点类摘要
 * @returns d.ts 片段
 */
export function generateNodeClassDts(nodeInfo: Record<string, NodeClassInfo>): string {
  const names = Object.keys(nodeInfo).sort();
  const inputsLines = names.map((name) => {
    const info = nodeInfo[name];
    const fields = [...Object.keys(info.required_inputs), ...Object.keys(info.optional_inputs)];
    const fieldLines = fields.map((f) => `    ${JSON.stringify(f)}: unknown;`).join('\n');
    return `  ${JSON.stringify(name)}: {\n${fieldLines}\n  };`;
  });

  return `/** ComfyUI 支持的节点类 → 输入字段映射 */
declare type ComfyNodeInputs = {
${inputsLines.join('\n')}
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
`;
}

/**
 * 拼装动态版完整 d.ts：公共头部 + 节点类片段 + 升级签名后的 BuildContext。
 * @param nodeInfo 节点类摘要
 * @returns 完整 d.ts 文本
 */
export function generateBuildDts(nodeInfo: Record<string, NodeClassInfo>): string {
  return `${BUILD_SCRIPT_DTS_HEADER}
${generateNodeClassDts(nodeInfo)}
${buildBuildContextDts(
  'addNode<K extends ComfyClassType>(nodeId: string, classType: K, inputs?: Partial<ComfyNodeInputs[K]>): void;',
  'findNodesByClass(classType: ComfyClassType): string[];',
)}`;
}
```

- [ ] **Step 2: 创建 `node-info.service.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from './settings.service';
import {
  summarizeNodeInfo,
  generateNodeClassDts,
  generateBuildDts,
  getNodeInfoCached,
  clearNodeInfoCache,
  nodeInfoServiceConfig,
} from './node-info.service';

/** 样本 object_info（覆盖 COMBO 两种形态、required/optional/hidden、output/output_name） */
const sampleObjectInfo = {
  KSampler: {
    input: {
      required: {
        model: ['MODEL', { tooltip: 'the model' }],
        seed: ['INT', { default: 0, min: 0, max: 999, tooltip: 'seed' }],
        sampler_name: [['euler', 'heun'], { tooltip: 'sampler' }],
      },
      optional: {
        denoise: ['FLOAT', { default: 1.0 }],
      },
      hidden: {
        prompt: ['PROMPT'],
      },
    },
    display_name: 'KSampler',
    category: 'sampling',
    output: ['LATENT'],
    output_name: ['LATENT'],
  },
  SaveVideo: {
    input: {
      required: {
        format: ['COMBO', { options: ['auto', 'mp4'], default: 'auto' }],
      },
    },
    display_name: 'Save Video',
    output: ['VIDEO'],
    output_name: ['video'],
  },
};

describe('summarizeNodeInfo', () => {
  it('extracts fields, drops hidden and config details, supports both COMBO forms', () => {
    const result = summarizeNodeInfo(sampleObjectInfo);

    expect(Object.keys(result)).toEqual(['KSampler', 'SaveVideo']);

    const ks = result['KSampler']!;
    expect(ks.display_name).toBe('KSampler');
    expect(ks.category).toBe('sampling');
    // required：MODEL 类型无 options
    expect(ks.required_inputs.model).toEqual({ type: 'MODEL' });
    // 直接选项数组形态 → COMBO
    expect(ks.required_inputs.sampler_name).toEqual({ type: 'COMBO', options: ['euler', 'heun'] });
    // hidden 剔除
    expect(ks.required_inputs.prompt).toBeUndefined();
    expect(ks.optional_inputs.denoise).toEqual({ type: 'FLOAT' });
    expect(ks.outputs).toEqual(['LATENT']);
    expect(ks.output_names).toEqual(['LATENT']);

    // COMBO config.options 形态
    expect(result['SaveVideo']!.required_inputs.format).toEqual({ type: 'COMBO', options: ['auto', 'mp4'] });
    expect(result['SaveVideo']!.display_name).toBe('Save Video');
  });
});

describe('generateNodeClassDts / generateBuildDts', () => {
  it('generates dts with class union, field keys, and dynamic signatures', () => {
    const fragment = generateNodeClassDts(summarizeNodeInfo(sampleObjectInfo));
    expect(fragment).toContain('declare type ComfyNodeInputs = {');
    expect(fragment).toContain('"KSampler": {');
    expect(fragment).toContain('"seed": unknown;');
    expect(fragment).toContain('declare type ComfyClassType = keyof ComfyNodeInputs;');
    expect(fragment).toContain('declare interface ComfyNodeClassInfo');

    const full = generateBuildDts(summarizeNodeInfo(sampleObjectInfo));
    expect(full).toContain('declare interface ComfyNode');
    expect(full).toContain('declare type ComfyNodeInputs = {');
    expect(full).toContain('addNode<K extends ComfyClassType>(nodeId: string, classType: K, inputs?: Partial<ComfyNodeInputs[K]>): void;');
    expect(full).toContain('findNodesByClass(classType: ComfyClassType): string[];');
  });

  it('produces stable output across calls', () => {
    const info = summarizeNodeInfo(sampleObjectInfo);
    expect(generateNodeClassDts(info)).toBe(generateNodeClassDts(info));
  });
});

describe('getNodeInfoCached', () => {
  let sqlite: Database.Database;
  // 与既有测试文件一致：直接由 drizzle 推断类型
  let db: ReturnType<typeof drizzle<typeof schema>>;
  /** 记录 fetch 调用次数与 URL */
  let fetchCalls: string[];

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db = drizzle(sqlite, { schema });
    fetchCalls = [];
    // 覆盖 fetch 实现：返回样本 object_info
    nodeInfoServiceConfig.fetchImpl = async (url: string) => {
      fetchCalls.push(url);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify(sampleObjectInfo);
        },
      } as Response;
    };
    nodeInfoServiceConfig.now = () => 1_000_000;
    clearNodeInfoCache();
  });

  afterEach(() => {
    clearNodeInfoCache();
  });

  it('returns null when comfyui_base_url is not configured', async () => {
    const result = await getNodeInfoCached(db);
    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it('fetches, summarizes and caches within TTL', async () => {
    new SettingsService(db).set('comfyui_base_url', 'http://comfy:8188');

    const first = await getNodeInfoCached(db);
    expect(first).not.toBeNull();
    expect(first!['KSampler']!.required_inputs.seed).toEqual({ type: 'INT' });

    // TTL 内第二次调用走缓存
    const second = await getNodeInfoCached(db);
    expect(second).toEqual(first);
    expect(fetchCalls).toHaveLength(1);
  });

  it('refetches after TTL expiry', async () => {
    new SettingsService(db).set('comfyui_base_url', 'http://comfy:8188');

    await getNodeInfoCached(db);
    expect(fetchCalls).toHaveLength(1);

    // 时间前进超过 TTL
    nodeInfoServiceConfig.now = () => 1_000_000 + nodeInfoServiceConfig.cacheTtlMs + 1;
    await getNodeInfoCached(db);
    expect(fetchCalls).toHaveLength(2);
  });

  it('returns null on fetch failure without throwing', async () => {
    new SettingsService(db).set('comfyui_base_url', 'http://comfy:8188');
    nodeInfoServiceConfig.fetchImpl = async () => {
      throw new Error('unreachable');
    };

    const result = await getNodeInfoCached(db);
    expect(result).toBeNull();
  });
});
```

注意：`nodeInfoServiceConfig.fetchImpl` 覆盖后返回的 mock 对象需满足该配置里 `fetchImpl` 的类型（`{ ok: boolean; text(): Promise<string> }` 或 `Response`，实现以实际类型定义为准；若类型不合可在测试内用 `as` 断言）。`beforeEach` 里对 `db` 的类型可简化为 `any` 会被禁止——请用 `ReturnType<typeof drizzle<typeof schema>>` 或直接 `drizzle(sqlite, { schema })` 推断。

- [ ] **Step 3: 运行测试**

Run: `pnpm --filter server exec vitest run src/services/node-info.service.test.ts`
Expected: 全部通过（约 7 个用例）。

- [ ] **Step 4: 类型检查**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 通过（若 mock `Response` 类型不匹配，调整测试中的类型断言）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/node-info.service.ts packages/server/src/services/node-info.service.test.ts
git commit -m "feat: add node-info service fetching and summarizing ComfyUI object_info"
```

---

## Task 3: controller `getBuildApiTypes` 异步化 + 路由测试

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`
- Modify: `packages/server/src/routes/workflow.routes.test.ts`

- [ ] **Step 1: controller 修改**

在 `workflow.controller.ts` 的 import 区追加：

```ts
import { getNodeInfoCached, generateBuildDts } from '../services/node-info.service';
```

将 `getBuildApiTypes` 改为异步并拼装动态/静态：

```ts
    /** 返回动态构建脚本 API 的 d.ts 文本（供 Monaco 注册类型提示） */
    async getBuildApiTypes(_req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        // 有 object_info 时返回动态版（含节点类补全），否则降级为静态版
        const nodeInfo = await getNodeInfoCached(db);
        res.type('text/plain').send(nodeInfo ? generateBuildDts(nodeInfo) : BUILD_SCRIPT_API_DTS);
      } catch (err) {
        next(err);
      }
    },
```

（`db` 是 `createWorkflowController(db)` 的闭包参数，可直接使用。）

- [ ] **Step 2: 路由测试**

在 `packages/server/src/routes/workflow.routes.test.ts` 顶部 import 追加：

```ts
import { nodeInfoServiceConfig, clearNodeInfoCache } from '../services/node-info.service';
import { SettingsService } from '../services/settings.service';
```

在 `describe('Workflow API')` 内、`beforeAll` 之前追加 `beforeEach`（重置缓存、清空 base_url 设置、恢复默认 fetch 实现，避免跨用例污染）：

```ts
  beforeEach(() => {
    clearNodeInfoCache();
    // 清空 comfyui_base_url，保证现有静态 d.ts 用例不受测试顺序污染
    new SettingsService(db).set('comfyui_base_url', '');
    // 恢复默认 fetch 实现（部分用例会覆盖它）
    nodeInfoServiceConfig.fetchImpl = async (url: string, init?: { signal?: AbortSignal }) => {
      const res = await fetch(url, init);
      return res;
    };
  });
```

（注意：`beforeEach` 在 `beforeAll` 之后执行，`db` 此时已创建，可直接用。）

在现有的 `GET /api/workflows/build-api.d.ts returns d.ts text` 用例之后追加两个用例（复用登录 token 模式）：

```ts
  it('GET /api/workflows/build-api.d.ts returns dynamic dts with node classes when object_info available', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    // 配置 comfyui_base_url 并注入假 object_info
    await supertest(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'comfyui_base_url', value: 'http://comfy:8188' });
    nodeInfoServiceConfig.fetchImpl = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          KSampler: {
            input: { required: { seed: ['INT', {}] } },
            display_name: 'KSampler',
            output: ['LATENT'],
          },
        });
      },
    }) as Response;

    const res = await supertest(app)
      .get('/api/workflows/build-api.d.ts')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('declare type ComfyClassType = keyof ComfyNodeInputs;');
    expect(res.text).toContain('"KSampler": {');
    expect(res.text).toContain('addNode<K extends ComfyClassType>');
  });

  it('GET /api/workflows/build-api.d.ts falls back to static dts when no base url', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    // 确保未配置 comfyui_base_url（若被前一用例污染则清除）
    new SettingsService(db).set('comfyui_base_url', '');

    const res = await supertest(app)
      .get('/api/workflows/build-api.d.ts')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('declare interface BuildContext');
    expect(res.text).not.toContain('ComfyClassType');
  });
```

注意：
- 该测试文件 `beforeAll` 中已创建 `db` 变量（`drizzle(sqlite, { schema })`），`SettingsService(db)` 可直接用
- 若 mock `Response` 类型不合，用 `as unknown as Response` 断言
- 现有 `GET /api/workflows/build-api.d.ts returns dts text` 用例断言静态内容（`declare interface BuildContext`），在未配置 base_url 时仍走静态路径，应继续通过；若因测试顺序导致 base_url 被污染，确保在 beforeAll 后用 `beforeEach` 或该用例内显式清空 settings

- [ ] **Step 3: 运行路由测试**

Run: `pnpm --filter server exec vitest run src/routes/workflow.routes.test.ts`
Expected: 全部通过（原 25 用例 + 新增 2 用例）。

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `pnpm --filter server exec tsc --noEmit`
Run: `pnpm --filter server test`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/controllers/workflow.controller.ts packages/server/src/routes/workflow.routes.test.ts
git commit -m "feat: serve dynamic build-api dts with node class types"
```

---

## Task 4: 全量验证与手工冒烟

**Files:**
- 无新增

- [ ] **Step 1: 后端类型检查 + 全量测试**

Run: `pnpm --filter server exec tsc --noEmit`
Run: `pnpm --filter server test`
Expected: 全部通过，无回归。

- [ ] **Step 2: 前端类型检查**

Run: `pnpm --filter client exec vue-tsc --noEmit`
Expected: 通过（前端无改动）。

- [ ] **Step 3: 手工冒烟（开发服务器 + 真实 ComfyUI）**

1. 启动 `pnpm dev:server` 与 `pnpm dev:client`，确保 ComfyUI 在 `comfyui_base_url` 配置的地址可达
2. 打开工作流详情页 → "动态构建脚本"页签
3. 在编辑器中输入 `ctx.addNode('9', 'KSampler', {` 确认：
   - `addNode` 第二参数有类名补全（如 KSampler/CLIPTextEncode）
   - 第三参数对象内补全 `seed`/`steps`/`cfg` 等字段名
4. 输入 `ctx.findNodesByClass('KSampl|')` 确认类名补全
5. 关闭 ComfyUI 或清空 `comfyui_base_url` 后刷新页签，确认补全降级（无类名提示、`class_type` 仍为 string），且页面无报错
6. 首次请求 d.ts 后，Network 面板确认 `/api/workflows/build-api.d.ts` 响应约几百 KB（含动态片段）

- [ ] **Step 4: Commit（如有遗漏变更）**

```bash
git status
git add -A
git commit -m "chore: finalize object_info typed build script feature"
```

---

## 参考

- 设计文档：`docs/superpowers/specs/2026-08-02-object-info-typed-build-script-design.md`
- 既有模式：`task.controller.ts` 的 `outputHistoryBackfillConfig`（可覆盖配置）、`workflow.routes.test.ts` 的集成测试结构、`settings` 路由为 `PUT /api/settings`
