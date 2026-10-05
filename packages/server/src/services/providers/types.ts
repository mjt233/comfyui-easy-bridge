import { randomUUID } from 'node:crypto';

/** 执行提供商类型 */
export type ProviderType = 'comfyui' | 'runninghub' | 'group';

/**
 * 分组调度策略。
 * - priority: 按算力性能权重降序挑选（权重最大者优先，缺省值）；
 *   最高权重成员满载时**降级**到下一个有空闲槽位的低权重成员
 * - random: 在有空闲槽位的候选中随机挑选
 * - failover: 灾备模式；只使用权重最大的**在线**成员，该成员满载时原地等待其释放槽位，
 *   仅在该成员离线时顺延到下一个权重最大的在线成员（不因满载而降级）
 */
export type GroupDispatchPolicy = 'priority' | 'random' | 'failover';

/**
 * 分组「无在线实例」行为。
 *
 * 「在线」只看连通性：成员未处于健康冷却期即视为在线，**不考虑并发额度是否已满**
 * （成员能连通但槽位占满属于「有在线实例但无空闲槽位」，两种取值下都继续排队等待）。
 * - queue: 分组内没有任何在线成员时任务留在队列等待调度（缺省值）
 * - error: 分组内没有任何在线成员时任务立即置为失败（写失败原因，不再排队等待）
 */
export type GroupNoOnlineInstanceBehavior = 'queue' | 'error';

/**
 * 分组的一个成员实例。
 * 成员资格本身表达「该实例参与自动分配」：不在任何分组中的实例不会被自动分配。
 */
export interface GroupMemberConfig {
  /** 被引用实例 ID（仅 comfyui / runninghub；分组不可嵌套） */
  providerId: string;
  /** 算力性能权重：正数；缺省 1（非法值一律规范化为 1） */
  weight: number;
}

/**
 * 分组（自动分配）提供商配置。
 * 分组自身不执行任务：提交到分组的任务先进入独立队列，
 * 由调度器在成员有空闲并发时按 dispatchPolicy 挑选成员并最终提交；
 * 分组内没有任何在线成员时按 noOnlineInstanceBehavior 决定任务去向（等待或直接失败）。
 */
export interface GroupProviderConfig {
  /** 调度策略；缺省 'priority' */
  dispatchPolicy: GroupDispatchPolicy;
  /** 本组成员；数组顺序即 priority 策略下权重相同时的优先次序 */
  members: GroupMemberConfig[];
  /**
   * 无在线实例行为；缺省 'queue'（留在队列等待调度）。
   * 'error' 表示分组内没有任何在线成员时任务直接置为失败。
   * 兼容存量数据：字段缺失或取值非法时一律按 'queue' 处理（由 ProviderService 规范化）。
   */
  noOnlineInstanceBehavior?: GroupNoOnlineInstanceBehavior;
}

/** 连通性测试结果 */
export interface ConnectionTestResult {
  /** 是否连通 */
  ok: boolean;
  /** 提示信息（成功文案或失败原因） */
  message: string;
}

/**
 * 提供商实例配置（按类型区分的判别联合）。
 * - comfyui: { baseUrl, autoCleanup?, inputDir? }
 *   - autoCleanup: 是否允许在任务终态删除本次上传的资产文件（默认 false；false 时任何路径都不删除）
 *   - inputDir: ComfyUI 输入目录的本地文件系统路径，**仅作为删除时的路径来源**，不用于解析工作流中的文件路径
 *     （仅同机部署有效；为空时无法清理）
 * - runninghub: { apiKey, gpuSize }
 * - group: { dispatchPolicy, members, noOnlineInstanceBehavior }
 */
export type ProviderConfig =
  | { baseUrl: string; autoCleanup?: boolean; inputDir?: string }
  | { apiKey: string; gpuSize: '24G' | '48G' }
  | GroupProviderConfig;

/** comfyui 类型配置 */
export type ComfyUIConfig = Extract<ProviderConfig, { baseUrl: string }>;
/** runninghub 类型配置 */
export type RunningHubConfig = Extract<ProviderConfig, { apiKey: string; gpuSize: '24G' | '48G' }>;

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

/**
 * 连通性探测参数。
 * 定义在无依赖的 types 模块，供各 provider 实现与健康检测服务共同引用，
 * 避免 provider 实现反向依赖健康检测服务（否则形成循环依赖）。
 */
export const connectivityProbeConfig = {
  /** 单次探测超时（毫秒） */
  timeoutMs: 3000,
};

