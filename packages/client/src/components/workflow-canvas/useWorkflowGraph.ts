/**
 * 将 rawJson 解析为 vue-flow 可渲染的 nodes/edges，并使用 dagre 做 LR 方向自动布局。
 * 布局常量在此集中定义，WorkflowNode 复用同一套常量以保证 Handle 与行对齐。
 */
import { ref, watch, type Ref } from 'vue';
import dagre from '@dagrejs/dagre';
import { MarkerType, type EdgeMarkerType } from '@vue-flow/core';
import { parseWorkflowGraph, type GraphEdge, type GraphInput, type GraphNode } from './workflowGraph';

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

/** 组节点配色 */
export type WorkflowGroupColor = {
  /** 背景色 */
  background: string;
  /** 边框色 */
  border: string;
  /** 标签文字色 */
  text: string;
};

/** 组节点数据（节点 ID 前缀相同的成员节点归为一组） */
export type WorkflowGroupData = {
  /** 组 ID（节点 ID 冒号前的部分） */
  groupId: string;
  /** 组标题（默认与组 ID 相同） */
  title: string;
  /** 组配色 */
  color: WorkflowGroupColor;
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
  /** 画布坐标（属于某个组时为相对组节点的坐标） */
  position: { x: number; y: number };
  /** 节点宽度（px） */
  width: number;
  /** 估算的渲染高度（px，用于组包围盒计算） */
  height: number;
  /** 所属组节点 ID（节点 ID 带 `aaaa:` 前缀时设置） */
  parentNode?: string;
  /** 位置约束范围（'parent' = 约束在组节点范围内） */
  extent?: string;
  /** 节点数据 */
  data: WorkflowNodeData;
}

/**
 * 组节点对象（背景矩形，置于所有成员节点/边之下）。
 * 与 FlowNode 同理：用命名接口避免 vue-flow Node 类型触发 TS2589。
 */
