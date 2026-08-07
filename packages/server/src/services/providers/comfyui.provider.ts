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
