/**
 * 动态构建脚本 API：编辑器类型声明（d.ts 文本）的单一事实来源。
 * 运行时辅助函数实现在 build.worker.ts 内（随 worker 源码字符串下发执行），
 * 其行为必须与本文件导出的类型声明保持一致，由 build.service.test.ts 锁定。
 */

/** ComfyUI API 工作流节点 */
export interface ComfyNode {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: { title?: string };
}

/** ComfyUI API 工作流（节点 ID → 节点） */
export type ComfyWorkflow = Record<string, ComfyNode>;

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
 * 注：与旧版硬编码文本相比，去除了开头的多余换行，消费方均以子串断言，无影响。
 */
export const BUILD_SCRIPT_API_DTS = `${BUILD_SCRIPT_DTS_HEADER}
${buildBuildContextDts(
  'addNode(nodeId: string, classType: string, inputs?: Record<string, unknown>): void;',
  'findNodesByClass(classType: string): string[];',
)}`;

/**
 * 编辑器"默认导出模板"片段：一键插入到脚本中。
 */
export const DEFAULT_BUILD_SCRIPT_TEMPLATE = `export default async function build(ctx: BuildContext): Promise<ComfyWorkflow> {
  const { workflow, params } = ctx;
  // 在这里根据 params 动态调整工作流。
  // 示例：
  // if (params.mode === 'upscale') {
  //   ctx.addNode('9', 'UpscaleModelLoader', { model_name: '4x-UltraSharp.pth' });
  //   ctx.connect('9', 0, '4', 'model');
  // }
  return workflow;
}
`;