interface FlowGroupNode {
  /** 组节点 ID（`group-<组前缀>`） */
  id: string;
  /** 节点类型（对应 nodeTypes 映射的 'group'） */
  type: string;
  /** 组矩形左上角坐标 */
  position: { x: number; y: number };
  /** 组宽度（px） */
  width: number;
  /** 组高度（px） */
  height: number;
  /** 组矩形样式（显式宽高，保证渲染尺寸与布局一致） */
  style: { width: string; height: string };
  /** 禁止选中 */
  selectable: boolean;
  /** 禁止拖动 */
  draggable: boolean;
  /** 禁止连线 */
  connectable: boolean;
  /** 置于底层（低于成员节点与连线） */
  zIndex: number;
  /** 组节点数据 */
  data: WorkflowGroupData;
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
/** 节点布局占位高度（px，仅用于 dagre 中心点换算，渲染高度以 estimateNodeHeight 为准） */
const LAYOUT_HEIGHT = 100;
/** 组内边距（px，节点与组边框之间的留白） */
const GROUP_PAD = 36;
/** 组矩形之间的最小间距（px） */
const GROUP_GAP = 16;
/** 组配色表（按组首次出现顺序循环取用） */
const GROUP_PALETTE: WorkflowGroupColor[] = [
  { background: 'rgba(21, 101, 192, 0.08)', border: 'rgba(21, 101, 192, 0.45)', text: '#1565C0' },
  { background: 'rgba(46, 125, 50, 0.08)', border: 'rgba(46, 125, 50, 0.45)', text: '#2E7D32' },
  { background: 'rgba(230, 81, 0, 0.08)', border: 'rgba(230, 81, 0, 0.45)', text: '#E65100' },
  { background: 'rgba(106, 27, 154, 0.08)', border: 'rgba(106, 27, 154, 0.45)', text: '#6A1B9A' },
  { background: 'rgba(0, 131, 143, 0.08)', border: 'rgba(0, 131, 143, 0.45)', text: '#00838F' },
  { background: 'rgba(198, 40, 40, 0.08)', border: 'rgba(198, 40, 40, 0.45)', text: '#C62828' },
];

/**
 * 估算节点总高度（dagre 布局与组包围盒计算用；与 WorkflowNode 渲染高度保持一致）。
 * 渲染高度 = 边框 ×2 + 头部 + 主体内边距 ×2 + (输入行数 + 输出行数) × 行高
 * @param node 图节点
 * @returns 估算高度（px）
 */
export function estimateNodeHeight(node: Pick<GraphNode, 'inputs' | 'outputSlots'>): number {
  const rows = node.inputs.length + node.outputSlots.length;
  return NODE_BORDER * 2 + HEADER_HEIGHT + BODY_PAD * 2 + rows * ROW_HEIGHT;
}

/**
 * 将图节点与 dagre 布局坐标组装为 vue-flow 节点。
 * 独立成函数：避免在 map 回调内联构造对象时，因 dagre 的 any 值触发
 * vue-flow Node 类型检查的 TS2589 深层实例化。
 * @param node 图节点
 * @param pos dagre 布局结果（中心点坐标）
 * @returns vue-flow 节点
 */
function createFlowNode(node: GraphNode, pos: LayoutNode | undefined): FlowNode {
  const x = pos?.x ?? 0;
  const y = pos?.y ?? 0;
  return {
    id: node.id,
    type: 'comfy',
    position: { x: x - NODE_WIDTH / 2, y: y - LAYOUT_HEIGHT / 2 },
    width: NODE_WIDTH,
    height: estimateNodeHeight(node),
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
 * 从节点 ID 提取组前缀（`aaaa:bbbb` 格式取冒号前的 `aaaa`）。
 * 冒号缺失或位于首尾时返回 null，表示该节点不属于任何组。
 * @param nodeId 节点 ID
 * @returns 组前缀；无组时为 null
 */
function extractGroupId(nodeId: string): string | null {
  const idx = nodeId.indexOf(':');
  if (idx <= 0 || idx === nodeId.length - 1) return null;
  return nodeId.slice(0, idx);
}

/** 组矩形（成员包围盒外扩 GROUP_PAD） */
interface GroupRect {
  /** 左上角 X 坐标（px） */
  x: number;
  /** 左上角 Y 坐标（px） */
  y: number;
  /** 宽度（px） */
  width: number;
  /** 高度（px） */
  height: number;
}

/**
 * 计算每个组的矩形：成员节点包围盒外扩 GROUP_PAD。
 * @param groups 组 ID → 成员节点列表
 * @returns 组 ID → 组矩形
 */
function computeGroupRects(groups: Map<string, FlowNode[]>): Map<string, GroupRect> {
  const rects = new Map<string, GroupRect>();
  groups.forEach((group, gid) => {
    // 计算成员节点包围盒（member.position 为左上角坐标）
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const member of group) {
      minX = Math.min(minX, member.position.x);
      minY = Math.min(minY, member.position.y);
      maxX = Math.max(maxX, member.position.x + member.width);
      maxY = Math.max(maxY, member.position.y + member.height);
    }
    rects.set(gid, {
      x: minX - GROUP_PAD,
      y: minY - GROUP_PAD,
      width: maxX - minX + GROUP_PAD * 2,
      height: maxY - minY + GROUP_PAD * 2,
    });
  });
  return rects;
}

/**
 * 将组矩形整体平移 dx/dy，并同步平移成员节点坐标，保持成员相对位置不变。
 * @param rects 组矩形表
 * @param groups 组 ID → 成员节点列表
 * @param gid 组 ID
 * @param dx X 方向位移（px）
 * @param dy Y 方向位移（px）
 */
function translateGroup(
  rects: Map<string, GroupRect>,
  groups: Map<string, FlowNode[]>,
  gid: string,
  dx: number,
  dy: number,
): void {
  const rect = rects.get(gid);
  if (!rect) return;
  rect.x += dx;
  rect.y += dy;
  for (const member of groups.get(gid) ?? []) {
    member.position = { x: member.position.x + dx, y: member.position.y + dy };
  }
}

/**
 * 将相互重叠或间距过近的组矩形（连同成员节点）推开，直到满足最小间距。
 * dagre compound 布局已让各簇基本分离，此函数兜底处理剩余重叠
 * （如相邻簇因组内边距产生的轻微交叠）并保证组间留白。
 * @param rects 组矩形表（会被就地修改）
 * @param groups 组 ID → 成员节点列表（成员坐标会被同步平移）
 */
function resolveGroupOverlaps(
  rects: Map<string, GroupRect>,
  groups: Map<string, FlowNode[]>,
): void {
  const gids = [...rects.keys()];
  // 迭代推开间距不足的组对；正常布局 1~2 轮即可收敛，上限仅作极端输入的安全兜底
  for (let pass = 0; pass < 30; pass++) {
    let moved = false;
    for (let i = 0; i < gids.length; i++) {
      for (let j = i + 1; j < gids.length; j++) {
        const a = rects.get(gids[i])!;
        const b = rects.get(gids[j])!;
        // 两矩形在 X/Y 轴上的间距（负值表示该轴重叠）
        const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
        const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
        // 至少一个轴已满足最小间距 → 无需处理
        if (gapX >= GROUP_GAP || gapY >= GROUP_GAP) continue;
        // 沿需要拉开量更小的轴推动，使总位移最小；需要量相同时优先纵向
        const needX = GROUP_GAP - gapX;
        const needY = GROUP_GAP - gapY;
        if (needY <= needX) {
          // 依据 b 相对 a 的中心位置决定推离方向（向下或向上）
          const dirY = b.y + b.height / 2 >= a.y + a.height / 2 ? 1 : -1;
          translateGroup(rects, groups, gids[j], 0, dirY * (needY + 1));
        } else {
          const dirX = b.x + b.width / 2 >= a.x + a.width / 2 ? 1 : -1;
          translateGroup(rects, groups, gids[j], dirX * (needX + 1), 0);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/**
 * 按节点 ID 前缀将成员节点分组，为每个组生成一个置于底层的背景组节点。
 * - 组矩形为成员节点包围盒外扩 GROUP_PAD，重叠的组会被推开
 * - 成员节点坐标改为相对组节点的坐标，并约束在组内（extent: 'parent'）
 * - 组节点 zIndex 设为 -1，使其渲染在所有成员节点与连线之下
 * @param members 已完成 dagre 布局的成员节点列表
 * @returns 组节点列表
 */
function buildGroupNodes(members: FlowNode[]): FlowGroupNode[] {
  // 按组 ID 收集成员节点（保持节点首次出现顺序）
  const groups = new Map<string, FlowNode[]>();
  for (const node of members) {
    const gid = extractGroupId(node.id);
    if (gid === null) continue;
    const list = groups.get(gid) ?? [];
    list.push(node);
    groups.set(gid, list);
  }

  // 计算各组矩形，并推开相互重叠的组（同步移动成员节点）
  const rects = computeGroupRects(groups);
  resolveGroupOverlaps(rects, groups);

  const groupNodes: FlowGroupNode[] = [];
  const colorIndexes = new Map<string, number>();
  rects.forEach((rect, gid) => {
    // 按组首次出现顺序循环取用调色板
    const colorIndex = colorIndexes.size % GROUP_PALETTE.length;
    colorIndexes.set(gid, colorIndex);
    const groupId = `group-${gid}`;
    groupNodes.push({
      id: groupId,
      type: 'group',
      position: { x: rect.x, y: rect.y },
      width: rect.width,
      height: rect.height,
      style: { width: `${rect.width}px`, height: `${rect.height}px` },
      selectable: false,
      draggable: false,
      connectable: false,
      zIndex: -1,
      data: { groupId: gid, title: gid, color: GROUP_PALETTE[colorIndex] },
    });

    // 成员节点坐标改为相对组节点，并约束在组内
    for (const member of groups.get(gid) ?? []) {
      member.position = { x: member.position.x - rect.x, y: member.position.y - rect.y };
      member.parentNode = groupId;
      member.extent = 'parent';
    }
  });

  return groupNodes;
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
  /** 边类型（default = vue-flow 内置 BezierEdge 贝塞尔曲线） */
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
    type: 'default',
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
  /**
   * 画布节点/边列表，使用自定义命名类型（FlowNode/FlowEdge）。
   * 注意：不能直接标注为 vue-flow 的 Node/Edge 类型——vue-flow 1.48 的
   * Node/Edge 类型含相互递归定义，在 TS 5.9 下对包含 data 对象的节点赋值
   * 会触发 TS2589（深层实例化）。vue-flow 类型转换统一在 WorkflowCanvas 边界完成。
   */
  const nodes = ref<(FlowNode | FlowGroupNode)[]>([]);
  /** vue-flow 边列表 */
  const edges = ref<FlowEdge[]>([]);
  /** 解析错误信息（空串表示无错误） */
  const parseError = ref('');
  /** 是否为空图 */
  const isEmpty = ref(false);

  /** 解析 + dagre 布局并写入响应式状态 */
  function build(): void {
    const data = parseWorkflowGraph(rawJson.value);
    parseError.value = data.ok ? '' : '无法解析工作流 JSON，请检查原始数据';
    isEmpty.value = data.ok && data.nodes.length === 0;
    if (!data.ok) {
      nodes.value = [];
      edges.value = [];
      return;
    }

    // dagre 有向图布局（LR：源节点在左、下游在右）。
    // 使用 compound 图：节点 ID 带 `aaaa:` 前缀的成员挂到对应簇下，
    // 让 dagre 将每个组视为独立簇分别布局，避免组矩形互相重叠。
    const graph = new dagre.graphlib.Graph({ compound: true });
    graph.setGraph({
      rankdir: 'LR',
      ranksep: RANK_SEP,
      nodesep: NODE_SEP,
      marginx: 20,
      marginy: 20,
    });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of data.nodes) {
      graph.setNode(node.id, { width: NODE_WIDTH, height: estimateNodeHeight(node) });
      const gid = extractGroupId(node.id);
      if (gid === null) continue;
      const clusterId = `cluster-${gid}`;
      // 防止簇节点 ID 与真实节点 ID 冲突（冲突时该组不参与簇布局）
      if (data.nodes.some((n) => n.id === clusterId)) continue;
      graph.setParent(node.id, clusterId);
    }
    for (const edge of data.edges) {
      graph.setEdge(edge.source, edge.target);
    }
    dagre.layout(graph);

    // 组装 vue-flow 成员节点（中心点坐标 → 左上角坐标）
    const memberNodes = data.nodes.map((node) =>
      createFlowNode(node, graph.node(node.id) as LayoutNode | undefined),
    );

    // 按节点 ID 前缀分组，为每个组生成置于底层的背景组节点
    const groupNodes = buildGroupNodes(memberNodes);

    nodes.value = [...groupNodes, ...memberNodes];

    // 组装 vue-flow 边
    edges.value = data.edges.map((edge) => createFlowEdge(edge));
  }

  watch(rawJson, build, { immediate: true });

  return { nodes, edges, parseError, isEmpty };
}
