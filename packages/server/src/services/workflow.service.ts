import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

interface CreateWorkflowInput {
  id: string;
  name: string;
  rawJson: string;
}

interface UpdateWorkflowInput {
  name?: string;
  rawJson?: string;
}

interface AddParamInput {
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label?: string;
}

interface UpdateParamInput {
  alias?: string;
  label?: string | null;
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
    }).run();
    return this.db.select().from(schema.workflowParams)
      .where(eq(schema.workflowParams.alias, input.alias))
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
