import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UploadFileInput } from './providers/types';

/**
 * 待上传媒体文件元数据（持久化在任务的 originalForm.stagedFiles 中）。
 */
export interface StagedFileMeta {
  /** 参数别名（媒体参数注入用的 alias） */
  alias: string;
  /** 上传文件字段名（multipart fieldname） */
  fieldName: string;
  /** 服务端存储名（= 最终注入工作流的文件名） */
  stagedName: string;
  /** 用户上传的原始文件名 */
  originalname: string;
  /** MIME 类型 */
  mimetype: string;
  /** 文件字节数 */
  size: number;
  /** 媒体类型：决定上传到执行端的哪个端点 */
  paramType: 'image' | 'video' | 'audio';
}

/** 已读入内存的暂存文件（含其元数据） */
export interface StagedFileWithMeta {
  /** 文件元数据 */
  meta: StagedFileMeta;
  /** 文件内容 */
  file: UploadFileInput;
}

/** 暂存根目录名（位于 DATA_DIR 下） */
const STAGING_DIR_NAME = 'task-staging';

/**
 * 解析暂存根目录路径。
 * DATA_DIR 环境变量可覆盖（与数据库路径保持一致），便于测试隔离。
 * @returns 暂存根目录绝对路径
 */
export function getStagingRoot(): string {
  const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
  return path.join(dataDir, STAGING_DIR_NAME);
}

/**
 * 解析某任务的暂存目录路径。
 * @param taskId 任务 ID
 * @returns 任务暂存目录绝对路径
 */
export function getTaskStagingDir(taskId: string): string {
  // 任务 ID 为 randomUUID，不含路径分隔符；仍取 basename 防御异常输入
  return path.join(getStagingRoot(), path.basename(taskId));
}

/**
 * 将待上传媒体写入任务暂存目录。
 * 分组任务在排队期间尚未确定执行实例（各实例的文件存储相互独立），
 * 因此先把文件落到本地暂存目录，调度选定成员后再上传到该成员。
 * @param taskId 任务 ID
 * @param jobs 待写入的文件（已确定存储名与归属别名）
 */
export async function stageUploads(
  taskId: string,
  jobs: Array<{ meta: StagedFileMeta; buffer: Buffer }>,
): Promise<void> {
  if (jobs.length === 0) return;
  const dir = getTaskStagingDir(taskId);
  await fs.mkdir(dir, { recursive: true });
  for (const job of jobs) {
    // 存储名由 buildUniqueUploadFilename 生成（uuid + 扩展名），取 basename 防目录穿越
    await fs.writeFile(path.join(dir, path.basename(job.meta.stagedName)), job.buffer);
  }
}

/**
 * 读取一个暂存文件的完整内容。
 * @param taskId 任务 ID
 * @param stagedName 服务端存储名
 * @returns 可供上传的文件输入；文件缺失时抛出异常（由调用方按提交失败处理）
 */
export async function readStagedFile(taskId: string, stagedName: string): Promise<UploadFileInput> {
  const dir = getTaskStagingDir(taskId);
  const buffer = await fs.readFile(path.join(dir, path.basename(stagedName)));
  return { buffer, originalname: stagedName, mimetype: '' };
}

/**
 * 读取全部暂存文件（保留与元数据的配对关系，避免下标错位）。
 * 单个文件缺失/不可读时跳过该文件并记录日志，不阻塞其余文件上传。
 * @param taskId 任务 ID
 * @param metas 暂存文件元数据列表
 * @returns 文件与其元数据的配对列表
 */
export async function readStagedFilesWithMeta(
  taskId: string,
  metas: StagedFileMeta[],
): Promise<StagedFileWithMeta[]> {
  const result: StagedFileWithMeta[] = [];
  for (const meta of metas) {
    try {
      const raw = await readStagedFile(taskId, meta.stagedName);
      // 以元数据中的原始文件名与 MIME 覆盖读取结果，保证上传语义与直传一致
      const file: UploadFileInput = { buffer: raw.buffer, originalname: meta.originalname, mimetype: meta.mimetype };
      result.push({ meta, file });
    } catch (err: unknown) {
      // 暂存文件缺失/不可读：跳过该文件，避免整体失败（缺失原因已记录日志）
      console.error(`[TaskStaging:${taskId}] read staged file failed: ${meta.stagedName}`, err);
    }
  }
  return result;
}

/**
 * 释放任务的暂存目录（幂等，失败仅记录日志）。
 * 任务进入终态或提交失败后调用，避免暂存文件长期占用磁盘。
 * @param taskId 任务 ID
 */
export async function releaseStaged(taskId: string): Promise<void> {
  await fs.rm(getTaskStagingDir(taskId), { recursive: true, force: true });
}

/**
 * 清理超期的暂存目录（进程启动时调用，回收异常中断遗留的暂存文件）。
 * @param maxAgeMs 最大保留时长（毫秒）
 * @returns 实际删除的目录数量
 */
export async function cleanupStaleStaging(maxAgeMs: number): Promise<number> {
  const root = getStagingRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    // 暂存根目录尚未创建：无需清理
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    const dir = path.join(root, entry);
    try {
      const stat = await fs.stat(dir);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch (err: unknown) {
      // 单个目录清理失败不影响其余目录
      console.error(`[TaskStaging] cleanup stale dir failed: ${dir}`, err);
    }
  }
  return removed;
}
