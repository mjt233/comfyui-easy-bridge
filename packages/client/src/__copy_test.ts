/**
 * 将 rawJson 解析为 vue-flow 可渲染的 nodes/edges，并使用 dagre 做 LR 方向自动布局。
 * 布局常量在此集中定义，WorkflowNode 复用同一套常量以保证 Handle 与行对齐。
 */
import { ref, watch, type Ref } from 'vue';
import dagre from '@dagrejs/dagre';
import { MarkerType, type Edge, type EdgeMarkerType, type Node } from '@vue-flow/core';
import { parseWorkflowGraph, type GraphEdge, type GraphInput, type GraphNode } from './components/workflow-canvas/workflowGraph';

/** 自定义节点传入的数据 */
export type WorkflowNodeData = {
  /** 节点 ID */
  nodeId: string;
  /** 节点标题 */
  title: string;
  /** class_type */
  classType: string;
  /** 输入列表 */
  inputs: GraphInput[];
  /** 输出槽索引 */
  outputSlots: number[];
};

/**
 * 画布节点对象（命名接口）。
 * 若让 TS 推断临时对象类型再赋值给 vue-flow 的 Node，会触发 TS2589 深层实例化，
 * 因此用命名接口标注 map 返回类型。
 */
interface FlowNode {
  /** 节点 ID */
  id: string;
  /** 节点类型（对应 nodeTypes 映射的 'comfy'） */
  type: string;
  /** 画布坐标 */
  position: { x: number; y: number };
  /** 固定宽度（px） */
  width: number;
  /** 节点数据 */
  data: WorkflowNodeData;
}

/**
 * dagre 布局后的节点标签（含坐标）。
 * graphlib 的 Graph 泛型默认 NodeLabel = any，直接使用会让节点对象带 any 值，
 * 从而触发 vue-flow Node 类型检查的 TS2589 深层实例化，因此显式标注具体类型。
 */
interface LayoutNode {
  /** 中心点 X 坐标 */
  x?: number;
  /** 中心点 Y 坐标 */
  y?: number;
  /** 节点高度 */
  height?: number;
  /** 节点宽度 */
  width?: number;
}

/** 节点固定宽度（px） */
export const NODE_WIDTH = 240;
/** 节点输入/输出行高（px） */
export const ROW_HEIGHT = 26;
/** 节点头部高度（px，标题 + 副标题） */
export const HEADER_HEIGHT = 58;
/** 节点主体上下内边距（px） */
export const BODY_PAD = 4;
/** 节点边框宽度（px） */
export const NODE_BORDER = 1;
/** 同层节点水平间距 */
const NODE_SEP = 30;
/** 相邻层垂直间距 */
const RANK_SEP = 90;

/**
 * 估算节点总高度（dagre 布局用；与 WorkflowNode 渲染高度保持一致）
 * @param node 图节点
 * @returns 估算高度（px）
 */
export function estimateNodeHeight(node: Pick<GraphNode, 'inputs' | 'outputSlots'>): number {
  const rows = Math.max(node.inputs.length, node.outputSlots.length, 1);
  return NODE_BORDER * 2 + HEADER_HEIGHT + BODY_PAD * 2 + rows * ROW_HEIGHT;
}

/**
 * 将图节点与 dagre 布局坐标组装为 vue-flow 节点。
 * 独立成函数：避免在 map 回调内联构造对象时，因 dagre 的 any 值触发
 * vue-flow Node 类型检查的 TS2589 深层实例化。
 * @param node 图节点
 * @param pos dagre 布局结果（中心点坐标）
 * @param width 节点宽度
 * @param height 节点高度
 * @returns vue-flow 节点
 */
function createFlowNode(
  node: GraphNode,
  pos: LayoutNode | undefined,
  width: number,
  height: number,
): FlowNode {
  const x = pos?.x ?? 0;
  const y = pos?.y ?? 0;
  return {
    id: node.id,
    type: 'comfy',
    position: { x: x - width / 2, y: y - height / 2 },
    width,
    data: {
      nodeId: node.id,
      title: node.title,
      classType: node.classType,
      inputs: node.inputs,
      outputSlots: node.outputSlots,
    },
  };
}

/**
 * 画布边对象（命名接口）。
 * 与 FlowNode 同理：避免内联推断类型赋值给 vue-flow 的 Edge 触发 TS2589。
 */
interface FlowEdge {
  /** 边唯一 ID */
  id: string;
  /** 源节点 ID */
  source: string;
  /** 源 Handle */
  sourceHandle: string;
  /** 目标节点 ID */
  target: string;
  /** 目标 Handle */
  targetHandle: string;
  /** 边类型（smoothstep） */
  type: string;
  /** 箭头 */
  markerEnd: EdgeMarkerType;
  /** 边样式 */
  style: { stroke: string; strokeWidth: number };
}

/**
 * 将图边组装为 vue-flow 边（独立函数，避免 TS2589 深层实例化）
 * @param edge 图边
 * @returns vue-flow 边
 */
function createFlowEdge(edge: GraphEdge): FlowEdge {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
    type: 'smoothstep',
    markerEnd: MarkerType.ArrowClosed,
    style: { stroke: '#64748b', strokeWidth: 1.5 },
  };
}

/**
 * 将 rawJson 解析为 vue-flow 可渲染的 nodes/edges，并使用 dagre 自动布局。
 * @param rawJson 工作流原始 JSON（响应式引用）
 * @returns 画布所需响应式状态
 */
export function useWorkflowGraph(rawJson: Ref<string>) {
  /** vue-flow 节点列表 */
  const nodes = ref<Node[]>([]);
  /** 解析错误信息（空串表示无错误） */
  const parseError = ref('');
  /** 是否为空图 */
  const isEmpty = ref(false);

  /** 解析 + dagre 布局并写入响应式状态 */
  function build(): void {
    const data = parseWorkflowGraph(rawJson.value);
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'LR' });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of data.nodes) {
      graph.setNode(node.id, { width: 240, height: 100 });
    }
    dagre.layout(graph);

    nodes.value = data.nodes.map((node) =>
      createFlowNode(node, graph.node(node.id) as LayoutNode | undefined, 240, 100),
    );
  }

  watch(rawJson, build, { immediate: true });

  return { nodes, parseError, isEmpty };
}
