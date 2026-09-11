import { eq, desc, inArray, count, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { randomUUID } from 'crypto';

/** 创建任务日志的输入参数 */
export interface CreateTaskInput {
  /** 关联工作流 ID */
  workflowId: string;
  /** 工作流名称（冗余存储） */
  workflowName: string;
  /** 提交的字段参数 JSON */
  aliasValues: string;
  /** 用户原始请求表单 JSON（参数 + 文件元数据）；旧记录可能为 null */
  originalForm?: string | null;
  /** 请求 ComfyUI 的完整 URL */
  comfyuiUrl: string;
  /** 请求体 JSON */
  comfyuiRequestBody: string | null;
  /** ComfyUI 响应 JSON */
  comfyuiResponse: string | null;
  /** ComfyUI 返回的 prompt_id，为 null 表示提交失败 */
  promptId: string | null;
  /** 实际使用的提供商实例 ID */
  providerId?: string | null;
  /** 实际使用的提供商实例名称（冗余存储，实例改名/删除后日志仍可溯源）；为空则存 null */
  providerName?: string | null;
  /** 本次上传到执行端的资产文件名 JSON 数组字符串；缺省 '[]' */
  uploadedFiles?: string;
}

/** 分组任务调度结果（写入实际执行任务的成员实例） */
export interface UpdateActualProviderInput {
  /** 实际执行任务的成员实例 ID */
  actualProviderId: string;
  /** 实际执行任务的成员实例名称（冗余存储，实例改名/删除后日志仍可溯源） */
  actualProviderName: string;
  /** 成员实例返回的 prompt_id（提交成功时必填） */
  promptId: string;
  /** 成员实例的提交响应 JSON */
  comfyuiResponse?: string;
}

/** 输出文件信息 */
export interface OutputFile {
  /** 文件名 */
  filename: string;
  /** ComfyUI output 子目录 */
  subfolder: string;
  /** 类型（固定 output） */
  type: string;
  /** 工作流节点 ID */
  nodeId: string;
  /** 文件类型分类 */
  fileType: 'image' | 'video' | 'audio';
}

/** 更新任务结果的输入参数 */
export interface UpdateTaskResult {
  /** 目标状态 */
  status: 'queued' | 'pending' | 'completed' | 'failed';
  /** ComfyUI prompt_id */
  promptId?: string;
  /** ComfyUI 响应 JSON */
  comfyuiResponse?: string;
  /** 错误信息（失败时） */
  errorMessage?: string;
  /** 完成时间，默认当前时间 */
  completedAt?: string;
}

/** 任务日志服务：管理 task_logs 表的 CRUD 和状态流转 */
export class TaskService {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /**
   * 创建任务日志记录。
   * - 有 promptId：状态 pending，写入 startedAt（实际开始执行）
   * - 无 promptId：状态 failed，无 startedAt，completedAt 为当前时间
   */
  create(input: CreateTaskInput) {
    const now = new Date().toISOString();
    const id = randomUUID();
    // 有 promptId 表示已提交到执行端，立即记为开始执行
    const started = Boolean(input.promptId);
    this.db.insert(schema.taskLogs).values({
      id,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      aliasValues: input.aliasValues,
      originalForm: input.originalForm ?? null,
      comfyuiUrl: input.comfyuiUrl,
      comfyuiRequestBody: input.comfyuiRequestBody,
      comfyuiResponse: input.comfyuiResponse,
      promptId: input.promptId,
      providerId: input.providerId ?? null,
      providerName: input.providerName ?? null,
      actualProviderId: null,
      actualProviderName: null,
      uploadedFiles: input.uploadedFiles ?? '[]',
      status: started ? 'pending' : 'failed',
      errorMessage: null,
      createdAt: now,
      // 仅真正进入执行时记录开始时间；提交即失败则无执行耗时
      startedAt: started ? now : null,
      completedAt: started ? null : now,
    }).run();
    return this.getById(id)!;
  }

  /** 按 ID 查询任务日志 */
  getById(id: string) {
    return this.db.select().from(schema.taskLogs).where(eq(schema.taskLogs.id, id)).get() ?? null;
  }

  /** 列出所有任务日志（按提交时间降序，最新在前） */
  list() {
    return this.db.select().from(schema.taskLogs)
      .orderBy(desc(schema.taskLogs.createdAt)).all();
  }

  /**
   * 更新任务状态和结果。
   * 时间字段语义：
   * - pending：首次进入时写入 startedAt（已有则不覆盖），清空 completedAt
   * - queued：不写 startedAt，清空 completedAt（排队等待不算执行）
   * - completed/failed：写入 completedAt，保留已有 startedAt
   * promptId / comfyuiResponse 仅在显式提供时覆盖，缺省保留原值
   * （分组任务会先以 queued 建单、调度成功后才写入 promptId）。
   */
  updateStatus(id: string, input: UpdateTaskResult) {
    const now = new Date().toISOString();
    const existing = this.getById(id);
    // 组装本次要写入的时间字段（按目标状态区分）
    const timeFields: { startedAt?: string | null; completedAt?: string | null } = {};

    if (input.status === 'pending') {
      // 首次进入 pending 才落开始时间，避免重复提交覆盖
      if (existing && !existing.startedAt) {
        timeFields.startedAt = now;
      }
      // 中间态不应保留完成时间
      timeFields.completedAt = null;
    } else if (input.status === 'queued') {
      // 排队中：尚未开始执行
      timeFields.completedAt = null;
    } else {
      // 终态：记录完成时间
      timeFields.completedAt = input.completedAt ?? now;
    }

    // 仅在显式提供时覆盖 promptId / comfyuiResponse，避免"只改状态"的调用清空既有值
    const resultFields: { promptId?: string; comfyuiResponse?: string } = {};
    if (input.promptId !== undefined) resultFields.promptId = input.promptId;
    if (input.comfyuiResponse !== undefined) resultFields.comfyuiResponse = input.comfyuiResponse;

    this.db.update(schema.taskLogs)
      .set({
        status: input.status,
        ...resultFields,
        errorMessage: input.errorMessage ?? null,
        ...timeFields,
      })
      .where(eq(schema.taskLogs.id, id))
      .run();
    return this.getById(id)!;
  }

  /**
   * 仅记录任务的实际执行实例（不改变状态）。
   * 普通实例任务在入队时即可确定执行实例（providerId 本身），
   * 提前写入该字段使并发统计与队列消费统一按 actual_provider_id 口径工作；
   * 分组任务则由 updateActualProvider 在调度成功后写入。
   * @param id 任务 ID
   * @param input 实际执行实例信息
   * @returns 更新后的任务行
   */
  setActualProvider(id: string, input: UpdateActualProviderInput) {
    this.db.update(schema.taskLogs)
      .set({
        actualProviderId: input.actualProviderId,
        actualProviderName: input.actualProviderName,
      })
      .where(eq(schema.taskLogs.id, id))
      .run();
    return this.getById(id)!;
  }

  /**
   * 记录分组任务实际执行所用的成员实例，并把任务推进为 pending。
   * providerId / providerName 保持不变（仍记录用户选择的分组），
   * 实际成员写入 actualProviderId / actualProviderName。
   * @param id 任务 ID
   * @param input 调度结果（成员实例与 prompt_id）
   * @returns 更新后的任务行
   */
  updateActualProvider(id: string, input: UpdateActualProviderInput) {
    const existing = this.getById(id);
    const now = new Date().toISOString();
    this.db.update(schema.taskLogs)
      .set({
        status: 'pending',
        promptId: input.promptId,
        comfyuiResponse: input.comfyuiResponse,
        errorMessage: null,
        actualProviderId: input.actualProviderId,
        actualProviderName: input.actualProviderName,
        // 首次进入 pending 才落开始时间（排队时长不计入执行耗时）
        startedAt: existing && !existing.startedAt ? now : existing?.startedAt ?? now,
        completedAt: null,
      })
      .where(eq(schema.taskLogs.id, id))
      .run();
    return this.getById(id)!;
  }

  /** 查询所有 pending 状态的任务（供 PollingService 轮询使用）；可按提供商实例过滤 */
  listPending(providerId?: string) {
    // drizzle 的 where() 二次调用会覆盖前一次条件，因此带提供商过滤时用 and() 组合状态与提供商条件
    const condition = providerId
      ? and(eq(schema.taskLogs.status, 'pending'), eq(schema.taskLogs.providerId, providerId))
      : eq(schema.taskLogs.status, 'pending');
    return this.db.select().from(schema.taskLogs)
      .where(condition)
      .all();
  }

  /** 删除所有已完成和失败的任务，返回删除数量 */
  clearCompleted(): number {
    const result = this.db.delete(schema.taskLogs)
      .where(inArray(schema.taskLogs.status, ['completed', 'failed']))
      .run();
    return result.changes;
  }

  /** 统计指定状态的任务数；可按提供商实例过滤 */
  countByStatus(status: string, providerId?: string): number {
    // 带提供商过滤时用 and() 组合条件，避免 where() 二次调用覆盖状态条件
    const condition = providerId
      ? and(eq(schema.taskLogs.status, status), eq(schema.taskLogs.providerId, providerId))
      : eq(schema.taskLogs.status, status);
    const row = this.db.select({ c: count() }).from(schema.taskLogs)
      .where(condition).get();
    return row?.c ?? 0;
  }

  /** 获取所有 queued 任务（按提交时间升序）；可按提供商实例过滤 */
  listQueued(providerId?: string) {
    // 带提供商过滤时用 and() 组合条件，避免 where() 二次调用覆盖状态条件
    const condition = providerId
      ? and(eq(schema.taskLogs.status, 'queued'), eq(schema.taskLogs.providerId, providerId))
      : eq(schema.taskLogs.status, 'queued');
    return this.db.select().from(schema.taskLogs)
      .where(condition)
      .orderBy(schema.taskLogs.createdAt).all();
  }

  /** 更新任务进度百分比 */
  updateProgress(id: string, progress: number) {
    this.db.update(schema.taskLogs)
      .set({ progress })
      .where(eq(schema.taskLogs.id, id))
      .run();
    return this.getById(id)!;
  }

  /** 更新任务的输出文件列表 */
  updateOutputFiles(id: string, files: OutputFile[]) {
    this.db.update(schema.taskLogs)
      .set({ outputFiles: JSON.stringify(files) })
      .where(eq(schema.taskLogs.id, id))
      .run();
    return this.getById(id)!;
  }

  /** 按 promptId 查找任务 */
  getByPromptId(promptId: string) {
    return this.db.select().from(schema.taskLogs)
      .where(eq(schema.taskLogs.promptId, promptId))
      .get() ?? null;
  }

  /**
   * 列出某成员实例当前正在执行的任务（按实际执行实例过滤）。
   * 分组任务调度成功后 provider_id 仍是分组 ID，因此按 provider_id 过滤查不到，
   * 执行跟踪与并发统计需使用本方法按 actual_provider_id 查询。
   * @param actualProviderId 实际执行任务的成员实例 ID
   * @returns pending 状态任务列表
   */
  listPendingByActualProvider(actualProviderId: string) {
    return this.db.select().from(schema.taskLogs)
      .where(and(
        eq(schema.taskLogs.status, 'pending'),
        eq(schema.taskLogs.actualProviderId, actualProviderId),
      ))
      .all();
  }

  /**
   * 列出某成员实例排队中的任务（按实际执行实例过滤）。
   * 普通任务的实际执行实例即其 providerId；分组任务入队时 providerId 为分组，
   * actual_provider_id 为空，因此不会被成员实例的跟踪器消费。
   * @param actualProviderId 实际执行任务的成员实例 ID
   * @returns queued 状态任务列表（按提交时间升序）
   */
  listQueuedByActualProvider(actualProviderId: string) {
    return this.db.select().from(schema.taskLogs)
      .where(and(
        eq(schema.taskLogs.status, 'queued'),
        eq(schema.taskLogs.actualProviderId, actualProviderId),
      ))
      .orderBy(schema.taskLogs.createdAt)
      .all();
  }

  /**
   * 统计某成员实例当前占用的并发槽位（按实际执行实例统计 pending 任务）。
   * @param actualProviderId 实际执行任务的成员实例 ID
   * @returns 占用槽位数
   */
  countPendingByActualProvider(actualProviderId: string): number {
    const row = this.db.select({ c: count() }).from(schema.taskLogs)
      .where(and(
        eq(schema.taskLogs.status, 'pending'),
        eq(schema.taskLogs.actualProviderId, actualProviderId),
      ))
      .get();
    return row?.c ?? 0;
  }

  /**
   * 列出全部排队中的分组任务（按提交时间升序）。
   * 分组任务在调度前不具备 promptId，调度器据此消费队列。
   * @param groupIds 分组实例 ID 列表；为空数组时返回空列表
   * @returns queued 状态任务列表
   */
  listQueuedByGroups(groupIds: string[]) {
    if (groupIds.length === 0) return [];
    return this.db.select().from(schema.taskLogs)
      .where(and(
        eq(schema.taskLogs.status, 'queued'),
        inArray(schema.taskLogs.providerId, groupIds),
      ))
      .orderBy(schema.taskLogs.createdAt)
      .all();
  }
}
