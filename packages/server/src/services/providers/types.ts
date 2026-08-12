import { randomUUID } from 'node:crypto';

/** 执行提供商类型 */
export type ProviderType = 'comfyui' | 'runninghub';

/**
 * 提供商实例配置（按类型区分的判别联合）。
 * - comfyui: { baseUrl, autoCleanup?, inputDir? }
 *   - autoCleanup: 是否在任务终态后自动清理本次上传的资产文件（默认 false）
 *   - inputDir: ComfyUI 输入目录的本地文件系统路径（仅同机部署有效；为空时无法清理）
 * - runninghub: { apiKey, gpuSize }
 */
export type ProviderConfig =
  | { baseUrl: string; autoCleanup?: boolean; inputDir?: string }
  | { apiKey: string; gpuSize: '24G' | '48G' };

/** 执行工作流的结果 */
export interface ExecutionResult {
  /** 是否成功提交 */
  success: boolean;
  /** 执行端的响应体（JSON） */
  comfyuiResponse: unknown;
  /** 执行端返回的 prompt_id，为 null 表示提交失败 */
  promptId: string | null;
  /** 错误信息（失败时） */
  errorMessage: string | null;
}

/** 本服务连接执行端时使用的稳定 client_id（WebSocket 会话标识） */
export const COMFYUI_CLIENT_ID: string = randomUUID();

/** 输出文件引用（构造下载地址用） */
export interface OutputFileRef {
  filename: string;
  subfolder: string;
  type: string;
}

/** 上传文件元数据 */
export interface UploadFileInput {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/** 媒体类型 */
export type MediaType = 'image' | 'video' | 'audio';

/**
 * 执行提供商抽象接口。
 * 新增提供商类型时实现本接口并在 ProviderService 中注册工厂。
 */
export interface ExecutionProvider {
  /** 实例 ID */
  readonly id: string;
  /** 展示名 */
  readonly name: string;
  /** 提供商类型 */
  readonly type: ProviderType;
  /** 并发上限 */
  readonly concurrency: number;
  /** 任务跟踪模式：websocket 或 polling */
  readonly trackingMode: 'websocket' | 'polling';
  /** 解析后的 HTTP 基础地址（内部使用，含完整凭据） */
  getBaseUrl(): string;
  /** 对外展示的基础地址（apiKey 等敏感信息已打码，可安全返回给客户端） */
  getDisplayBaseUrl(): string;
  /** 提交 prompt，不抛网络/HTTP 异常 */
  submitPrompt(body: string): Promise<ExecutionResult>;
  /** 上传媒体文件，返回注入工作流节点的文件名 */
  uploadMedia(file: UploadFileInput, mediaType: MediaType): Promise<string>;
  /**
   * 清理上传的资产文件（可选能力）。
   * 仅支持本地文件系统删除的提供商（原生 ComfyUI + 本地输入目录）实现；
   * 未实现或不可用时调用方直接跳过。实现内部负责路径安全与错误吞并。
   * @param filenames 本次上传的文件名（ComfyUI 存储名）
   */
  cleanupUploadedFiles?(filenames: string[]): Promise<void>;
  /** 拉取指定 prompt 的 history；非 2xx 或网络错误时可能抛错，调用方需自行捕获 */
  fetchHistory(promptId: string): Promise<unknown>;
  /** 中断任务，可带 promptId 轮询确认停止 */
  interrupt(promptId?: string): Promise<boolean>;
  /** 查询 prompt 是否仍在执行队列 */
  isPromptRunning(promptId: string): Promise<boolean>;
  /** 构造输出文件下载地址 */
  buildOutputViewUrl(file: OutputFileRef): string;
}
