import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildUniqueUploadFilename } from '../upload.service';
import {
  buildViewUrl,
  fetchHistoryRequest,
  interruptRequest,
  isPromptRunningRequest,
  submitPromptRequest,
} from './shared';
import type { ExecutionProvider, ExecutionResult, MediaType, OutputFileRef, ProviderConfig, ProviderType, UploadFileInput } from './types';

/**
 * 原生 ComfyUI 执行提供商。
 * 通过 /upload/image 上传媒体，任务跟踪走 WebSocket。
 */
export class ComfyUIProvider implements ExecutionProvider {
  /** 提供商类型 */
  readonly type: ProviderType = 'comfyui';
  /** 任务跟踪模式：WebSocket */
  readonly trackingMode: 'websocket' | 'polling' = 'websocket';

  /**
   * @param id 实例 ID
   * @param name 展示名
   * @param config 类型化配置（含 baseUrl）
   * @param concurrency 并发上限
   */
  constructor(
    readonly id: string,
    readonly name: string,
    private config: Extract<ProviderConfig, { baseUrl: string }>,
    readonly concurrency: number,
  ) {}

  /** 基础地址即配置的 baseUrl */
  getBaseUrl(): string {
    return this.config.baseUrl;
  }

  /** 对外展示地址与内部地址一致（comfyui 配置不含敏感信息） */
  getDisplayBaseUrl(): string {
    return this.config.baseUrl;
  }

  /** 返回 comfyui 类型化配置副本 */
  getConfig(): Extract<ProviderConfig, { baseUrl: string }> {
    return { ...this.config };
  }

  /** 提交 prompt 到 /prompt */
  submitPrompt(body: string): Promise<ExecutionResult> {
    return submitPromptRequest(this.getBaseUrl(), body);
  }

  /** 上传媒体文件到 /upload/image，返回 ComfyUI 存储文件名 */
  async uploadMedia(file: UploadFileInput, _mediaType: MediaType): Promise<string> {
    // 生成唯一文件名，避免同名覆盖导致工作流节点引用错乱
    const uniqueName = buildUniqueUploadFilename(file.originalname);
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
    formData.append('image', blob, uniqueName);
    formData.append('type', 'input');
    formData.append('overwrite', 'true');

    const response = await fetch(`${this.getBaseUrl()}/upload/image`, { method: 'POST', body: formData });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ComfyUI upload failed (${response.status}): ${text}`);
    }
    const result = (await response.json()) as { name?: string };
    if (!result.name) {
      throw new Error('ComfyUI upload failed: missing name');
    }
    return result.name;
  }

  /**
   * 清理本次上传的资产文件（本地文件系统删除）。
   * ComfyUI 未提供删除文件的 API，因此仅当配置了本地输入目录（inputDir）时
   * 才能直接删除文件；inputDir 为空时静默跳过并记录日志。
   * 每个文件名先取 basename 再拼接到 inputDir 内，并校验解析后路径仍在 inputDir
   * 之内（防止路径穿越）；文件不存在（ENOENT）时忽略，其他错误仅记录日志。
   * @param filenames 本次上传的文件名（ComfyUI 存储名）
   */
  async cleanupUploadedFiles(filenames: string[]): Promise<void> {
    const inputDir = this.config.inputDir?.trim();
    // 未配置本地输入目录时无法清理（无删除 API 兜底），仅记录日志
    if (!inputDir) {
      console.warn(`[ComfyUIProvider:${this.id}] autoCleanup enabled but inputDir is empty, skip cleanup`);
      return;
    }
    const resolvedDir = path.resolve(inputDir);
    for (const filename of filenames) {
      // 仅允许删除输入目录内的文件：取 basename 防目录穿越
      const target = path.resolve(resolvedDir, path.basename(filename));
      // 双保险：解析后路径必须仍在输入目录内，否则跳过
      if (!target.startsWith(resolvedDir + path.sep) && target !== resolvedDir) {
        console.warn(`[ComfyUIProvider:${this.id}] skip cleanup outside inputDir: ${filename}`);
        continue;
      }
      try {
        await fs.unlink(target);
      } catch (err) {
        // 文件已不存在视为清理成功；其他错误仅记录日志，不影响任务
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[ComfyUIProvider:${this.id}] cleanup failed for ${filename}`, err);
        }
      }
    }
  }

  /** 拉取 history（非 2xx 抛错，调用方捕获） */
  fetchHistory(promptId: string): Promise<unknown> {
    return fetchHistoryRequest(this.getBaseUrl(), promptId);
  }

  /** 中断任务 */
  interrupt(promptId?: string): Promise<boolean> {
    return interruptRequest(this.getBaseUrl(), promptId);
  }

  /** 查询是否仍在执行队列 */
  isPromptRunning(promptId: string): Promise<boolean> {
    return isPromptRunningRequest(this.getBaseUrl(), promptId);
  }

  /** 构造 /view 下载地址 */
  buildOutputViewUrl(file: OutputFileRef): string {
    return buildViewUrl(this.getBaseUrl(), file);
  }
}
