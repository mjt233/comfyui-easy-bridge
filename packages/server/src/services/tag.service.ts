import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as schema from '../models/schema';
import type { TagMetadataFieldDef, TagMetadataFieldType } from './tag.types';

/** 标签服务错误（携带业务错误码与 HTTP 状态） */
export class TagError extends Error {
  constructor(
    /** 业务错误码（见设计文档错误码表） */
    public code: string,
    message: string,
    /** HTTP 状态码；默认 400 */
    public status = 400,
  ) {
    super(message);
  }
}

/** tags 表行 */
export type TagRow = typeof schema.tags.$inferSelect;

/** 标签树节点（响应结构） */
export interface TagTreeNode {
  /** 标签 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** 父标签 ID；null=顶层 */
  parentId: string | null;
  /** 是否预设只读 */
  isPreset: number;
  /** 元数据字段定义 */
  metadataDef: TagMetadataFieldDef[];
  /** 子标签（仅树接口返回） */
  children: TagTreeNode[];
}

/** 创建/更新标签的输入 */
export interface TagInput {
  /** 标签 ID（可选，仅创建时生效；缺省/空串时自动生成 uuid；提供时须全局唯一且符合格式） */
  id?: string;
  /** 显示名（必填，同层级唯一） */
  name: string;
  /** 父标签 ID；null=顶层；创建后不可改 */
  parentId?: string | null;
  /** 元数据字段定义；缺省空数组 */
  metadataDef?: TagMetadataFieldDef[];
}

/** 自定义标签 ID 格式：字母/数字开头，仅含字母、数字、连字符、下划线（与预设 ID 风格一致） */
const TAG_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** 字段类型白名单 */
const FIELD_TYPES: readonly TagMetadataFieldType[] = ['number', 'string', 'boolean'];

/**
 * 解析 metadataDef 字符串为字段定义数组；损坏时返回空数组。
 * @param raw 数据库中的 JSON 字符串
 */
export function parseMetadataDef(raw: string): TagMetadataFieldDef[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // 过滤非法项（字段缺失/类型不在白名单/默认值类型不匹配）
    return parsed.filter((item): item is TagMetadataFieldDef => {
      if (!item || typeof item !== 'object') return false;
      const f = item as Record<string, unknown>;
      return typeof f.key === 'string' && f.key !== ''
        && typeof f.label === 'string'
        && FIELD_TYPES.includes(f.type as TagMetadataFieldType)
        && f.type === 'number' ? typeof f.defaultValue === 'number'
        : f.type === 'boolean' ? typeof f.defaultValue === 'boolean'
        : typeof f.defaultValue === 'string';
    });
  } catch {
    return [];
  }
}

/**
 * 校验输入 metadataDef（来自 HTTP body / 调用方）。
 * @param def 待校验的字段定义
 * @returns 规范化后的字段定义数组；非法时返回 null
 */
function validateMetadataDef(def: unknown): TagMetadataFieldDef[] | null {
  if (def === undefined) return [];
  if (!Array.isArray(def)) return null;
  const seen = new Set<string>();
  const out: TagMetadataFieldDef[] = [];
  for (const item of def) {
    if (!item || typeof item !== 'object') return null;
    const f = item as Record<string, unknown>;
    const key = typeof f.key === 'string' ? f.key : '';
    const label = typeof f.label === 'string' ? f.label : '';
    const type = f.type as TagMetadataFieldType;
    if (!key || !label || !FIELD_TYPES.includes(type)) return null;
    if (seen.has(key)) return null; // 键重复
    seen.add(key);
    // 默认值类型必须与 type 匹配
    const ok = type === 'number' ? typeof f.defaultValue === 'number'
      : type === 'boolean' ? typeof f.defaultValue === 'boolean'
      : typeof f.defaultValue === 'string';
    if (!ok) return null;
    out.push({ key, label, type, defaultValue: f.defaultValue as number | string | boolean });
  }
  return out;
}

/**
 * 标签定义服务：CRUD、树组装、预设只读与层级校验。
 */
export class TagService {
  /**
   * @param db Drizzle 数据库实例
   */
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /** 列出全部标签（按创建时间升序） */
  list(): TagRow[] {
    return this.db.select().from(schema.tags).orderBy(schema.tags.createdAt).all();
  }

  /** 按 ID 查询标签 */
  getById(id: string): TagRow | null {
    return this.db.select().from(schema.tags).where(eq(schema.tags.id, id)).get() ?? null;
  }

