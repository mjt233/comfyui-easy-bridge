/**
 * 动态构建脚本 API：编辑器类型声明（d.ts 文本）的单一事实来源。
 * 运行时辅助函数实现在 build.worker.ts 内（随 worker 源码字符串下发执行），
 * 其行为必须与本文件导出的类型声明保持一致，由 build.service.test.ts 锁定。
 */

// FileMeta 仅出现在下方 d.ts 模板字符串内（非真实 TS 类型位置），导入会触发 noUnusedLocals（TS6196），故只导入 RuntimeParam
import type { RuntimeParam } from './param.types';

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

/** 静态版 BuildContext 声明（classType: string） */
const STATIC_BUILD_CONTEXT_DTS = buildBuildContextDts(
  'addNode(nodeId: string, classType: string, inputs?: Record<string, unknown>): void;',
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
${STATIC_BUILD_CONTEXT_DTS}`;

/**
 * 编辑器"默认导出模板"片段：一键插入到脚本中。
 */
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
