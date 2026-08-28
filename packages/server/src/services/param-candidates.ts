/**
 * 工作流参数候选项（candidates）规范化工具。
 * 静态参数（workflow_params）与动态字段声明（declaredParams）共用：
 * - 每个候选项为 { label, value } 结构：label 为表单展示名，value 为实际提交值；
 * - 候选项仅对 text 类型字段生效，其余类型一律忽略；
 * - 多选仅在配置了候选项时生效，多选值由调用方以英文逗号 "," 拼接（拼接的是 value）；
 * - 兼容旧版纯字符串格式：字符串项按 label = value 处理。
 */

/**
 * 候选项结构（label 展示用；value 提交用）
 */
export interface CandidateOption {
  /** 展示名（空时回退为 value） */
  label: string;
  /** 提交值（非空；多选拼接时使用） */
  value: string;
}

/**
 * 规范化单个候选项（未知来源 → 结构化候选项）
 * @param item 原始候选项
 * @returns 规范化后的候选项；value 为空等非法项返回 null（调用方跳过）
 */
function normalizeCandidateItem(item: unknown): CandidateOption | null {
  // 旧版纯字符串格式：label = value
  if (typeof item === 'string') {
    const trimmed = item.trim();
    return trimmed === '' ? null : { label: trimmed, value: trimmed };
  }
  // 结构化格式：{ label?, value }
  if (typeof item === 'object' && item !== null) {
    const raw = item as { label?: unknown; value?: unknown };
    // value 必须为非空字符串；其余类型视为非法项跳过
    if (typeof raw.value !== 'string') return null;
    const value = raw.value.trim();
    if (value === '') return null;
    // label 可选；空/非字符串回退为 value
    const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : value;
    return { label, value };
  }
  // 数字/布尔等其他类型视为非法项跳过
  return null;
}

/**
 * 规范化候选项输入（来自 HTTP body 等未知来源）：
 * 逐项规范化（字符串按 label=value、对象按 {label?, value}），空 value 项跳过，并按 value 去重（保留首次出现）。
 * @param raw 原始候选项输入
 * @returns 规范化后的候选项数组；输入为 null/undefined 时返回空数组；
 *          非数组时返回 null（表示校验失败，调用方应报 missing_parameter）
 */
export function normalizeCandidates(raw: unknown): CandidateOption[] | null {
  // 未提供时视为未配置
  if (raw === undefined || raw === null) return [];
  // 必须是数组
  if (!Array.isArray(raw)) return null;
  const out: CandidateOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const option = normalizeCandidateItem(item);
    // 非法项跳过（旧版语义：空串跳过）
    if (option === null) continue;
    // value 去重，保留首次出现
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    out.push(option);
  }
  return out;
}

/**
 * 解析数据库存储的候选项 JSON 字符串为结构化数组（读取展示用；损坏时回退空数组）。
 * @param raw 数据库中的 JSON 字符串（如 '[{"label":"写实","value":"realism"}]'）
 * @returns 结构化候选项数组；解析失败时返回空数组（容忍个别脏数据项）
 */
export function parseCandidatesJson(raw: string | null | undefined): CandidateOption[] {
  if (raw == null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CandidateOption[] = [];
    for (const item of parsed) {
      const option = normalizeCandidateItem(item);
      if (option !== null) out.push(option);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 计算候选项/多选的最终存储值：
 * 仅 text 类型生效；候选为空时强制单选（multiple=false）。
 * @param paramType 规范化后的参数类型
 * @param input 输入的候选项与多选标记
 * @returns 最终存储值（candidates 为待 JSON 序列化的结构化数组；multiple 为 0/1 形态的布尔）
 */
export function resolveEffectiveCandidates(
  paramType: string,
  input: { candidates?: CandidateOption[]; multiple?: boolean },
): { candidates: CandidateOption[]; multiple: boolean } {
  // 仅 text 类型支持候选项，其余类型一律清空
  const candidates = paramType === 'text' ? (input.candidates ?? []) : [];
  // 无候选项时多选无意义，强制单选
  const multiple = paramType === 'text' && candidates.length > 0 && input.multiple === true;
  return { candidates, multiple };
}
