import type { ExecutionProvider } from './providers/types';

/**
 * 清理触发场景。
 * - terminal: 任务到达终态（成功/失败）后的常规清理，必须遵循 provider 的 autoCleanup 开关
 * - preview: 预览构建（/build/simulate）产生的上传文件（从无 prompt 提交，必然无人引用），忽略开关立即清理
 */
export type CleanupReason = 'terminal' | 'preview';

/**
 * 解析任务记录中持久化的上传文件名字符串（JSON 数组）。
 * 解析失败或非数组时返回空数组（软失败，不抛错）。
 * @param json 任务 uploadedFiles 字段的 JSON 字符串
 * @returns 文件名字符串数组
 */
export function parseUploadedFiles(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // uploadedFiles 损坏时视为无文件，避免清理流程崩溃
    return [];
  }
}

/**
 * 触发执行提供商清理任务的上传资产（fire-and-forget）。
 * 仅在提供商实现了 cleanupUploadedFiles 且任务确有上传文件时执行；
 * 执行路径必须遵循 provider 的自动清理开关（getAutoCleanup 不为 true 时直接跳过，不产生任何删除），
 * 预览产物（reason='preview'）忽略开关立即清理。清理过程不阻塞调用方，异常仅记录日志。
 * @param provider 任务使用的执行提供商
 * @param uploadedFilesJson 任务 uploadedFiles 字段的 JSON 字符串
 * @param reason 清理触发场景，默认 'terminal'
 */
export function cleanupTaskUploads(
  provider: ExecutionProvider,
  uploadedFilesJson: string | null | undefined,
  reason: CleanupReason = 'terminal',
): void {
  // 提供商未实现清理能力（如 RunningHub / group）时直接跳过
  if (typeof provider.cleanupUploadedFiles !== 'function') return;
  // 预览产物必然无人引用；其余场景一律遵循提供商开关，关闭时绝不删除
  if (reason !== 'preview' && provider.getAutoCleanup?.() !== true) return;
  const filenames = parseUploadedFiles(uploadedFilesJson);
  if (filenames.length === 0) return;
  provider.cleanupUploadedFiles(filenames).catch((err: unknown) => {
    // 清理失败不应影响任务结果，仅记录日志
    console.error(`[Cleanup:${provider.id}] cleanup uploaded files failed`, err);
  });
}
