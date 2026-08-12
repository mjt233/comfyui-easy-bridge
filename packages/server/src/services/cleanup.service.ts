import type { ExecutionProvider } from './providers/types';

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
 * 清理过程不阻塞调用方，异常仅记录日志。
 * @param provider 任务使用的执行提供商
 * @param uploadedFilesJson 任务 uploadedFiles 字段的 JSON 字符串
 */
export function cleanupTaskUploads(provider: ExecutionProvider, uploadedFilesJson: string | null | undefined): void {
  // 提供商未实现清理能力（如 RunningHub）时直接跳过
  if (typeof provider.cleanupUploadedFiles !== 'function') return;
  const filenames = parseUploadedFiles(uploadedFilesJson);
  if (filenames.length === 0) return;
  provider.cleanupUploadedFiles(filenames).catch((err: unknown) => {
    // 清理失败不应影响任务结果，仅记录日志
    console.error(`[Cleanup:${provider.id}] cleanup uploaded files failed`, err);
  });
}
