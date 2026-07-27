import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

interface CreateWorkflowInput {
  id: string;
  name: string;
  rawJson: string;
}

interface UpdateWorkflowInput {
  id?: string;
  name?: string;
  rawJson?: string;
}

interface AddParamInput {
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label?: string;
  paramType?: string;
}

interface UpdateParamInput {
  alias?: string;
  label?: string | null;
  paramType?: string;
}

export class WorkflowService {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  create(input: CreateWorkflowInput) {
    const now = new Date().toISOString();
    this.db.insert(schema.workflows).values({
      id: input.id,
      name: input.name,
      rawJson: input.rawJson,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.getById(input.id)!;
  }

  list() {
    return this.db.select().from(schema.workflows).orderBy(schema.workflows.createdAt).all();
  }

  getById(id: string) {
    return this.db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get() ?? null;
  }

  update(id: string, input: UpdateWorkflowInput) {
    const now = new Date().toISOString();

    if (input.id && input.id !== id) {
      // 预取旧值，在事务内用于 fallback
      const existing = this.getById(id);
      if (!existing) throw new Error('Workflow not found');

      // 事务级联更新三张表
      // 策略：先 INSERT 新行（使新 ID 成为有效的 FK 目标），再更新子表 FK，最后删除旧行
      // 不使用 UPDATE 主键是因为 SQLite FK 约束禁止在子行引用时修改父键
      this.db.transaction(() => {
        // ① 插入新 workflows 行（新 ID）
        this.db.insert(schema.workflows).values({
          id: input.id!,
          name: input.name ?? existing.name,
          rawJson: input.rawJson ?? existing.rawJson,
          createdAt: existing.createdAt,
          updatedAt: now,
        }).run();
        // ② 级联更新 workflow_params 外键
        this.db.update(schema.workflowParams)
          .set({ workflowId: input.id! })
          .where(eq(schema.workflowParams.workflowId, id))
          .run();
        // ③ 级联更新 task_logs 外键
        this.db.update(schema.taskLogs)
          .set({ workflowId: input.id! })
          .where(eq(schema.taskLogs.workflowId, id))
          .run();
        // ④ 删除旧 workflows 行（此时已无子行引用旧 ID，不会级联删除已迁移的子行）
        this.db.delete(schema.workflows).where(eq(schema.workflows.id, id)).run();
      });
      return this.getById(input.id)!;
    }

    // ID 不变，保持原有单表更新
    this.db.update(schema.workflows)
      .set({ ...input, updatedAt: now })
      .where(eq(schema.workflows.id, id))
      .run();
    return this.getById(id)!;
  }

  delete(id: string) {
    this.db.delete(schema.workflows).where(eq(schema.workflows.id, id)).run();
  }

  addParam(input: AddParamInput) {
    this.db.insert(schema.workflowParams).values({
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      fieldName: input.fieldName,
      alias: input.alias,
      label: input.label ?? null,
      paramType: input.paramType ?? 'text',
    }).run();
    return this.db.select().from(schema.workflowParams)
      .where(and(
        eq(schema.workflowParams.workflowId, input.workflowId),
        eq(schema.workflowParams.alias, input.alias),
      ))
      .get()!;
  }

  getParams(workflowId: string) {
    return this.db.select()
      .from(schema.workflowParams)
      .where(eq(schema.workflowParams.workflowId, workflowId))
      .all();
  }

  updateParam(id: number, input: UpdateParamInput) {
    this.db.update(schema.workflowParams)
      .set(input)
      .where(eq(schema.workflowParams.id, id))
      .run();
    return this.db.select().from(schema.workflowParams)
      .where(eq(schema.workflowParams.id, id))
      .get()!;
  }

  deleteParam(id: number) {
    this.db.delete(schema.workflowParams).where(eq(schema.workflowParams.id, id)).run();
  }
}
