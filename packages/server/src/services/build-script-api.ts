/**
 * 动态构建脚本 API：编辑器类型声明（d.ts 文本）的单一事实来源。
 * 运行时辅助函数实现在 build.worker.ts 内（随 worker 源码字符串下发执行），
 * 其行为必须与本文件导出的类型声明保持一致，由 build.service.test.ts 锁定。
 */

// FileMeta 仅出现在下方 d.ts 模板字符串内（非真实 TS 类型位置），导入会触发 noUnusedLocals（TS6196），故只导入 RuntimeParam
import type { RuntimeParam } from './param.types';
import type { ProviderConfig, ProviderType } from './providers/types';

/** ComfyUI API 工作流节点 */
export interface ComfyNode {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: { title?: string };
}

/** ComfyUI API 工作流（节点 ID → 节点） */
export type ComfyWorkflow = Record<string, ComfyNode>;

/** 脚本返回：工作流 + 完整参数配置 */
export interface BuildResult {
  workflow: ComfyWorkflow;
  params: RuntimeParam[];
}

/**
 * 触发本次构建的 HTTP 请求快照（可结构化克隆，供 worker 使用）。
 * Authorization / Cookie 等敏感头已剥离。
 */
export interface BuildRequestInfo {
  /** HTTP 方法（如 GET / POST） */
  method: string;
  /** 路径（不含 query） */
  path: string;
  /** 原始 URL（含 query） */
  originalUrl: string;
  /** query 参数（嵌套对象已丢弃，仅保留字符串/字符串数组） */
  query: Record<string, string | string[]>;
  /** 请求头（键已小写；敏感头已剥离） */
  headers: Record<string, string | string[]>;
  /** 客户端 IP；无法解析时为 null */
  ip: string | null;
  /** 协议 http / https */
  protocol: string;
  /** 主机名 */
  hostname: string;
  /** Content-Type；缺失时为 null */
  contentType: string | null;
}

/**
 * 本次执行解析到的提供商实例快照（可结构化克隆，供 worker 使用）。
 * config 含 runninghub 明文 apiKey，仅脚本侧可见，不得回传客户端。
 */
export interface BuildProviderInfo {
  /** 实例 ID */
  id: string;
  /** 展示名 */
  name: string;
  /** 提供商类型 */
  type: ProviderType;
  /** 并发上限 */
  concurrency: number;
  /** 任务跟踪模式 */
  trackingMode: 'websocket' | 'polling';
  /** 类型化配置（按 type 区分） */
  config: ProviderConfig;
  /** 解析后的执行地址（含完整凭据，仅脚本可见） */
  baseUrl: string;
  /** 对外展示地址（敏感信息已打码） */
  displayBaseUrl: string;
}

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
  /** 上传文件元数据（按别名）；脚本据此判断文件数量 */
  files: Record<string, FileMeta[]>;
  /** DB 静态参数配置副本（可作为声明返回的起点） */
  baseParams: RuntimeParam[];
  /** 本次触发构建的 HTTP 请求快照（敏感头已剥离） */
  request: BuildRequestInfo;
  /** 本次执行解析到的提供商实例快照（可按 type / config 分支） */
  provider: BuildProviderInfo;
  /** 新增节点；节点 ID 已存在时抛错。返回节点实例；title 可选，一并设置 _meta.title；inputs 允许未在 object_info 声明的动态 key（如 'resize_type.width'） */
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
  /** 媒体参数：取 files[alias][fileIndex]，缺省 0 */
  fileIndex?: number;
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

/** HTTP 请求快照与提供商快照的 d.ts 声明（前端 Monaco 注册） */
export const BUILD_CONTEXT_EXTRA_DTS = `/** 触发本次构建的 HTTP 请求快照（Authorization / Cookie 等敏感头已剥离） */
declare interface BuildRequestInfo {
  /** HTTP 方法（如 GET / POST） */
  method: string;
  /** 路径（不含 query） */
  path: string;
  /** 原始 URL（含 query） */
  originalUrl: string;
  /** query 参数（仅字符串 / 字符串数组） */
  query: Record<string, string | string[]>;
  /** 请求头（键已小写；敏感头已剥离） */
  headers: Record<string, string | string[]>;
  /** 客户端 IP；无法解析时为 null */
  ip: string | null;
  /** 协议 http / https */
  protocol: string;
  /** 主机名 */
  hostname: string;
  /** Content-Type；缺失时为 null */
  contentType: string | null;
}

/** 执行提供商类型 */
declare type ProviderType = 'comfyui' | 'runninghub';

/**
 * 提供商实例配置（按类型区分）。
 * - comfyui: { baseUrl, autoCleanup?, inputDir? }
 * - runninghub: { apiKey, gpuSize }
 */
declare type ProviderConfig =
  | { baseUrl: string; autoCleanup?: boolean; inputDir?: string }
  | { apiKey: string; gpuSize: '24G' | '48G' };

/** 本次执行解析到的提供商实例快照 */
declare interface BuildProviderInfo {
  /** 实例 ID */
  id: string;
  /** 展示名 */
  name: string;
  /** 提供商类型 */
  type: ProviderType;
  /** 并发上限 */
  concurrency: number;
  /** 任务跟踪模式 */
  trackingMode: 'websocket' | 'polling';
  /** 类型化配置（按 type 区分；runninghub 含明文 apiKey，仅脚本可见） */
  config: ProviderConfig;
  /** 解析后的执行地址（含完整凭据，仅脚本可见） */
  baseUrl: string;
  /** 对外展示地址（敏感信息已打码） */
  displayBaseUrl: string;
}
`;

/** 静态版 BuildContext 声明（classType: string） */
const STATIC_BUILD_CONTEXT_DTS = buildBuildContextDts(
  'addNode(nodeId: string, classType: string, inputs?: Record<string, unknown>, title?: string): ComfyNode;',
  'findNodesByClass(classType: string): string[];',
);

/**
 * 静态版（ComfyUI 未配置/不可达时降级）脚本 API 类型声明文本。
 * 由 GET /api/workflows/build-api.d.ts 下发，前端 addExtraLib 注册。
 * 注：与旧版硬编码文本相比，去除了开头的多余换行，消费方均以子串断言，无影响。
 */
export const BUILD_SCRIPT_API_DTS = `${BUILD_SCRIPT_DTS_HEADER}
${RUNTIME_PARAM_DTS}
${BUILD_RESULT_DTS}
${BUILD_CONTEXT_EXTRA_DTS}
${STATIC_BUILD_CONTEXT_DTS}`;

/**
 * 编辑器"默认导出模板"片段：一键插入到脚本中。
 */
export const DEFAULT_BUILD_SCRIPT_TEMPLATE = `export default async function build(ctx: BuildContext): Promise<BuildResult> {
  const { workflow, params, files, baseParams, request, provider } = ctx;
  // 在这里根据 params / files / request / provider 动态调整工作流与参数配置。
  // 示例：按提供商类型分支
  // if (provider.type === 'runninghub') { /* RunningHub 专用节点 */ }
  // 示例：按上传文件数量动态建节点
  // const count = (files.ref_images ?? []).length;
  // for (let i = 0; i < count; i++) {
  //   const nodeId = 'load_' + i;
  //   ctx.addNode(nodeId, 'LoadImage', { image: '' });
  //   baseParams.push({ nodeId, fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: i });
  // }
  return { workflow, params: baseParams };
}
`;