/** 输出文件引用（构造下载地址用） */
export interface OutputFileRef {
  filename: string;
  subfolder: string;
  type: string;
}

/**
 * 平台侧返回的单个产出文件。
 * 平台直接给出可下载的绝对地址（如 RunningHub 结果查询 V2 的 `results[].url`），
 * 因此没有 ComfyUI 那套 subfolder / type / nodeId 语义，也不需要拼装 /view 地址。
 */
export interface ProviderOutputFile {
  /** 文件展示名（由平台地址推导，通常为 URL 末段） */
  filename: string;
  /** 文件类型分类 */
  fileType: 'image' | 'video' | 'audio';
  /** 平台返回的绝对下载地址 */
  url: string;
}

/**
 * 平台侧一次任务状态探测的归一化结果。
 * 由实现了 `queryTaskState` 的提供商产出，供任务跟踪器统一处理终态与产出，
 * 与 `resolveHistoryOutcome` + `parseHistoryOutputs` 的 history 路径语义一一对应。
 */
export type ProviderTaskState =
  /** 仍在排队或执行中：本轮不终态化，下一轮继续探测 */
  | { kind: 'running' }
  /** 执行成功：携带平台产出文件（可能为空数组） */
  | { kind: 'completed'; files: ProviderOutputFile[]; raw: unknown }
  /** 执行失败或平台判定异常：携带可读失败原因 */
  | { kind: 'failed'; errorMessage: string; raw: unknown };

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
  /**
   * 连通性探测：GET {baseUrl}/system_stats，2xx 视为可用。
   * 供调度前校验实例可用性使用；实现内部负责吞掉网络异常，不抛出。
   */
  testConnection(): Promise<ConnectionTestResult>;
  /** 对外展示的基础地址（apiKey 等敏感信息已打码，可安全返回给客户端） */
  getDisplayBaseUrl(): string;
  /**
   * 返回类型化配置副本（脚本/序列化用）。
   * 含 runninghub 的明文 apiKey，仅服务端可见，不得回传客户端。
   */
  getConfig(): ProviderConfig;
  /** 提交 prompt，不抛网络/HTTP 异常 */
  submitPrompt(body: string): Promise<ExecutionResult>;
  /** 上传媒体文件，返回注入工作流节点的文件名 */
  uploadMedia(file: UploadFileInput, mediaType: MediaType): Promise<string>;
  /**
   * 是否允许在任务终态删除本实例上传的资产（可选能力查询）。
   * 仅 comfyui 提供商实现（读取 config.autoCleanup）；未实现该方法的提供商一律视为 false。
   * 供上层服务在调用 cleanupUploadedFiles 前判断，避免「配置关不掉删除行为」。
   * @returns true 表示允许在任务终态删除本次上传的资产
   */
  getAutoCleanup?(): boolean;
  /**
   * 清理上传的资产文件（可选能力）。
   * 仅支持本地文件系统删除的提供商（原生 ComfyUI + 本地输入目录）实现；
   * 未实现或不可用时调用方直接跳过。实现内部负责开关判断、路径安全与错误吞并。
   * @param filenames 本次上传的文件名（ComfyUI 存储名）
   */
  cleanupUploadedFiles?(filenames: string[]): Promise<void>;
  /** 拉取指定 prompt 的 history；非 2xx 或网络错误时可能抛错，调用方需自行捕获 */
  fetchHistory(promptId: string): Promise<unknown>;
  /**
   * 查询平台侧任务状态与产出（可选能力）。
   * 实现该方法的提供商（RunningHub）不再依赖执行端 `/history` 判定终态与解析产出：
   * 任务跟踪器每轮轮询改为调用本方法，`kind` 即终态判据。
   * 未实现时调用方沿用 `fetchHistory` + history 解析路径，行为完全不变。
   * @param taskId 平台任务 ID（RunningHub 即 proxy 提交返回的 prompt_id）
   * @returns 归一化状态；网络/HTTP 异常由实现抛出，调用方按「连续失败计数」处理
   */
  queryTaskState?(taskId: string): Promise<ProviderTaskState>;
  /** 中断任务，可带 promptId 轮询确认停止 */
  interrupt(promptId?: string): Promise<boolean>;
  /** 查询 prompt 是否仍在执行队列 */
  isPromptRunning(promptId: string): Promise<boolean>;
  /** 构造输出文件下载地址 */
  buildOutputViewUrl(file: OutputFileRef): string;
}
