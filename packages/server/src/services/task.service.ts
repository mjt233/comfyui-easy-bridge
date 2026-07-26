import { eq, desc, inArray, count } from 'drizzle-orm';
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
  /** 请求 ComfyUI 的完整 URL */
  comfyuiUrl: string;
  /** 请求体 JSON */
  comfyuiRequestBody: string | null;
  /** ComfyUI 响应 JSON */
  comfyuiResponse: string | null;
  /** ComfyUI 返回的 prompt_id，为 null 表示提交失败 */
  promptId: string | null;
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

  /** 创建任务日志记录。若 promptId 有值则状态为 pending，否则标记为 failed */
  create(input: CreateTaskInput) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.insert(schema.taskLogs).values({
      id,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      aliasValues: input.aliasValues,
      comfyuiUrl: input.comfyuiUrl,
      comfyuiRequestBody: input.comfyuiRequestBody,
      comfyuiResponse: input.comfyuiResponse,
      promptId: input.promptId,
      status: input.promptId ? 'pending' : 'failed',
      errorMessage: null,
      createdAt: now,
      completedAt: input.promptId ? null : now,
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

  /** 更新任务状态和结果 */
  updateStatus(id: string, input: UpdateTaskResult) {
    const now = new Date().toISOString();
    this.db.update(schema.taskLogs)
      .set({
        status: input.status,
        promptId: input.promptId,
        comfyuiResponse: input.comfyuiResponse,
        errorMessage: input.errorMessage ?? null,
        completedAt: input.completedAt ?? now,
      })
      .where(eq(schema.taskLogs.id, id))
      .run();
    return this.getById(id)!;
  }

  /** 查询所有 pending 状态的任务（供 PollingService 轮询使用） */
  listPending() {
    return this.db.select().from(schema.taskLogs)
      .where(eq(schema.taskLogs.status, 'pending'))
      .all();
  }

  /** 删除所有已完成和失败的任务，返回删除数量 */
  clearCompleted(): number {
    const result = this.db.delete(schema.taskLogs)
      .where(inArray(schema.taskLogs.status, ['completed', 'failed']))
      .run();
    return result.changes;
  }

  /** 统计指定状态的任务数 */
  countByStatus(status: string): number {
    const row = this.db.select({ c: count() }).from(schema.taskLogs)
      .where(eq(schema.taskLogs.status, status)).get();
    return row?.c ?? 0;
  }

  /** 获取所有 queued 任务（按提交时间升序） */
  listQueued() {
    return this.db.select().from(schema.taskLogs)
      .where(eq(schema.taskLogs.status, 'queued'))
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
}
