import { buildUniqueUploadFilename } from '../upload.service';
import {
  buildViewUrl,
  fetchHistoryRequest,
  interruptRequest,
  isPromptRunningRequest,
  submitPromptRequest,
} from './shared';
import type { ExecutionProvider, ExecutionResult, MediaType, OutputFileRef, ProviderConfig, ProviderType, UploadFileInput } from './types';

/** RunningHub 平台基础地址（上传接口与 proxy 共用） */
const RUNNINGHUB_BASE_URL = 'https://www.runninghub.cn';

/**
 * RunningHub 原生 ComfyUI 接口执行提供商。
 * 基础地址由 apiKey + gpuSize 推导；媒体走 /openapi/v2/media/upload/binary（Bearer 鉴权）；
 * 任务跟踪为纯轮询。
 */
export class RunningHubProvider implements ExecutionProvider {
  /** 提供商类型 */
  readonly type: ProviderType = 'runninghub';
  /** 任务跟踪模式：纯轮询 */
  readonly trackingMode: 'websocket' | 'polling' = 'polling';

  /**
   * @param id 实例 ID
   * @param name 展示名
   * @param config 类型化配置（含 apiKey / gpuSize）
   * @param concurrency 并发上限
   */
  constructor(
    readonly id: string,
    readonly name: string,
    private config: Extract<ProviderConfig, { apiKey: string; gpuSize: '24G' | '48G' }>,
    readonly concurrency: number,
  ) {}

  /** 由 apiKey + gpuSize 推导 proxy 基础地址 */
  getBaseUrl(): string {
    const prefix = this.config.gpuSize === '48G' ? 'proxy-plus' : 'proxy';
    return `${RUNNINGHUB_BASE_URL}/${prefix}/${this.config.apiKey}`;
  }

  /** 对外展示地址：apiKey 打码，避免完整 Key 泄露给客户端 */
  getDisplayBaseUrl(): string {
    const apiKey = this.config.apiKey;
    const masked = apiKey.length <= 4 ? '****' : `${apiKey.slice(0, 4)}****`;
    const prefix = this.config.gpuSize === '48G' ? 'proxy-plus' : 'proxy';
    return `https://www.runninghub.cn/${prefix}/${masked}`;
  }

  /** 返回 runninghub 类型化配置副本（含明文 apiKey，仅脚本侧使用） */
  getConfig(): Extract<ProviderConfig, { apiKey: string; gpuSize: '24G' | '48G' }> {
    return { ...this.config };
  }

  /** 提交 prompt 到推导出的 proxy /prompt */
  submitPrompt(body: string): Promise<ExecutionResult> {
    return submitPromptRequest(this.getBaseUrl(), body);
  }

  /**
   * 上传媒体到 RunningHub 上传接口，返回 fileName 注入加载节点。
   * @param file 待上传文件
   * @param _mediaType 媒体类型（RunningHub 上传接口按扩展名识别，无需区分端点）
   */
  async uploadMedia(file: UploadFileInput, _mediaType: MediaType): Promise<string> {
    const uniqueName = buildUniqueUploadFilename(file.originalname);
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
    formData.append('file', blob, uniqueName);

    const response = await fetch(`${RUNNINGHUB_BASE_URL}/openapi/v2/media/upload/binary`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: formData,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`RunningHub upload failed (${response.status}): ${text}`);
    }
    const result = (await response.json()) as { code: number; message: string; data?: { fileName: string } };
    if (result.code !== 0) {
      throw new Error(`RunningHub upload failed: ${result.message ?? 'unknown error'}`);
    }
    if (!result.data?.fileName) {
      throw new Error('RunningHub upload failed: missing fileName');
    }
    return result.data.fileName;
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
