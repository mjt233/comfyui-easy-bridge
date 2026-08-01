import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

/**
 * 创建工作流的输入
 */
interface CreateWorkflowInput {
  /** 工作流 ID */
  id: string;
  /** 工作流名称 */
  name: string;
  /** 原始 JSON 字符串 */
  rawJson: string;
}

/**
 * 更新工作流的输入
 */
interface UpdateWorkflowInput {
  /** 可选新 ID */
  id?: string;
  /** 可选新名称 */
  name?: string;
  /** 可选新 rawJson */
  rawJson?: string;
}

/**
 * 新增参数配置的输入
 */
interface AddParamInput {
  /** 工作流 ID */
  workflowId: string;
  /** 节点 ID */
  nodeId: string;
  /** 字段名 */
  fieldName: string;
  /** 可选别名 */
  alias?: string | null;
  /** 可选标签 */
  label?: string;
  /** 参数类型；无 alias 时强制 text */
  paramType?: string;
  /** 默认值覆盖 */
  defaultValue?: string | null;
}

/**
 * 更新参数配置的输入
 */
interface UpdateParamInput {
  /** 别名；可清空为 null */
  alias?: string | null;
  /** 标签 */
  label?: string | null;
  /** 参数类型 */
  paramType?: string;
  /** 默认值覆盖；可清空为 null */
  defaultValue?: string | null;
}

/**
 * 保存动态构建脚本的输入
 */
interface UpdateBuildScriptInput {
  /** 脚本源码 */
  script: string;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * 规范化别名：空字符串视为 null
 * @param alias 原始别名
 * @returns 规范化后的别名
 */
function normalizeAlias(alias: string | null | undefined): string | null {
  if (alias == null) return null;
  const trimmed = alias.trim();
  return trimmed === '' ? null : trimmed;
}

/** 需要 alias 的媒体类型 */
const MEDIA_PARAM_TYPES = new Set(['image', 'video', 'audio']);

/**
 * 解析最终 paramType。
 * 无 alias 时允许 text/boolean/number；媒体类型强制回退 text。
 * @param alias 规范化别名
 * @param paramType 请求类型
 * @returns 最终类型
 */
function resolveParamType(alias: string | null, paramType?: string): string {
  const type = paramType ?? 'text';
  // 无别名时禁止媒体类型
  if (alias == null && MEDIA_PARAM_TYPES.has(type)) {
    return 'text';
  }
  return type;
}

/**
 * 工作流与参数配置的业务服务
 */
export class WorkflowService {
  /**
   * @param db Drizzle 数据库实例
   */
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /**
   * 创建工作流
   * @param input 创建输入
   * @returns 新建的工作流行
   */
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

  /**
   * 列出全部工作流
   * @returns 工作流列表
   */
  list() {
    return this.db.select().from(schema.workflows).orderBy(schema.workflows.createdAt).all();
  }

  /**
   * 按 ID 查询工作流
   * @param id 工作流 ID
   * @returns 工作流行或 null
   */
  getById(id: string) {
    return this.db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get() ?? null;
  }

  /**
   * 更新工作流；支持修改主键并级联子表
   * @param id 当前工作流 ID
   * @param input 更新字段
   * @returns 更新后的工作流行
   */
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
          buildScript: existing.buildScript,
          buildScriptEnabled: existing.buildScriptEnabled,
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

  /**
   * 删除工作流
   * @param id 工作流 ID
   */
  delete(id: string) {
    this.db.delete(schema.workflows).where(eq(schema.workflows.id, id)).run();
  }

  /**
   * 新增工作流参数配置
   * @param input 参数输入
   * @returns 新建的参数行
   */
  addParam(input: AddParamInput) {
    // 规范化别名：空串视为 null
    const alias = normalizeAlias(input.alias);
    // 未传 defaultValue 时落库为 null
    const defaultValue = input.defaultValue === undefined ? null : input.defaultValue;

    // 至少需要 alias 或 defaultValue 之一
    if (alias == null && defaultValue == null) {
      throw new Error('Either alias or defaultValue is required');
    }

    // 无 alias 时强制 text，避免媒体类型无入口
    const paramType = resolveParamType(alias, input.paramType);

    this.db.insert(schema.workflowParams).values({
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      fieldName: input.fieldName,
      alias,
      label: input.label ?? null,
      paramType,
      defaultValue,
    }).run();

    // 按主键回查：alias 可能为 null，不能仅靠 alias 查询
    return this.db.select().from(schema.workflowParams)
      .where(and(
        eq(schema.workflowParams.workflowId, input.workflowId),
        eq(schema.workflowParams.nodeId, input.nodeId),
        eq(schema.workflowParams.fieldName, input.fieldName),
      ))
      .get()!;
  }

  /**
   * 列出工作流参数
   * @param workflowId 工作流 ID
   * @returns 参数列表
   */
  getParams(workflowId: string) {
    return this.db.select()
      .from(schema.workflowParams)
      .where(eq(schema.workflowParams.workflowId, workflowId))
      .all();
  }

  /**
   * 更新参数配置
   * @param id 参数行 ID
   * @param input 更新字段
   * @returns 更新后的参数行
   */
  updateParam(id: number, input: UpdateParamInput) {
    // 读取现有行，合并后校验
    const existing = this.db.select().from(schema.workflowParams)
      .where(eq(schema.workflowParams.id, id))
      .get();
    if (!existing) {
      throw new Error('Param not found');
    }

    // 合并 alias / defaultValue，未传字段保持原值
    const nextAlias = input.alias !== undefined ? normalizeAlias(input.alias) : existing.alias;
    const nextDefault = input.defaultValue !== undefined ? input.defaultValue : existing.defaultValue;

    // 更新后仍需至少保留 alias 或 defaultValue 之一
    if (nextAlias == null && nextDefault == null) {
      throw new Error('Either alias or defaultValue is required');
    }

    // 无 alias 时强制 text
    const nextType = resolveParamType(
      nextAlias,
      input.paramType !== undefined ? input.paramType : existing.paramType,
    );

    this.db.update(schema.workflowParams)
      .set({
        alias: nextAlias,
        label: input.label !== undefined ? input.label : existing.label,
        paramType: nextType,
        defaultValue: nextDefault,
      })
      .where(eq(schema.workflowParams.id, id))
      .run();

    return this.db.select().from(schema.workflowParams)
      .where(eq(schema.workflowParams.id, id))
      .get()!;
  }

  /**
   * 删除参数配置
   * @param id 参数行 ID
   */
  deleteParam(id: number) {
    this.db.delete(schema.workflowParams).where(eq(schema.workflowParams.id, id)).run();
  }

  /**
   * 保存动态构建脚本与启用状态
   * @param id 工作流 ID
   * @param input 脚本与启用状态
   * @returns 更新后的工作流行
   */
  updateBuildScript(id: string, input: UpdateBuildScriptInput) {
    this.db.update(schema.workflows)
      .set({
        buildScript: input.script,
        buildScriptEnabled: input.enabled ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflows.id, id))
      .run();
    return this.getById(id);
  }
}
