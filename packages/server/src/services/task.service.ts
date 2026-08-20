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

    this.db.update(schema.taskLogs)
      .set({
        status: input.status,
        promptId: input.promptId,
        comfyuiResponse: input.comfyuiResponse,
        errorMessage: input.errorMessage ?? null,
        ...timeFields,
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
}
