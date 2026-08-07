import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TagError, parseMetadataDef } from './tag.service';
import type { TagMetadataFieldDef, TagMetadataValues, WorkflowTagInput } from './tag.types';

/** 列表/详情响应中的单个标签节点 */
export interface WorkflowTagNode {
  /** 标签 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** 合并默认值后的完整元数据（恒含定义中的全部字段） */
  metadata: TagMetadataValues;
  /** 用户原始配置值（仅含用户填写的键） */
  configuredMetadata: TagMetadataValues;
}

/** 列表/详情响应中的父标签分组 */
export interface WorkflowTagGroup {
  /** 父标签 ID */
  id: string;
  /** 父标签显示名 */
  name: string;
  /** 合并默认值后的完整元数据（父标签自身的元数据；无定义时空对象） */
  metadata: TagMetadataValues;
  /** 用户原始配置值（父标签自身的元数据；未配置时空对象） */
  configuredMetadata: TagMetadataValues;
  /** 该父标签下被选中的子标签 */
  tags: WorkflowTagNode[];
}

/** 工作流标签关联（含标签定义信息，供导入导出） */
export interface WorkflowTagAssociationDetail {
  /** 标签 ID */
  tagId: string;
  /** 显示名 */
  name: string;
  /** 父标签 ID；null=顶层 */
  parentId: string | null;
  /** 是否预设（1=预设只读，0=用户自定义） */
  isPreset: number;
  /** 元数据字段定义 JSON（TagMetadataFieldDef[]） */
  metadataDef: string;
  /** 用户配置的元数据原始值 */
  metadataValues: TagMetadataValues;
}

/**
 * 解析 metadataValues 字符串为对象；损坏时返回空对象。
 * @param raw 数据库中的 JSON 字符串
 */
function parseMetadataValues(raw: string): TagMetadataValues {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as TagMetadataValues;
  } catch {
    return {};
  }
}

/**
 * 校验并规范化 metadataValues（键须属于字段定义，值类型匹配）。
 * @param def 字段定义
 * @param values 待校验值（可能来自 HTTP body）
 * @returns 规范化后的值；非法返回 null
 */
function validateMetadataValues(def: TagMetadataFieldDef[], values: unknown): TagMetadataValues | null {
  if (values === undefined || values === null) return {};
  if (typeof values !== 'object' || Array.isArray(values)) return null;
  const out: TagMetadataValues = {};
  const defMap = new Map(def.map((f) => [f.key, f]));
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    const f = defMap.get(k);
    if (!f) return null;
    const typeOk = f.type === 'number' ? typeof v === 'number'
      : f.type === 'boolean' ? typeof v === 'boolean'
      : typeof v === 'string';
    if (!typeOk) return null;
    out[k] = v as number | string | boolean;
  }
  return out;
}

/**
 * 合并默认值：out[key] = configured[key] ?? def.defaultValue。
 * @param def 字段定义
 * @param configured 用户配置值
 */
function mergeMetadata(def: TagMetadataFieldDef[], configured: TagMetadataValues): TagMetadataValues {
  const out: TagMetadataValues = {};
  for (const f of def) {
    out[f.key] = configured[f.key] ?? f.defaultValue;
  }
  return out;
}

/**
 * 工作流标签服务：整组替换、查询组装（嵌套分组 + 元数据合并）、列表筛选（AND + 父展开）。
 */
export class WorkflowTagService {
  /**
   * @param db Drizzle 数据库实例
   */
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /** 列出全部标签行（供校验与组装） */
  private listAllTags(): Array<typeof schema.tags.$inferSelect> {
    return this.db.select().from(schema.tags).orderBy(schema.tags.createdAt).all();
  }

  /**
   * 整组替换工作流标签（事务）。
   * 校验：标签存在、子必带父、元数据键/值合法。
   * @param workflowId 工作流 ID
   * @param input 标签数组（空数组 = 清除全部）
   * @throws TagError tag_not_found / parent_tag_required / invalid_metadata
   */
  setWorkflowTags(workflowId: string, input: WorkflowTagInput[]): void {
    const tags = this.listAllTags();
    const byId = new Map(tags.map((t) => [t.id, t]));
    const tagIds = input.map((x) => x.tagId);

    // ① 标签存在性
    const missing = tagIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new TagError('tag_not_found', `tag_not_found: tag not found: ${missing[0]}`, 404);
    }

    // ② 子必带父
    for (const t of tags) {
      if (tagIds.includes(t.id) && t.parentId && !tagIds.includes(t.parentId)) {
        throw new TagError('parent_tag_required', `parent_tag_required: parent tag "${t.parentId}" is required for "${t.id}"`);
      }
    }

    // ③ 元数据校验（仅对带 metadataDef 的标签；无定义的标签只允许空值）
    const prepared = new Map<string, string>();
    for (const item of input) {
      const tag = byId.get(item.tagId)!;
      const def = parseMetadataDef(tag.metadataDef);
      const values = validateMetadataValues(def, item.metadataValues);
      if (values === null) {
        throw new TagError('invalid_metadata', `invalid_metadata: invalid metadata for tag "${item.tagId}"`);
      }
      prepared.set(item.tagId, JSON.stringify(values));
    }

