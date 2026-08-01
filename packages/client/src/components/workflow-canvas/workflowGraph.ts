/**
 * ComfyUI 工作流 JSON → 节点/边图数据的纯解析模块。
 *
 * rawJson 结构（ComfyUI 标准导出格式）：
 * ```
 * {
 *   "<nodeId>": {
 *     "inputs": {
 *       "<fieldName>": <值> | ["<sourceNodeId>", <sourceSlot>],  // 数组即连线引用
 *       ...
 *     },
 *     "class_type": "KSampler",
 *     "_meta": { "title": "K采样器" }
 *   }
 * }
 * ```
 * 注意：该格式不包含节点坐标，节点位置由 dagre 在 useWorkflowGraph 中自动计算。
 */

/** 节点输入项 */
export interface GraphInput {
  /** 字段名 */
  name: string;
  /** 展示值（字符串化）；连线输入为 null */
  displayValue: string | null;
  /** 是否为连线输入（数组引用 [nodeId, slot]） */
  connected: boolean;
  /** 连线源节点 ID；非连线输入为 null */
  source: string | null;
  /** 连线源输出槽索引；非连线输入为 null */
  sourceSlot: number | null;
}

/** 图节点（供画布渲染） */
export interface GraphNode {
  /** 节点 ID（rawJson 键） */
  id: string;
  /** 节点标题（_meta.title，缺省回退为节点 ID） */
  title: string;
  /** 节点类型 class_type */
  classType: string;
  /** 输入列表（含连线输入与普通输入，保持原始顺序） */
  inputs: GraphInput[];
  /** 被其他节点引用到的输出槽索引（升序；无节点定义时仅能按引用推断） */
  outputSlots: number[];
}

/** 图边（一条连线） */
export interface GraphEdge {
  /** 边唯一 ID */
  id: string;
  /** 源节点 ID */
  source: string;
  /** 源 Handle（out-<slot>） */
  sourceHandle: string;
  /** 目标节点 ID */
  target: string;
  /** 目标 Handle（in-<fieldName>） */
  targetHandle: string;
}

/** 解析结果 */
export interface WorkflowGraphData {
  /** 是否解析成功（JSON 合法且结构正确） */
  ok: boolean;
  /** 节点列表 */
  nodes: GraphNode[];
  /** 边列表 */
  edges: GraphEdge[];
}

/**
 * 判断值是否为 ComfyUI 连线引用（数组 [nodeId, slot, ...]）
 * @param value 输入值
 * @returns 是否为连线引用
 */
function isConnection(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number'
  );
}

/**
 * 将任意值安全字符串化用于展示
 * @param value 输入值
 * @returns 展示字符串
 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 解析 ComfyUI 工作流 JSON 为节点/边数据。
 * - 数组值 [nodeId, slot] 视为连线；源节点不存在时跳过该边（避免孤儿引用）
 * - 输出槽通过扫描所有连线引用推断（无节点定义信息时无法直接获得输出名）
 * - JSON 非法或结构不符时返回 ok=false 的空图
 * @param rawJson 工作流原始 JSON 字符串
 * @returns 解析结果
 */
export function parseWorkflowGraph(rawJson: string): WorkflowGraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // 解析 JSON，失败则返回空图
  let json: unknown;
  try {
    json = JSON.parse(rawJson);
  } catch {
    return { ok: false, nodes, edges };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, nodes, edges };
  }
  const record = json as Record<string, unknown>;

  // 第一遍：统计每个节点被引用的输出槽（仅统计源节点确实存在的引用）
  const outputRefs = new Map<string, Set<number>>();
  for (const raw of Object.values(record)) {
    const node = raw as Record<string, unknown>;
    if (typeof node !== 'object' || node === null) continue;
    const inputs = node.inputs as Record<string, unknown>;
    if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) continue;
    for (const value of Object.values(inputs)) {
      if (isConnection(value)) {
        const [sourceId, slot] = value;
        if (record[sourceId] !== undefined) {
          if (!outputRefs.has(sourceId)) outputRefs.set(sourceId, new Set());
          outputRefs.get(sourceId)!.add(slot);
        }
      }
    }
  }

  // 第二遍：组装节点与边
  for (const [id, raw] of Object.entries(record)) {
    const node = raw as Record<string, unknown>;
    if (typeof node !== 'object' || node === null) continue;

    const rawInputs = node.inputs;
    const inputs: Record<string, unknown> =
      typeof rawInputs === 'object' && rawInputs !== null && !Array.isArray(rawInputs)
        ? (rawInputs as Record<string, unknown>)
        : {};
    const rawMeta = node._meta;
    const meta =
      typeof rawMeta === 'object' && rawMeta !== null ? (rawMeta as Record<string, unknown>) : {};
    const title =
      typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title : id;
    const classType = typeof node.class_type === 'string' ? node.class_type : '';

    const graphInputs: GraphInput[] = [];
    for (const [name, value] of Object.entries(inputs)) {
      if (isConnection(value)) {
        const [sourceId, slot] = value;
        graphInputs.push({
          name,
          displayValue: null,
          connected: true,
          source: sourceId,
          sourceSlot: slot,
        });
        // 源节点存在才生成边，避免孤儿引用产生悬空连线
        if (record[sourceId] !== undefined) {
          edges.push({
            id: `e-${sourceId}-${slot}-${id}-${name}`,
            source: sourceId,
            sourceHandle: `out-${slot}`,
            target: id,
            targetHandle: `in-${name}`,
          });
        }
      } else {
        graphInputs.push({
          name,
          displayValue: stringifyValue(value),
          connected: false,
          source: null,
          sourceSlot: null,
        });
      }
    }

    nodes.push({
      id,
      title,
      classType,
      inputs: graphInputs,
      outputSlots: [...(outputRefs.get(id) ?? [])].sort((a, b) => a - b),
    });
  }

  return { ok: true, nodes, edges };
}
