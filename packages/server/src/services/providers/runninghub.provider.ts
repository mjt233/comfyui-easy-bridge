import { buildUniqueUploadFilename } from '../upload.service';
import {
  buildViewUrl,
  fetchHistoryRequest,
  guessFileType,
  interruptRequest,
  isPromptRunningRequest,
  submitPromptRequest,
  testConnectionRequest,
} from './shared';
import { connectivityProbeConfig } from './types';
import type {
  ConnectionTestResult,
  ExecutionProvider,
  ExecutionResult,
  MediaType,
  OutputFileRef,
  ProviderOutputFile,
  ProviderTaskState,
  ProviderType,
  RunningHubConfig,
  UploadFileInput,
} from './types';

/** RunningHub 平台基础地址（上传接口、结果查询与 proxy 共用） */
const RUNNINGHUB_BASE_URL = 'https://www.runninghub.cn';

/** RunningHub 结果查询 V2 地址：查询任务状态与产出 */
const RUNNINGHUB_QUERY_URL = `${RUNNINGHUB_BASE_URL}/openapi/v2/query`;

/**
 * 结果查询单次请求超时（毫秒）。
 * 跟踪器按固定间隔串行探测本实例的 pending 任务，单次挂起会拖慢整轮轮询，故显式限时。
 */
export const RUNNINGHUB_QUERY_TIMEOUT_MS = 10000;

/** RunningHub 任务状态中「尚未产生终态」的取值；未识别取值另按 errorCode 是否为空判定 */
const RUNNING_TASK_STATUSES = new Set(['CREATE', 'QUEUED', 'RUNNING', 'PENDING']);

/** RunningHub 结果查询 V2 响应体（字段名以官方接口为准，实测含文档未列的 failedReason 等） */
interface RunningHubQueryResponse {
  /** 任务 ID */
  taskId?: string;
  /** 任务状态：SUCCESS / FAILED / CANCEL / RUNNING / QUEUED / CREATE 等 */
  status?: string;
  /** 平台错误码（非空表示平台侧报错） */
  errorCode?: string;
  /** 平台错误信息 */
  errorMessage?: string;
  /** 产出文件列表；未完成时为 null */
  results?: Array<{ url?: string; outputUrl?: string; outputType?: string }> | null;
  /** 失败详情（节点名、异常信息等） */
  failedReason?: { exception_message?: unknown; node_name?: unknown } | null;
}

/**
 * 由平台返回的绝对地址推导展示用文件名（取 path 末段）。
 * @param url 平台绝对地址
 * @returns 文件名；无法解析时退化为按 `/` 切分的末段，再退化则原样返回
 */
function filenameFromUrl(url: string): string {
  // 取按 / 切分后的最后一段（pathname 与裸 URL 共用）
  const lastSegment = (value: string): string | null => value.split('/').filter(Boolean).pop() ?? null;
  try {
    const segment = lastSegment(new URL(url).pathname);
    return segment ? decodeURIComponent(segment) : url;
  } catch {
    // 非法 URL：退化为按 / 切分
    return lastSegment(url) ?? url;
  }
}

/**
 * 汇总平台失败原因：优先失败详情里的 exception_message，其次 errorMessage，最后退化为通用文案。
 * @param data 平台响应体
 * @returns 可读失败原因（含 errorCode 便于对照官方错误码表）
 */
function describeQueryFailure(data: RunningHubQueryResponse): string {
  const exceptionMessage = data.failedReason?.exception_message;
  const detail = typeof exceptionMessage === 'string' && exceptionMessage.trim() !== ''
    ? exceptionMessage
    : data.errorMessage;
  const text = typeof detail === 'string' && detail.trim() !== '' ? detail : 'RunningHub 任务执行失败';
  return data.errorCode ? `${text} (errorCode=${data.errorCode})` : text;
}

/**
 * 将平台 results 数组映射为平台产出文件。
 * 兼容官方契约建议的 `outputUrl` 别名；文件类型按 outputType 或地址扩展名推断。
 * @param results 平台 results 字段
 * @returns 产出文件列表；无有效条目时返回空数组
 */
function parseQueryResults(results: RunningHubQueryResponse['results']): ProviderOutputFile[] {
  if (!Array.isArray(results)) return [];
  const files: ProviderOutputFile[] = [];
  for (const item of results) {
    // 跳过非对象条目与缺少地址的条目
    if (!item || typeof item !== 'object') continue;
    const rawUrl = item.url ?? item.outputUrl;
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') continue;
    const url = rawUrl.trim();
    const filename = filenameFromUrl(url);
    const outputType = typeof item.outputType === 'string' ? item.outputType : '';
    files.push({ filename, fileType: guessFileType(outputType || filename), url });
  }
  return files;
}