  /** 组装标签树（顶层节点含 children；children 按创建时间升序） */
  getTree(): TagTreeNode[] {
    const rows = this.list();
    const toNode = (row: TagRow): TagTreeNode => ({
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      isPreset: row.isPreset,
      metadataDef: parseMetadataDef(row.metadataDef),
      children: [],
    });
    const nodes = new Map<string, TagTreeNode>();
    for (const row of rows) nodes.set(row.id, toNode(row));
    const roots: TagTreeNode[] = [];
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) {
        nodes.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  /**
   * 新建标签（自定义）。校验：name 必填、同层级唯一、parentId 存在且为顶层、自定义 ID 合法且全局唯一。
   * @param input 创建输入
   * @returns 新标签行
   * @throws TagError tag_conflict / tag_not_found / tag_has_parent / invalid metadata
   */
  create(input: TagInput): TagRow {
    const name = input.name?.trim();
    if (!name) throw new TagError('missing_parameter', 'missing_parameter: name is required');
    const metadataDef = validateMetadataDef(input.metadataDef);
    if (!metadataDef) throw new TagError('missing_parameter', 'missing_parameter: invalid metadata definition');

    // 自定义 ID：可选；缺省/空串时自动生成 uuid。提供时校验格式与全局唯一性
    const rawId = input.id?.trim();
    let id: string;
    if (rawId) {
      if (!TAG_ID_PATTERN.test(rawId)) {
        throw new TagError(
          'missing_parameter',
          'missing_parameter: tag id must start with a letter or digit and contain only letters, digits, "-" or "_"',
        );
      }
      if (this.getById(rawId)) {
        throw new TagError('tag_conflict', `tag_conflict: tag id "${rawId}" already exists`, 409);
      }
      id = rawId;
    } else {
      id = randomUUID();
    }

    // 规范化 parentId：空串/空白视为顶层（null），避免绕过父标签存在性校验
    const rawParentId = input.parentId ?? null;
    const parentId = typeof rawParentId === 'string' && rawParentId.trim() === '' ? null : rawParentId;
    if (parentId) {
      const parent = this.getById(parentId);
      if (!parent) throw new TagError('tag_not_found', 'tag_not_found: parent tag not found', 404);
      if (parent.parentId) throw new TagError('tag_has_parent', 'tag_has_parent: only one level of child tags allowed');
    }

    // 同层级重名校验
    const conflict = this.list().some((t) => t.name === name && (t.parentId ?? null) === parentId);
    if (conflict) throw new TagError('tag_conflict', `tag_conflict: tag name "${name}" already exists`, 409);

    const now = new Date().toISOString();
    this.db.insert(schema.tags).values({
      id, name, parentId, isPreset: 0,
      metadataDef: JSON.stringify(metadataDef),
      createdAt: now, updatedAt: now,
    }).run();
    return this.getById(id)!;
  }

  /**
   * 更新自定义标签（name / metadataDef；parentId 与 id 创建后不可改，类型层面禁止传入）。预设标签拒绝。
   * @param id 标签 ID
   * @param input 可更新字段（不含 parentId 与 id）
   * @throws TagError tag_not_found / tag_preset_readonly
   */
  update(id: string, input: Omit<Partial<TagInput>, 'parentId' | 'id'>): TagRow {
    const existing = this.getById(id);
    if (!existing) throw new TagError('tag_not_found', 'tag_not_found: tag not found', 404);
    if (existing.isPreset) throw new TagError('tag_preset_readonly', 'tag_preset_readonly: preset tags are read-only', 403);

    const name = input.name !== undefined ? input.name?.trim() : existing.name;
    if (!name) throw new TagError('missing_parameter', 'missing_parameter: name is required');
    const metadataDef = input.metadataDef !== undefined ? validateMetadataDef(input.metadataDef) : parseMetadataDef(existing.metadataDef);
    if (!metadataDef) throw new TagError('missing_parameter', 'missing_parameter: invalid metadata definition');

    // 重名校验（排除自身）
    const conflict = this.list().some((t) => t.id !== id && t.name === name && (t.parentId ?? null) === existing.parentId);
    if (conflict) throw new TagError('tag_conflict', `tag_conflict: tag name "${name}" already exists`, 409);

    this.db.update(schema.tags).set({
      name, metadataDef: JSON.stringify(metadataDef), updatedAt: new Date().toISOString(),
    }).where(eq(schema.tags.id, id)).run();
    return this.getById(id)!;
  }

  /**
   * 删除自定义标签。预设 / 有子标签 / 被工作流引用时拒绝。
   * @param id 标签 ID
   * @throws TagError tag_not_found / tag_preset_readonly / tag_has_children / tag_in_use
   */
  delete(id: string): void {
    const existing = this.getById(id);
    if (!existing) throw new TagError('tag_not_found', 'tag_not_found: tag not found', 404);
    if (existing.isPreset) throw new TagError('tag_preset_readonly', 'tag_preset_readonly: preset tags are read-only', 403);
    const hasChildren = this.list().some((t) => t.parentId === id);
    if (hasChildren) throw new TagError('tag_has_children', 'tag_has_children: tag has child tags', 409);
    const refs = this.db.select().from(schema.workflowTags).where(eq(schema.workflowTags.tagId, id)).all();
    if (refs.length > 0) throw new TagError('tag_in_use', 'tag_in_use: tag is referenced by workflows', 409);
    this.db.delete(schema.tags).where(eq(schema.tags.id, id)).run();
  }
}
