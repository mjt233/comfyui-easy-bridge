import type {
  ConnectionTestResult,
  ExecutionProvider,
  ExecutionResult,
  GroupDispatchPolicy,
  ProviderType,
  UploadFileInput,
} from './types';

/**
 * 分组成员实例（已解析为可执行的 provider）。
 * 由 ProviderService.resolveGroupMembers 产出，权重与配置顺序在此固化。
 */
export interface ResolvedGroupMember {
  /** 成员实例 ID */
  providerId: string;
  /** 成员实例展示名 */
  providerName: string;
  /** 算力性能权重（正数） */
  weight: number;
  /** 分组成员数组中的下标（priority 策略下权重相同时的次序依据） */
  order: number;
  /** 已实例化的成员 provider */
  provider: ExecutionProvider;
}

/**
 * 分组（自动分配）执行提供商。
 *
 * 分组本身**不执行任务**、没有可提交的 HTTP 端点：提交到分组的任务先进入独立队列，
 * 由 dispatcher 在成员有空闲并发时挑选成员并最终提交。
 * 因此除 testConnection 外的执行类方法均抛出明确错误——一旦被调用即说明调度链路有缺陷。
 * testConnection 反映「本组当前是否有成员可用」，供连通性测试与分组健康展示使用。
 */
export class GroupProvider implements ExecutionProvider {
  /** 提供商类型 */
  readonly type: ProviderType = 'group';
  /** 任务跟踪模式：分组不直接持有任务，固定轮询（占位，实际不使用） */
  readonly trackingMode: 'websocket' | 'polling' = 'polling';

  /**
   * @param id 实例 ID
   * @param name 展示名
   * @param concurrency 并发上限字段（分组不使用，固定为 1）
   * @param dispatchPolicy 调度策略
   * @param members 已解析的成员列表
   */
  constructor(
    readonly id: string,
    readonly name: string,
    readonly concurrency: number,
    private readonly dispatchPolicy: GroupDispatchPolicy,
    private readonly members: ResolvedGroupMember[],
  ) {}

  /**
   * 分组无自有端点，返回空串。
   * 调用方（任务日志、执行入口）需对分组特判，不得据此拼接请求地址。
   */
  getBaseUrl(): string {
    return '';
  }

  /** 分组对外展示地址为空（无自有端点） */
  getDisplayBaseUrl(): string {
    return '';
  }

  /**
   * 返回分组类型化配置副本。
   * 分组配置不含敏感信息，可安全序列化。
   */
  getConfig(): { dispatchPolicy: GroupDispatchPolicy; members: { providerId: string; weight: number }[] } {
    return {
      dispatchPolicy: this.dispatchPolicy,
      // 仅输出成员 ID 与权重，不泄露成员实例的凭据
      members: this.members.map((m) => ({ providerId: m.providerId, weight: m.weight })),
    };
  }

  /** 当前调度策略 */
  getDispatchPolicy(): GroupDispatchPolicy {
    return this.dispatchPolicy;
  }

  /**
   * 本组成员列表（按配置顺序）。
   * @returns 成员列表副本
   */
  listMembers(): ResolvedGroupMember[] {
    return [...this.members];
  }

  /**
   * 连通性探测：反映「本组当前是否有至少一个可用成员」。
   * 逐个探测成员，遇到第一个可用成员即成功返回（全不可用时返回最后一个失败原因）。
   */
  async testConnection(): Promise<ConnectionTestResult> {
    if (this.members.length === 0) {
      return { ok: false, message: '分组未配置成员实例' };
    }
    let lastError = '分组内成员实例均不可用';
    for (const member of this.members) {
      const result = await member.provider.testConnection();
      if (result.ok) {
        return { ok: true, message: `连接成功（成员：${member.providerName}）` };
      }
      lastError = `${member.providerName}: ${result.message}`;
    }
    return { ok: false, message: lastError };
  }

  /** 分组不直接提交任务：返回失败结果而非抛错，避免调用方未捕获导致进程异常 */
  submitPrompt(): Promise<ExecutionResult> {
    return Promise.resolve({
      success: false,
      comfyuiResponse: null,
      promptId: null,
      errorMessage: `Provider "${this.name}" is a group; tasks must be dispatched to its members`,
    });
  }

  /** 分组不直接上传媒体：媒体由调度器在选定成员后上传到该成员 */
  uploadMedia(_file: UploadFileInput): Promise<string> {
    return Promise.reject(new Error(`Provider "${this.name}" is a group and cannot accept media uploads`));
  }

  /** 分组没有 history：输出回源需使用任务的 actualProviderId */
  fetchHistory(): Promise<unknown> {
    return Promise.reject(new Error(`Provider "${this.name}" is a group and has no history`));
  }

  /** 分组无法直接中断：中断需使用任务的 actualProviderId */
  interrupt(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** 分组没有执行队列 */
  isPromptRunning(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** 分组无自有端点，无法构造下载地址（输出下载需使用任务的 actualProviderId） */
  buildOutputViewUrl(): string {
    return '';
  }
}