    // ④ 事务替换
    this.db.transaction(() => {
      this.db.delete(schema.workflowTags).where(eq(schema.workflowTags.workflowId, workflowId)).run();
      for (const [tagId, values] of prepared) {
        this.db.insert(schema.workflowTags).values({ workflowId, tagId, metadataValues: values }).run();
      }
    });
  }

  /**
   * 组装工作流标签的嵌套分组响应结构。
   * 分组顺序与组内子标签顺序均按关联记录插入顺序（即上次整组打标顺序）。
   * @param workflowId 工作流 ID
   * @returns 父标签分组数组
   */
  getTagGroups(workflowId: string): WorkflowTagGroup[] {
    // 按 rowid（插入顺序）返回，保证“上次整组打标顺序”（复合主键索引扫描默认按 tag_id 字典序）
    const assocs = this.db.select().from(schema.workflowTags).where(eq(schema.workflowTags.workflowId, workflowId)).orderBy(sql`rowid`).all();
    const tags = this.listAllTags();
    const byId = new Map(tags.map((t) => [t.id, t]));
    const groups: WorkflowTagGroup[] = [];
    const childrenByParent = new Map<string, WorkflowTagNode[]>();

    // ① 分组：父标签进 groups（携带自身元数据），子标签暂存
    for (const assoc of assocs) {
      const tag = byId.get(assoc.tagId);
      if (!tag) continue;
      const def = parseMetadataDef(tag.metadataDef);
      const configured = parseMetadataValues(assoc.metadataValues);
      const node: WorkflowTagNode = {
        id: tag.id,
        name: tag.name,
        metadata: mergeMetadata(def, configured),
        configuredMetadata: configured,
      };
      if (tag.parentId == null) {
        // 顶层标签也可配置元数据（根标签定义），分组携带其合并值与原始值
        groups.push({
          id: tag.id,
          name: tag.name,
          metadata: node.metadata,
          configuredMetadata: node.configuredMetadata,
          tags: [],
        });
      } else {
        const arr = childrenByParent.get(tag.parentId) ?? [];
        arr.push(node);
        childrenByParent.set(tag.parentId, arr);
      }
    }

    // ② 子标签挂到父分组（防御：父未显式打标也建组，此时父标签无关联记录，元数据为空）
    for (const [parentId, children] of childrenByParent) {
      const group = groups.find((g) => g.id === parentId);
      if (group) {
        group.tags = children;
      } else {
        const parent = byId.get(parentId);
        groups.push({
          id: parentId,
          name: parent?.name ?? parentId,
          metadata: {},
          configuredMetadata: {},
          tags: children,
        });
      }
    }
    return groups;
  }

  /**
   * 查询工作流的全部标签关联（含标签定义），供导出使用。
   * @param workflowId 工作流 ID
   * @returns 标签关联明细数组（按关联记录插入顺序）
   */
  listAssociationsWithTags(workflowId: string): WorkflowTagAssociationDetail[] {
    // 按 rowid（插入顺序）返回，与 getTagGroups 保持一致
    const assocs = this.db.select().from(schema.workflowTags).where(eq(schema.workflowTags.workflowId, workflowId)).orderBy(sql`rowid`).all();
    const tags = this.listAllTags();
    const byId = new Map(tags.map((t) => [t.id, t]));
    return assocs
      .map((a) => {
        const tag = byId.get(a.tagId);
        if (!tag) return null;
        return {
          tagId: a.tagId,
          name: tag.name,
          parentId: tag.parentId,
          isPreset: tag.isPreset,
          metadataDef: tag.metadataDef,
          metadataValues: parseMetadataValues(a.metadataValues),
        };
      })
      .filter((x): x is WorkflowTagAssociationDetail => x !== null);
  }

  /**
   * 按标签筛选工作流 ID（AND 语义 + 父标签向下包含）。
   * @param selectedTags 选中的标签 ID 数组（空数组返回 null 表示不过滤）
   * @returns 命中的工作流 ID 数组；selectedTags 为空时返回 null
   */
  listWorkflowIdsByTags(selectedTags: string[]): string[] | null {
    if (selectedTags.length === 0) return null;
    const tags = this.listAllTags();
    const byId = new Map(tags.map((t) => [t.id, t]));
    const childrenOf = new Map<string, string[]>();
    for (const t of tags) {
      if (t.parentId) {
        const arr = childrenOf.get(t.parentId) ?? [];
        arr.push(t.id);
        childrenOf.set(t.parentId, arr);
      }
    }

    // 每个选中标签展开为有效 ID 集合
    const effectiveSets: string[][] = [];
    for (const id of selectedTags) {
      const tag = byId.get(id);
      if (!tag) continue; // 未知标签忽略（无命中）
      if (tag.parentId == null) {
        effectiveSets.push([id, ...(childrenOf.get(id) ?? [])]);
      } else {
        effectiveSets.push([id]);
      }
    }
    if (effectiveSets.length === 0) return [];

    // 多集合 AND：每个集合一个 EXISTS 子查询（IN 列表用 sql.join 参数化绑定，避免拼接字符串）
    const conditions = effectiveSets.map((ids) => {
      const inList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
      return sql`EXISTS (SELECT 1 FROM workflow_tags wt WHERE wt.workflow_id = workflows.id AND wt.tag_id IN (${inList}))`;
    });
    const rows = this.db.all<{ id: string }>(sql`SELECT id FROM workflows WHERE ${sql.join(conditions, sql` AND `)}`);
    return rows.map((r) => r.id);
  }
}
