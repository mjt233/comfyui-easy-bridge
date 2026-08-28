/**
 * v-combobox 候选项负载规范化工具。
 * 背景：Vuetify 的 VCombobox 与 VSelect 不同，`returnObject` 默认为 true，
 * 选中对象型候选项（{title, value}）时更新事件可能携带整个对象；
 * 表单内必须始终保存字符串（候选项 value 或自由输入文本），否则渲染为 [object Object]。
 */

/**
 * 将 combobox 更新事件负载规范化为字符串：
 * 自由输入为纯字符串原样保留；对象负载（{title, value}）提取 value（其次 title）。
 * @param v combobox 更新负载（string / 对象 / 其他）
 * @returns 规范化后的提交值字符串
 */
export function toCandidateString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object') {
    const raw = v as { value?: unknown; title?: unknown };
    if (typeof raw.value === 'string') return raw.value;
    if (typeof raw.title === 'string') return raw.title;
  }
  return String(v ?? '');
}

/**
 * 将多选 combobox 更新事件负载规范化为字符串数组（逐项经 toCandidateString 处理）
 * @param v combobox 更新负载（数组或单值）
 * @returns 规范化后的提交值数组
 */
export function toCandidateStringArray(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [v];
  return list.map(toCandidateString);
}