/**
 * RunningHub 原生 ComfyUI 接口执行提供商。
 * 基础地址由 apiKey + gpuSize 推导；媒体走 /openapi/v2/media/upload/binary（Bearer 鉴权）；
 * 任务跟踪为纯轮询，终态判定与产出解析走平台结果查询 V2（`queryTaskState`），不使用 proxy `/history`。
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
    private config: RunningHubConfig,
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
  getConfig(): RunningHubConfig {
    return { ...this.config };
  }

  /** 连通性探测：RunningHub 的 proxy 地址同为 ComfyUI 兼容接口，探测 GET {base}/system_stats */
  testConnection(): Promise<ConnectionTestResult> {
    return testConnectionRequest(this.getBaseUrl(), connectivityProbeConfig.timeoutMs);
  }

  /** 提交 prompt 到推导出的 proxy /prompt（失败时按实例上下文打印原始响应体） */
  submitPrompt(body: string): Promise<ExecutionResult> {
    // RunningHub 的错误体形如 { code, msg, data }，日志中会额外输出 code/msg 摘要
    return submitPromptRequest(this.getBaseUrl(), body, {
      providerId: this.id,
      providerName: this.name,
      providerType: this.type,
    });
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
    console.info(`上传文件到runninghub 保存为${result.data?.fileName}`);
    return result.data.fileName;
  }

  /**
   * 查询平台侧任务状态与产出（RunningHub 结果查询 V2）。
   * 该能力取代 proxy `/history`：任务跟踪器据此判定 SUCCESS/FAILED 终态，
   * 并直接拿到带绝对地址的产出文件（`results[].url`），无需再拼装 `/view` 地址。
   * @param taskId 平台任务 ID（即 proxy 提交返回的 prompt_id）
   * @returns 归一化状态；HTTP 非 2xx、网络异常与响应结构异常一律抛出，由调用方按连续失败计数处理
   */
  async queryTaskState(taskId: string): Promise<ProviderTaskState> {
    // 显式限时，避免单次挂起拖慢跟踪器的整轮轮询
    const response = await fetch(RUNNINGHUB_QUERY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ taskId }),
      signal: AbortSignal.timeout(RUNNINGHUB_QUERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`RunningHub query failed (${response.status}): ${text}`);
    }

    const body: unknown = await response.json();
    // 响应不是对象或缺少 status 字符串：接口契约被破坏，抛错交由连续失败计数兜底，
    // 避免任务因无法识别状态而永久停留在 pending
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('RunningHub query failed: unexpected response body');
    }
    const data = body as RunningHubQueryResponse;
    if (typeof data.status !== 'string') {
      throw new Error(`RunningHub query failed: missing status (${JSON.stringify(body).slice(0, 200)})`);
    }

    // 1) 平台判定成功：结果为空视为异常（成功却无产出），直接失败以暴露问题
    if (data.status === 'SUCCESS') {
      const files = parseQueryResults(data.results);
      if (files.length === 0) {
        return { kind: 'failed', errorMessage: 'RunningHub 任务成功但未返回输出文件', raw: body };
      }
      return { kind: 'completed', files, raw: body };
    }

    // 2) 平台明确失败 / 取消
    if (data.status === 'FAILED' || data.status === 'CANCEL' || data.status === 'CANCELLED') {
      return { kind: 'failed', errorMessage: describeQueryFailure(data), raw: body };
    }

    // 3) 已知的非终态：本轮不终态化，下一轮继续探测
    if (RUNNING_TASK_STATUSES.has(data.status)) {
      return { kind: 'running' };
    }

    // 4) 未识别状态：带 errorCode/errorMessage 说明平台侧报错（如 API Key 失效），
    //    按失败处理而非继续轮询，避免任务永久停留在 pending
    if (data.errorCode || data.errorMessage) {
      return { kind: 'failed', errorMessage: describeQueryFailure(data), raw: body };
    }
    return { kind: 'running' };
  }

  /**
   * 拉取 history（非 2xx 抛错，调用方捕获）。
   * RunningHub 的终态判定与产出解析已全部改走 `queryTaskState`，
   * 本方法仅保留给「改造前已完成、本地输出列表为空」的历史任务的读路径回源。
   */
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
