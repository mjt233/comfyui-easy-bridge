import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from './settings.service';
import { BUILD_SCRIPT_DTS_HEADER, BUILD_RESULT_DTS, RUNTIME_PARAM_DTS, buildBuildContextDts } from './build-script-api';

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
 * 节点速查条目（前端节点速查表用）：输入按数组保序，便于表格渲染。
 */
export interface NodeReference {
  /** 类名（class_type） */
  name: string;
  /** 展示名；缺省回退类名 */
  display_name: string;
  /** 分类；缺省 null */
  category: string | null;
  /** 必填输入（hidden 已剔除） */
  required_inputs: Array<{ name: string; type: string; options?: string[] }>;
  /** 可选输入 */
  optional_inputs: Array<{ name: string; type: string; options?: string[] }>;
  /** 输出类型列表 */
  outputs: string[];
  /** 输出名列表 */
  output_names: string[];
}

/**
 * 将节点类摘要转换为排序后的速查条目数组（按类名字母序）。
 * 输入映射由 Record 转为保序数组，便于前端直接渲染。
 * @param nodeInfo 节点类摘要
 * @returns 节点速查条目数组
 */
export function toNodeReferenceList(nodeInfo: Record<string, NodeClassInfo>): NodeReference[] {
  return Object.entries(nodeInfo)
    .map(([name, info]): NodeReference => {
      const toFieldArray = (map: Record<string, NodeFieldSpec>): Array<{ name: string; type: string; options?: string[] }> =>
        Object.entries(map).map(([fieldName, spec]) => ({
          name: fieldName,
          type: spec.type,
          ...(spec.options && spec.options.length > 0 ? { options: spec.options } : {}),
        }));
      return {
        name,
        display_name: info.display_name,
        category: info.category,
        required_inputs: toFieldArray(info.required_inputs),
        optional_inputs: toFieldArray(info.optional_inputs),
        outputs: info.outputs,
        output_names: info.output_names,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
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
  /** 拉取失败后的负缓存 TTL（毫秒） */
  negativeCacheTtlMs: 60 * 1000,
  /** fetch 实现（测试可覆盖） */
  fetchImpl: async (url: string, init?: { signal?: AbortSignal }) => {
    const res = await fetch(url, init);
    return res;
  },
  /** 时间源（测试可覆盖） */
  now: (): number => Date.now(),
};

/** 缓存：baseUrl → { 摘要数据(可为 null 表示失败), 拉取时间戳 } */
const cache = new Map<string, { data: Record<string, NodeClassInfo> | null; fetchedAt: number }>();
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
  // 第二项为配置对象（非数组）时，取其中的 options 列表
  const config = field[1] && typeof field[1] === 'object' && !Array.isArray(field[1]) ? field[1] as { options?: unknown } : null;
  // 直接选项数组形态：["euler", "heun"] 等
  if (Array.isArray(typeOrOptions)) {
    return {
      type: 'COMBO',
      options: typeOrOptions.filter((o): o is string => typeof o === 'string'),
    };
  }
  // 常规形态：类型名 + 可选配置
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
    // 跳过非对象条目
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const cls = value as {
      input?: unknown;
      display_name?: unknown;
      category?: unknown;
      output?: unknown;
      output_name?: unknown;
    };
    // input 分组缺失时按空对象处理
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

  // TTL 内直接返回缓存（成功用长 TTL，失败用短负缓存 TTL）
  const cached = cache.get(baseUrl);
  if (cached) {
    const ttl = cached.data ? nodeInfoServiceConfig.cacheTtlMs : nodeInfoServiceConfig.negativeCacheTtlMs;
    if (nodeInfoServiceConfig.now() - cached.fetchedAt < ttl) {
      return cached.data;
    }
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
      // 拉取失败/超时：写入负缓存（短 TTL），降级为 null，不抛错
      cache.set(baseUrl, { data: null, fetchedAt: nodeInfoServiceConfig.now() });
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
  // 先拼好升级签名后的 BuildContext 片段，避免模板字面量内出现多行表达式
  const contextDts = buildBuildContextDts(
    'addNode<K extends ComfyClassType>(nodeId: string, classType: K, inputs?: Partial<ComfyNodeInputs[K]>, title?: string): ComfyNode;',
    'findNodesByClass(classType: ComfyClassType): string[];',
  );
  return `${BUILD_SCRIPT_DTS_HEADER}
${RUNTIME_PARAM_DTS}
${BUILD_RESULT_DTS}
${generateNodeClassDts(nodeInfo)}
${contextDts}`;
}
