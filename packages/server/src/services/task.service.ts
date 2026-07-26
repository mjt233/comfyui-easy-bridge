import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { randomUUID } from 'crypto';

export interface CreateTaskInput {
  workflowId: string;
  workflowName: string;
  aliasValues: string;
  comfyuiUrl: string;
  comfyuiRequestBody: string | null;
  comfyuiResponse: string | null;
  promptId: string | null;
}

export interface UpdateTaskResult {
  status: 'completed' | 'failed';
  promptId?: string;
  comfyuiResponse?: string;
  errorMessage?: string;
  completedAt?: string;
}

export class TaskService {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

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

    // Get the created record back
    return this.getById(id)!;
  }

  getById(id: string) {
    return this.db.select().from(schema.taskLogs).where(eq(schema.taskLogs.id, id)).get() ?? null;
  }

  list() {
    return this.db.select().from(schema.taskLogs)
      .orderBy(schema.taskLogs.createdAt).all();
  }

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

  listPending() {
    return this.db.select().from(schema.taskLogs)
      .where(eq(schema.taskLogs.status, 'pending'))
      .all();
  }
}
