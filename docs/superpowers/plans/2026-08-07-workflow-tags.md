# 工作流标签系统实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为工作流实现多标签、父子分级、元数据定义与列表筛选，并支持导入导出与前端管理页面。

**Architecture:** 后端新增 `tags` 与 `workflow_tags` 两张表（迁移 v5），新增 `TagService`（标签定义 CRUD/树）与 `WorkflowTagService`（工作流标签替换/筛选/元数据合并），接入 `routes → controllers → services` 分层；导入导出 manifest 升级 v2。前端新增标签管理页、标签编辑弹窗，并改造列表/详情页。预设标签只读，自定义标签可管理；打子标签必带父标签。

**Tech Stack:** Node.js + Express + TypeScript + Drizzle ORM (SQLite)、Vue 3 + Vuetify + TypeScript、vitest + supertest、JSZip。

**Spec:** `docs/superpowers/specs/2026-08-07-workflow-tags-design.md`

---

## 文件结构总览

**后端新增：**
- `packages/server/src/models/migrations/v5-workflow-tags.ts` — 迁移 v5（建表 + 种子预设）
- `packages/server/src/services/tag.service.ts` — TagService（标签 CRUD + 树 + 校验）+ `tag.service.test.ts`
- `packages/server/src/services/workflow-tag.service.ts` — WorkflowTagService（关联替换/筛选/合并）+ `workflow-tag.service.test.ts`
- `packages/server/src/controllers/tags.controller.ts` — 标签 CRUD 控制器
- `packages/server/src/routes/tags.routes.ts` — `/api/tags` 路由 + `tags.routes.test.ts`

**后端修改：**
- `packages/server/src/models/schema.ts` — 新增 `tags` / `workflowTags` 表定义
- `packages/server/src/models/migrations/index.ts` — 注册 v5
- `packages/server/src/services/param.types.ts` — 新增标签元数据类型（或新建 `tag.types.ts`）
- `packages/server/src/controllers/workflow.controller.ts` — list 筛选+tags、getById 补 tags、新增 setTags
- `packages/server/src/routes/workflow.routes.ts` — 注册 `PUT /:id/tags`
- `packages/server/src/services/workflow-io.service.ts` — manifest v2 标签导入导出 + 测试
- `packages/server/src/index.ts` — 挂载 `/api/tags`

**前端新增：**
- `packages/client/src/api/tags.ts` — 标签 API 模块
- `packages/client/src/components/WorkflowTagEditorDialog.vue` — 工作流打标签弹窗（层级选择 + 元数据编辑）
- `packages/client/src/pages/TagManagementPage.vue` — 标签管理页

**前端修改：**
- `packages/client/src/types/index.ts` — 标签相关类型 + `Workflow.tags`
- `packages/client/src/api/workflows.ts` — listWorkflows 支持筛选参数
- `packages/client/src/router/index.ts` — `/admin/tags` 路由
- `packages/client/src/pages/WorkflowDetailPage.vue` — 标签卡片 + 编辑弹窗
- `packages/client/src/pages/WorkflowListPage.vue` — 标签 chips、筛选条、编辑入口、导航按钮

---

### Task 1: 迁移 v5 + Schema 表定义

**Files:**
- Modify: `packages/server/src/models/schema.ts`
- Create: `packages/server/src/models/migrations/v5-workflow-tags.ts`
- Modify: `packages/server/src/models/migrations/index.ts`
- Test: `packages/server/src/models/migrations/v5-workflow-tags.test.ts`（或并入现有迁移测试模式）

- [ ] **Step 1: schema.ts 新增两张表**

在 `packages/server/src/models/schema.ts` 末尾（settings 之后）追加：

```ts
/** 标签定义（父/子两级；预设标签只读） */
export const tags = sqliteTable('tags', {
  /** 标签 ID：预设为固定英文标识（如 "image-to-video"），自定义为 uuid */
  id: text('id').primaryKey(),
  /** 显示名（同层级内唯一） */
  name: text('name').notNull(),
  /** 父标签 id；null 表示顶层标签 */
  parentId: text('parent_id'),
  /** 是否预设（1=只读参考模板，0=用户自定义） */
  isPreset: integer('is_preset').notNull().default(0),
  /** 元数据字段定义 JSON：TagMetadataFieldDef[] */
  metadataDef: text('metadata_def').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 工作流 ↔ 标签 多对多关联 */
export const workflowTags = sqliteTable('workflow_tags', {
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  /** 用户为工作流配置的元数据原始值 JSON：{key: value}；未配置的键不存在 */
  metadataValues: text('metadata_values').notNull().default('{}'),
}, (table) => ({
  pk: primaryKey({ columns: [table.workflowId, table.tagId] }),
}));
```

同时更新顶部 import，增加 `primaryKey`：

```ts
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
```

- [ ] **Step 2: 新建迁移 v5-workflow-tags.ts**

```ts
import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/** 预设标签元数据字段定义（全能参考） */
const REFERENCE_METADATA_DEF = JSON.stringify([
  { key: 'maxImageCount', label: '图片数量', type: 'number', defaultValue: 9 },
  { key: 'maxAudioCount', label: '音频数量', type: 'number', defaultValue: 3 },
  { key: 'maxVideoCount', label: '视频数量', type: 'number', defaultValue: 3 },
  { key: 'maxTotalCount', label: '参考总数量', type: 'number', defaultValue: 12 },
]);

/** 预设标签种子数据（父在前） */
const PRESET_TAGS: ReadonlyArray<{ id: string; name: string; parentId: string | null; metadataDef: string }> = [
  { id: 'text-to-image', name: '文生图', parentId: null, metadataDef: '[]' },
  { id: 'image-edit', name: '图片编辑', parentId: null, metadataDef: '[]' },
  { id: 'text-to-video', name: '文生视频', parentId: null, metadataDef: '[]' },
  { id: 'image-to-video', name: '图生视频', parentId: null, metadataDef: '[]' },
  { id: 'reference', name: '全能参考', parentId: 'image-to-video', metadataDef: REFERENCE_METADATA_DEF },
  { id: 'first-frame', name: '首帧', parentId: 'image-to-video', metadataDef: '[]' },
  { id: 'first-last-frame', name: '首尾帧', parentId: 'image-to-video', metadataDef: '[]' },
  { id: 'director', name: '导演台', parentId: 'image-to-video', metadataDef: '[]' },
  { id: 'audio-input', name: '音频输入', parentId: 'image-to-video', metadataDef: '[]' },
  { id: 'audio-output', name: '音频输出', parentId: 'image-to-video', metadataDef: '[]' },
  { id: 'tts-voice-design', name: 'TTS音色设计', parentId: null, metadataDef: '[]' },
];

/**
 * 迁移 5：工作流标签系统。
 * 新建 tags / workflow_tags 表，并种子预设标签（幂等）。
 */
export const v5: Migration = {
  version: 5,
  name: 'workflow tags',
  up: (sqlite: Database) => {
    // ① tags 表（幂等）
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        is_preset INTEGER NOT NULL DEFAULT 0,
        metadata_def TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // ② workflow_tags 表（幂等）
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS workflow_tags (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        metadata_values TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (workflow_id, tag_id)
      )
    `);
    // ③ 种子预设标签（已存在同 id 则跳过）
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      'INSERT OR IGNORE INTO tags (id, name, parent_id, is_preset, metadata_def, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    );
    for (const t of PRESET_TAGS) {
      insert.run(t.id, t.name, t.parentId, t.metadataDef, now, now);
    }
  },
};
```

- [ ] **Step 3: 注册迁移**

在 `packages/server/src/models/migrations/index.ts` 追加：

```ts
import { v5 } from './v5-workflow-tags';
// ...
export const migrations: readonly Migration[] = [v1, v2, v3, v4, v5];
```

- [ ] **Step 4: 写迁移测试（确认种子数据与建表）**

新建 `packages/server/src/models/migrations/v5-workflow-tags.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './runner';

describe('迁移 v5 工作流标签', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    runMigrations(sqlite);
  });

  it('创建 tags / workflow_tags 表并种子预设标签', () => {
    const rows = sqlite.prepare('SELECT id, name, parent_id, is_preset FROM tags ORDER BY created_at').all() as Array<{
      id: string; name: string; parent_id: string | null; is_preset: number;
    }>;
    expect(rows.length).toBe(11);
    const imageToVideo = rows.find((r) => r.id === 'image-to-video');
    expect(imageToVideo?.name).toBe('图生视频');
    expect(imageToVideo?.is_preset).toBe(1);
    const reference = rows.find((r) => r.id === 'reference');
    expect(reference?.parent_id).toBe('image-to-video');
    const def = JSON.parse(
      (sqlite.prepare("SELECT metadata_def FROM tags WHERE id='reference'").get() as { metadata_def: string }).metadata_def,
    ) as Array<{ key: string; defaultValue: number }>;
    expect(def.find((d) => d.key === 'maxImageCount')?.defaultValue).toBe(9);
  });

  it('重复执行迁移幂等', () => {
    runMigrations(sqlite); // 再次执行不应报错
    const count = sqlite.prepare('SELECT COUNT(*) AS c FROM tags').get() as { c: number };
    expect(count.c).toBe(11);
  });
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter server exec vitest run src/models/migrations/v5-workflow-tags.test.ts`
Expected: 2 passing

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/models/schema.ts packages/server/src/models/migrations/v5-workflow-tags.ts packages/server/src/models/migrations/index.ts packages/server/src/models/migrations/v5-workflow-tags.test.ts
git commit -m "feat: 工作流标签迁移 v5（tags / workflow_tags 表 + 预设标签种子）"
```

---

### Task 2: 标签元数据类型 + TagService

**Files:**
- Modify: `packages/server/src/services/param.types.ts`（追加标签元数据类型；或新建 `packages/server/src/services/tag.types.ts`——推荐新建，避免污染 param 类型）
- Create: `packages/server/src/services/tag.service.ts`
- Test: `packages/server/src/services/tag.service.test.ts`

- [ ] **Step 1: 写类型定义**

新建 `packages/server/src/services/tag.types.ts`：

```ts
/** 标签元数据字段类型 */
export type TagMetadataFieldType = 'number' | 'string' | 'boolean';

/** 标签元数据字段定义（metadataDef 数组元素） */
export interface TagMetadataFieldDef {
  /** 字段键，如 "maxImageCount" */
  key: string;
  /** 显示名，如 "图片数量" */
  label: string;
  /** 字段类型 */
  type: TagMetadataFieldType;
  /** 默认值（类型与 type 匹配） */
  defaultValue: number | string | boolean;
}

/** 标签元数据值（工作流配置的原始值 / 合并默认值后的完整值） */
export type TagMetadataValues = Record<string, number | string | boolean>;

/** 工作流打标签的输入项 */
export interface WorkflowTagInput {
  /** 标签 ID */
  tagId: string;
  /** 用户配置的元数据原始值（可选；缺省空对象） */
  metadataValues?: TagMetadataValues;
}
```

- [ ] **Step 2: 写失败测试**

新建 `packages/server/src/services/tag.service.test.ts`（覆盖：CRUD、预设只读、同层重名、层级校验、metadataDef 校验、删除拒绝）。使用 `:memory:` 数据库 + `runMigrations`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from '../models/migrations/runner';
import * as schema from '../models/schema';
import { TagService, TagError } from './tag.service';
import type { TagMetadataFieldDef } from './tag.types';

describe('TagService', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let service: TagService;

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    runMigrations(sqlite);
    db = drizzle(sqlite, { schema });
    service = new TagService(db);
  });

  it('列出全部标签（含预设种子）', () => {
    expect(service.list().length).toBe(11);
  });

  it('组装标签树（父含 children）', () => {
    const tree = service.getTree();
    const parent = tree.find((t) => t.id === 'image-to-video');
    expect(parent?.children.map((c) => c.id)).toContain('reference');
    expect(parent?.children.map((c) => c.id)).toContain('first-frame');
  });

  it('新建顶层自定义标签', () => {
    const tag = service.create({ name: '我的标签', parentId: null, metadataDef: [] });
    expect(tag.isPreset).toBe(0);
    expect(service.getById(tag.id)?.name).toBe('我的标签');
  });

  it('新建子标签', () => {
    const parent = service.create({ name: '父', parentId: null, metadataDef: [] });
    const child = service.create({ name: '子', parentId: parent.id, metadataDef: [] });
    expect(child.parentId).toBe(parent.id);
  });

  it('同层级重名抛 tag_conflict', () => {
    service.create({ name: '重名', parentId: null, metadataDef: [] });
    expect(() => service.create({ name: '重名', parentId: null, metadataDef: [] }))
      .toThrowError(/tag_conflict/);
  });

  it('不同层级允许重名', () => {
    const parent = service.create({ name: '重名', parentId: null, metadataDef: [] });
    expect(() => service.create({ name: '重名', parentId: parent.id, metadataDef: [] })).not.toThrow();
  });

  it('parentId 不存在抛 tag_not_found', () => {
    expect(() => service.create({ name: '子', parentId: 'nope', metadataDef: [] }))
      .toThrowError(/tag_not_found/);
  });

  it('不允许二级子标签（parentId 指向的标签不能再有父）', () => {
    const parent = service.create({ name: '父', parentId: null, metadataDef: [] });
    const child = service.create({ name: '子', parentId: parent.id, metadataDef: [] });
    expect(() => service.create({ name: '孙', parentId: child.id, metadataDef: [] }))
      .toThrowError(/tag_has_parent/);
  });

  it('metadataDef 非法类型抛 missing_parameter', () => {
    expect(() => service.create({
      name: 'x', parentId: null,
      metadataDef: [{ key: 'k', label: 'k', type: 'date', defaultValue: 1 } as unknown as TagMetadataFieldDef],
    })).toThrowError(/invalid metadata/);
  });

  it('预设标签编辑抛 tag_preset_readonly', () => {
    const preset = service.getById('text-to-image')!;
    expect(() => service.update(preset.id, { name: '改名' })).toThrowError(/tag_preset_readonly/);
    expect(() => service.delete(preset.id)).toThrowError(/tag_preset_readonly/);
  });

  it('删除有子标签的自定义标签抛 tag_has_children', () => {
    const parent = service.create({ name: '父', parentId: null, metadataDef: [] });
    service.create({ name: '子', parentId: parent.id, metadataDef: [] });
    expect(() => service.delete(parent.id)).toThrowError(/tag_has_children/);
  });

  it('删除被工作流引用的标签抛 tag_in_use', () => {
    const tag = service.create({ name: '用', parentId: null, metadataDef: [] });
    db.insert(schema.workflows).values({
      id: 'wf1', name: 'wf', rawJson: '{}', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }).run();
    db.insert(schema.workflowTags).values({ workflowId: 'wf1', tagId: tag.id, metadataValues: '{}' }).run();
    expect(() => service.delete(tag.id)).toThrowError(/tag_in_use/);
  });

  it('删除未被引用的自定义标签成功', () => {
    const tag = service.create({ name: '删', parentId: null, metadataDef: [] });
    service.delete(tag.id);
    expect(service.getById(tag.id)).toBeNull();
  });

  it('更新自定义标签的 name 与 metadataDef', () => {
    const tag = service.create({ name: '旧', parentId: null, metadataDef: [] });
    const updated = service.update(tag.id, {
      name: '新',
      metadataDef: [{ key: 'n', label: '数量', type: 'number', defaultValue: 3 }],
    });
    expect(updated.name).toBe('新');
    expect(JSON.parse(updated.metadataDef)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/services/tag.service.test.ts`
Expected: FAIL（`tag.service` 模块不存在）

- [ ] **Step 4: 实现 TagService**

新建 `packages/server/src/services/tag.service.ts`（完整实现，含 `TagError`、解析/校验工具、树组装；`TagMetadataFieldType` 白名单为 `['number','string','boolean']`）：

```ts
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
  /** 显示名（必填，同层级唯一） */
  name: string;
  /** 父标签 ID；null=顶层；创建后不可改 */
  parentId?: string | null;
  /** 元数据字段定义；缺省空数组 */
  metadataDef?: TagMetadataFieldDef[];
}

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
    const defCache = new Map<string, TagMetadataFieldDef[]>();
    const toNode = (row: TagRow): TagTreeNode => {
      let def = defCache.get(row.id);
      if (!def) { def = parseMetadataDef(row.metadataDef); defCache.set(row.id, def); }
      return { id: row.id, name: row.name, parentId: row.parentId, isPreset: row.isPreset, metadataDef: def, children: [] };
    };
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
   * 新建标签（自定义）。校验：name 必填、同层级唯一、parentId 存在且为顶层。
   * @param input 创建输入
   * @returns 新标签行
   * @throws TagError tag_conflict / tag_not_found / tag_has_parent / invalid metadata
   */
  create(input: TagInput): TagRow {
    const name = input.name?.trim();
    if (!name) throw new TagError('missing_parameter', 'name is required');
    const metadataDef = validateMetadataDef(input.metadataDef);
    if (!metadataDef) throw new TagError('missing_parameter', 'invalid metadata definition');

    const parentId = input.parentId ?? null;
    if (parentId) {
      const parent = this.getById(parentId);
      if (!parent) throw new TagError('tag_not_found', 'parent tag not found', 404);
      if (parent.parentId) throw new TagError('tag_has_parent', 'only one level of child tags allowed');
    }

    // 同层级重名校验
    const conflict = this.list().some((t) => t.name === name && (t.parentId ?? null) === parentId);
    if (conflict) throw new TagError('tag_conflict', `tag name "${name}" already exists`, 409);

    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.insert(schema.tags).values({
      id, name, parentId, isPreset: 0,
      metadataDef: JSON.stringify(metadataDef),
      createdAt: now, updatedAt: now,
    }).run();
    return this.getById(id)!;
  }

  /**
   * 更新自定义标签（name / metadataDef）。预设标签拒绝。
   * @param id 标签 ID
   * @param input 可更新字段
   * @throws TagError tag_not_found / tag_preset_readonly
   */
  update(id: string, input: Partial<TagInput>): TagRow {
    const existing = this.getById(id);
    if (!existing) throw new TagError('tag_not_found', 'tag not found', 404);
    if (existing.isPreset) throw new TagError('tag_preset_readonly', 'preset tags are read-only', 403);

    const name = input.name !== undefined ? input.name?.trim() : existing.name;
    if (!name) throw new TagError('missing_parameter', 'name is required');
    const metadataDef = input.metadataDef !== undefined ? validateMetadataDef(input.metadataDef) : parseMetadataDef(existing.metadataDef);
    if (!metadataDef) throw new TagError('missing_parameter', 'invalid metadata definition');

    // 重名校验（排除自身）
    const conflict = this.list().some((t) => t.id !== id && t.name === name && (t.parentId ?? null) === existing.parentId);
    if (conflict) throw new TagError('tag_conflict', `tag name "${name}" already exists`, 409);

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
    if (!existing) throw new TagError('tag_not_found', 'tag not found', 404);
    if (existing.isPreset) throw new TagError('tag_preset_readonly', 'preset tags are read-only', 403);
    const hasChildren = this.list().some((t) => t.parentId === id);
    if (hasChildren) throw new TagError('tag_has_children', 'tag has child tags', 409);
    const refs = this.db.select().from(schema.workflowTags).where(eq(schema.workflowTags.tagId, id)).all();
    if (refs.length > 0) throw new TagError('tag_in_use', 'tag is referenced by workflows', 409);
    this.db.delete(schema.tags).where(eq(schema.tags.id, id)).run();
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter server exec vitest run src/services/tag.service.test.ts`
Expected: all passing

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/services/tag.types.ts packages/server/src/services/tag.service.ts packages/server/src/services/tag.service.test.ts
git commit -m "feat: 标签定义服务 TagService（CRUD / 树 / 预设只读 / 层级校验）"
```

---

### Task 3: 标签管理 API（routes + controller）

**Files:**
- Create: `packages/server/src/controllers/tags.controller.ts`
- Create: `packages/server/src/routes/tags.routes.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/src/routes/tags.routes.test.ts`

- [ ] **Step 1: 写路由测试**

新建 `packages/server/src/routes/tags.routes.test.ts`（参考现有 `providers.routes.test.ts` 的 supertest + express 子应用模式；认证中间件需要可用的 token——参考 workflow.routes.test.ts 的登录/鉴权处理方式）：

```ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from '../models/migrations/runner';
import * as schema from '../models/schema';
import { createAuthRoutes } from './auth.routes';
import { createTagsRoutes } from './tags.routes';
import { createAuthMiddleware } from '../middleware/auth';

// 注：认证中间件默认密码 0d000721（见 AGENTS.md）；此处按 workflow.routes.test.ts 现有做法构造已登录请求
describe('标签管理 API', () => {
  let app: express.Express;
  let db: BetterSQLite3Database<typeof schema>;
  let token: string;

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    runMigrations(sqlite);
    db = drizzle(sqlite, { schema });
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));
    app.use('/api/tags', createTagsRoutes(db));
  });

  beforeAll(async () => {
    // 登录获取 token（密码 0d000721）
    const sqlite = new Database(':memory:');
    runMigrations(sqlite);
    const authDb = drizzle(sqlite, { schema });
    const authApp = express();
    authApp.use(express.json());
    authApp.use('/api/auth', createAuthRoutes(authDb));
    const res = await request(authApp).post('/api/auth/login').send({ password: '0d000721' });
    token = res.body.token;
  });

  it('GET /api/tags 返回标签树', async () => {
    const res = await request(app).get('/api/tags').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const tree = res.body as Array<{ id: string; name: string; children: Array<{ id: string; name: string }> }>;
    const i2v = tree.find((t) => t.id === 'image-to-video');
    expect(i2v?.children.map((c) => c.id)).toContain('reference');
    expect(i2v?.children.map((c) => c.id)).toContain('first-frame');
  });

  it('POST /api/tags 新建自定义标签', async () => {
    const res = await request(app)
      .post('/api/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '自定义', parentId: null, metadataDef: [] });
    expect(res.status).toBe(201);
    expect(res.body.isPreset).toBe(0);
  });

  it('POST /api/tags 同层级重名返回 409 tag_conflict', async () => {
    await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`).send({ name: '重复' });
    const res = await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`).send({ name: '重复' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('tag_conflict');
  });

  it('PUT /api/tags/:id 编辑自定义标签', async () => {
    const created = await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`).send({ name: '旧名' });
    const res = await request(app)
      .put(`/api/tags/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '新名' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('新名');
  });

  it('PUT /api/tags/:id 编辑预设标签返回 403', async () => {
    const res = await request(app)
      .put('/api/tags/text-to-image')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '改名' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('tag_preset_readonly');
  });

  it('DELETE /api/tags/:id 删除自定义标签', async () => {
    const created = await request(app).post('/api/tags').set('Authorization', `Bearer ${token}`).send({ name: '待删' });
    const res = await request(app).delete(`/api/tags/${created.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
  });

  it('DELETE /api/tags/:id 删除预设标签返回 403', async () => {
    const res = await request(app).delete('/api/tags/text-to-image').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/routes/tags.routes.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 controller 与 routes**

新建 `packages/server/src/controllers/tags.controller.ts`：

```ts
import { Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TagError, TagService } from '../services/tag.service';
import type { TagMetadataFieldDef } from '../services/tag.types';

/** 宽松输入（容忍来自 HTTP body 的任意值） */
interface TagBodyLike {
  name?: unknown;
  parentId?: unknown;
  metadataDef?: unknown;
}

/** 标签管理控制器：路由层与 TagService 之间的薄适配层 */
export function createTagsController(db: BetterSQLite3Database<typeof schema>) {
  const tagService = new TagService(db);

  /** 将服务错误映射为 HTTP 响应 */
  function handleError(res: Response, err: unknown): boolean {
    if (err instanceof TagError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return true;
    }
    return false;
  }

  return {
    /** 列出标签树 */
    list(_req: Request, res: Response): void {
      res.json(tagService.getTree());
    },

    /** 新建自定义标签 */
    create(req: Request, res: Response): void {
      const body = req.body as TagBodyLike;
      try {
        const tag = tagService.create({
          name: typeof body.name === 'string' ? body.name : '',
          parentId: typeof body.parentId === 'string' ? body.parentId : null,
          metadataDef: body.metadataDef as TagMetadataFieldDef[] | undefined,
        });
        res.status(201).json(tag);
      } catch (err) {
        if (handleError(res, err)) return;
        throw err;
      }
    },

    /** 更新自定义标签 */
    update(req: Request, res: Response): void {
      const body = req.body as TagBodyLike;
      try {
        const tag = tagService.update(req.params.id as string, {
          name: typeof body.name === 'string' ? body.name : undefined,
          metadataDef: body.metadataDef as TagMetadataFieldDef[] | undefined,
        });
        res.json(tag);
      } catch (err) {
        if (handleError(res, err)) return;
        throw err;
      }
    },

    /** 删除自定义标签 */
    delete(req: Request, res: Response): void {
      try {
        tagService.delete(req.params.id as string);
        res.status(204).send();
      } catch (err) {
        if (handleError(res, err)) return;
        throw err;
      }
    },
  };
}
```

新建 `packages/server/src/routes/tags.routes.ts`：

```ts
import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createTagsController } from '../controllers/tags.controller';
import { createAuthMiddleware } from '../middleware/auth';

/**
 * 标签管理路由工厂。
 * @param db Drizzle 数据库实例
 * @returns 挂载了标签 CRUD 端点的 Router
 */
export function createTagsRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createTagsController(db);
  const auth = createAuthMiddleware(db);

  router.get('/', auth, controller.list);
  router.post('/', auth, controller.create);
  router.put('/:id', auth, controller.update);
  router.delete('/:id', auth, controller.delete);

  return router;
}
```

- [ ] **Step 4: 挂载路由**

在 `packages/server/src/index.ts` 追加：

```ts
import { createTagsRoutes } from './routes/tags.routes';
// ...
app.use('/api/tags', createTagsRoutes(db));
```

- [ ] **Step 5: 运行测试确认通过 + 全量后端测试回归**

Run: `pnpm --filter server exec vitest run src/routes/tags.routes.test.ts`
Expected: PASS

Run: `pnpm --filter server test`
Expected: 全部通过（无回归）

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/controllers/tags.controller.ts packages/server/src/routes/tags.routes.ts packages/server/src/routes/tags.routes.test.ts packages/server/src/index.ts
git commit -m "feat: 标签管理 API（/api/tags CRUD + 预设只读保护）"
```

---

### Task 4: WorkflowTagService（关联替换 / 元数据合并 / 筛选）

**Files:**
- Create: `packages/server/src/services/workflow-tag.service.ts`
- Test: `packages/server/src/services/workflow-tag.service.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `packages/server/src/services/workflow-tag.service.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from '../models/migrations/runner';
import * as schema from '../models/schema';
import { WorkflowTagService } from './workflow-tag.service';

/** 插入测试工作流 */
function insertWorkflow(db: BetterSQLite3Database<typeof schema>, id: string) {
  db.insert(schema.workflows).values({
    id, name: id, rawJson: '{}', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }).run();
}

describe('WorkflowTagService', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let service: WorkflowTagService;

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    runMigrations(sqlite);
    db = drizzle(sqlite, { schema });
    service = new WorkflowTagService(db);
    insertWorkflow(db, 'wf1');
    insertWorkflow(db, 'wf2');
  });

  it('整组替换标签（子必带父校验通过）', () => {
    service.setWorkflowTags('wf1', [
      { tagId: 'image-to-video' },
      { tagId: 'reference', metadataValues: { maxImageCount: 12 } },
    ]);
    const groups = service.getTagGroups('wf1');
    expect(groups.length).toBe(1);
    expect(groups[0].id).toBe('image-to-video');
    expect(groups[0].tags.map((t) => t.id)).toEqual(['reference']);
  });

  it('打子标签不带父标签抛 parent_tag_required', () => {
    expect(() => service.setWorkflowTags('wf1', [{ tagId: 'reference' }]))
      .toThrowError(/parent_tag_required/);
  });

  it('标签不存在抛 tag_not_found', () => {
    expect(() => service.setWorkflowTags('wf1', [{ tagId: 'nope' }]))
      .toThrowError(/tag_not_found/);
  });

  it('元数据键不属于字段定义抛 invalid_metadata', () => {
    expect(() => service.setWorkflowTags('wf1', [
      { tagId: 'image-to-video' },
      { tagId: 'reference', metadataValues: { bogus: 1 } },
    ])).toThrowError(/invalid_metadata/);
  });

  it('元数据值类型不匹配抛 invalid_metadata', () => {
    expect(() => service.setWorkflowTags('wf1', [
      { tagId: 'image-to-video' },
      { tagId: 'reference', metadataValues: { maxImageCount: 'abc' } },
    ])).toThrowError(/invalid_metadata/);
  });

  it('metadata 合并默认值：未填的键取默认值', () => {
    service.setWorkflowTags('wf1', [
      { tagId: 'image-to-video' },
      { tagId: 'reference', metadataValues: { maxImageCount: 12 } },
    ]);
    const groups = service.getTagGroups('wf1');
    const ref = groups[0].tags[0];
    expect(ref.metadata.maxImageCount).toBe(12);
    expect(ref.metadata.maxAudioCount).toBe(3); // 默认值
    expect(ref.configuredMetadata).toEqual({ maxImageCount: 12 });
  });

  it('整组替换为新的标签集合（旧关联被清除）', () => {
    service.setWorkflowTags('wf1', [{ tagId: 'text-to-image' }]);
    service.setWorkflowTags('wf1', [{ tagId: 'image-edit' }]);
    const groups = service.getTagGroups('wf1');
    expect(groups.map((g) => g.id)).toEqual(['image-edit']);
  });

  it('清除全部标签', () => {
    service.setWorkflowTags('wf1', [{ tagId: 'text-to-image' }]);
    service.setWorkflowTags('wf1', []);
    expect(service.getTagGroups('wf1')).toEqual([]);
  });

  it('筛选 AND：选中多个标签需全部命中', () => {
    service.setWorkflowTags('wf1', [{ tagId: 'text-to-image' }, { tagId: 'image-edit' }]);
    service.setWorkflowTags('wf2', [{ tagId: 'text-to-image' }]);
    const ids = service.listWorkflowIdsByTags(['text-to-image', 'image-edit']);
    expect(ids).toEqual(['wf1']);
  });

  it('筛选父标签未选子 = 向下包含全部子标签', () => {
    service.setWorkflowTags('wf1', [
      { tagId: 'image-to-video' },
      { tagId: 'reference' },
    ]);
    service.setWorkflowTags('wf2', [{ tagId: 'image-to-video' }]);
    // 选中 image-to-video（未选子）→ 命中 wf1（有子）与 wf2（有父）
    const ids = service.listWorkflowIdsByTags(['image-to-video']);
    expect(ids.sort()).toEqual(['wf1', 'wf2']);
  });

  it('筛选子标签精确匹配', () => {
    service.setWorkflowTags('wf1', [
      { tagId: 'image-to-video' },
      { tagId: 'reference' },
    ]);
    service.setWorkflowTags('wf2', [{ tagId: 'image-to-video' }]);
    const ids = service.listWorkflowIdsByTags(['first-frame']);
    expect(ids).toEqual([]);
  });

  it('父+部分子：与选中子标签求 AND', () => {
    service.setWorkflowTags('wf1', [
      { tagId: 'image-to-video' },
      { tagId: 'reference' },
    ]);
    service.setWorkflowTags('wf2', [
      { tagId: 'image-to-video' },
      { tagId: 'first-frame' },
    ]);
    // 选中父 image-to-video + 子 reference → 有效集合 {父∪全部子} ∩ {reference} = 仅 wf1
    const ids = service.listWorkflowIdsByTags(['image-to-video', 'reference']);
    expect(ids).toEqual(['wf1']);
  });

  it('顶层标签（无子）在组内 tags 为空数组', () => {
    service.setWorkflowTags('wf1', [{ tagId: 'text-to-image' }]);
    const groups = service.getTagGroups('wf1');
    expect(groups[0]).toMatchObject({ id: 'text-to-image', tags: [] });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/services/workflow-tag.service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 WorkflowTagService**

新建 `packages/server/src/services/workflow-tag.service.ts`（完整实现）：

```ts
import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { TagError } from './tag.service';
import { parseMetadataDef } from './tag.service';
import type { TagMetadataFieldDef, TagMetadataValues, WorkflowTagInput } from './tag.types';

/** workflow_tags 表行 */
type WorkflowTagRow = typeof schema.workflowTags.$inferSelect;

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
  /** 该父标签下被选中的子标签 */
  tags: WorkflowTagNode[];
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
      throw new TagError('tag_not_found', `tag not found: ${missing[0]}`, 404);
    }

    // ② 子必带父
    for (const t of tags) {
      if (tagIds.includes(t.id) && t.parentId && !tagIds.includes(t.parentId)) {
        throw new TagError('parent_tag_required', `parent tag "${t.parentId}" is required for "${t.id}"`);
      }
    }

    // ③ 元数据校验（仅对带 metadataDef 的标签；无定义的标签只允许空值）
    const prepared = new Map<string, string>();
    for (const item of input) {
      const tag = byId.get(item.tagId)!;
      const def = parseMetadataDef(tag.metadataDef);
      const values = validateMetadataValues(def, item.metadataValues);
      if (values === null) {
        throw new TagError('invalid_metadata', `invalid metadata for tag "${item.tagId}"`);
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
   * @param workflowId 工作流 ID
   * @returns 父标签分组数组（按创建时间升序）
   */
  getTagGroups(workflowId: string): WorkflowTagGroup[] {
    const assocs = this.db.select().from(schema.workflowTags).where(eq(schema.workflowTags.workflowId, workflowId)).all();
    const tags = this.listAllTags();
    const byId = new Map(tags.map((t) => [t.id, t]));
    const groups: WorkflowTagGroup[] = [];
    const childrenByParent = new Map<string, WorkflowTagNode[]>();

    // ① 分组：父标签进 groups，子标签暂存
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
        groups.push({ id: tag.id, name: tag.name, tags: [] });
      } else {
        const arr = childrenByParent.get(tag.parentId) ?? [];
        arr.push(node);
        childrenByParent.set(tag.parentId, arr);
      }
    }

    // ② 子标签挂到父分组（防御：父未显式打标也建组）
    for (const [parentId, children] of childrenByParent) {
      const group = groups.find((g) => g.id === parentId);
      if (group) {
        group.tags = children;
      } else {
        const parent = byId.get(parentId);
        groups.push({ id: parentId, name: parent?.name ?? parentId, tags: children });
      }
    }
    return groups;
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

    // 多集合 AND：每个集合一个 EXISTS 子查询
    const conditions = effectiveSets.map((ids) => {
      const placeholders = ids.map(() => '?').join(', ');
      return `EXISTS (SELECT 1 FROM workflow_tags wt WHERE wt.workflow_id = workflows.id AND wt.tag_id IN (${placeholders}))`;
    });
    const params = effectiveSets.flat();
    const rows = this.db.all(
      `SELECT id FROM workflows WHERE ${conditions.join(' AND ')}`,
      ...params,
    ) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
```

> 注意：`this.db.all(...)` 为 better-sqlite3 的透传方法；若类型不满足，可改为 `this.db.all(sql`...`...).all()`（drizzle `sql` 模板）。以 tsc --noEmit 通过为准。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter server exec vitest run src/services/workflow-tag.service.test.ts`
Expected: all passing

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/services/workflow-tag.service.ts packages/server/src/services/workflow-tag.service.test.ts
git commit -m "feat: 工作流标签服务（整组替换 / 元数据合并 / AND 筛选）"
```

---

### Task 5: 工作流 API 接入（list 筛选+tags、详情 tags、PUT tags）

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`
- Modify: `packages/server/src/routes/workflow.routes.ts`
- Test: `packages/server/src/routes/workflow.routes.test.ts`（追加用例）

- [ ] **Step 1: 追加路由测试**

在 `packages/server/src/routes/workflow.routes.test.ts` 追加（沿用该文件既有的 app 构造与鉴权方式）：

```ts
it('PUT /:id/tags 设置标签并返回', async () => {
  // 先建工作流
  const created = await request(app)
    .post('/api/workflows')
    .set('Authorization', `Bearer ${token}`)
    .send({ id: 'tag-wf', name: '标签流', rawJson: '{}' });
  expect(created.status).toBe(201);

  const res = await request(app)
    .put('/api/workflows/tag-wf/tags')
    .set('Authorization', `Bearer ${token}`)
    .send({ tags: [{ tagId: 'image-to-video' }, { tagId: 'reference', metadataValues: { maxImageCount: 15 } }] });
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
  expect(res.body[0].id).toBe('image-to-video');
  expect(res.body[0].tags[0].metadata.maxImageCount).toBe(15);
  expect(res.body[0].tags[0].configuredMetadata).toEqual({ maxImageCount: 15 });
});

it('PUT /:id/tags 子标签缺父标签返回 400 parent_tag_required', async () => {
  await request(app).post('/api/workflows').set('Authorization', `Bearer ${token}`).send({ id: 'tag-wf2', name: 'x', rawJson: '{}' });
  const res = await request(app)
    .put('/api/workflows/tag-wf2/tags')
    .set('Authorization', `Bearer ${token}`)
    .send({ tags: [{ tagId: 'reference' }] });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('parent_tag_required');
});

it('GET / 列表包含 tags 结构', async () => {
  const res = await request(app).get('/api/workflows').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const wf = (res.body as Array<Record<string, unknown>>).find((w) => w.id === 'tag-wf');
  expect(Array.isArray(wf?.tags)).toBe(true);
});

it('GET / 支持 tags 筛选（AND）', async () => {
  const res = await request(app)
    .get('/api/workflows?tags=image-to-video')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const ids = (res.body as Array<{ id: string }>).map((w) => w.id);
  expect(ids).toContain('tag-wf');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/routes/workflow.routes.test.ts`
Expected: 新用例 FAIL（接口未实现）

- [ ] **Step 3: 修改 controller**

在 `packages/server/src/controllers/workflow.controller.ts`：

1) 顶部导入 `WorkflowTagService` 与 `WorkflowTagInput`：

```ts
import { WorkflowTagService } from '../services/workflow-tag.service';
import type { WorkflowTagInput } from '../services/tag.types';
```

2) `createWorkflowController` 内实例化：

```ts
const workflowTagService = new WorkflowTagService(db);
```

3) `list` 方法改为支持筛选并附加 tags：

```ts
list(req: Request, res: Response): void {
  // 解析 ?tags=id1&tags=id2（可为数组或单个字符串）
  const raw = req.query.tags;
  const selected = raw === undefined ? [] : Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [raw];
  let workflows = workflowService.list();
  const matched = workflowTagService.listWorkflowIdsByTags(selected);
  if (matched !== null) {
    const matchedSet = new Set(matched);
    workflows = workflows.filter((w) => matchedSet.has(w.id));
  }
  res.json(workflows.map((wf) => ({
    ...wf,
    tags: workflowTagService.getTagGroups(wf.id),
  })));
}
```

4) `getById` 的响应对象追加 `tags`（两处：`getById` 与 `saveDeclaredParams` 返回 WorkflowDetail 的地方，以及任何组装详情响应处）：

```ts
res.json({
  ...wf,
  params: workflowService.getParams(id),
  buildScript: wf.buildScript,
  buildScriptEnabled: wf.buildScriptEnabled,
  declaredParams: workflowService.getDeclaredParams(id),
  resolvedProvider: ...,
  tags: workflowTagService.getTagGroups(id),
});
```

> 提示：先 `read_file` 查看 controller 中 `getById` / `saveDeclaredParams` / `update` 的实际响应对象，在每一处返回工作流详情的对象中追加 `tags: workflowTagService.getTagGroups(id)`。

5) 新增 `setTags` 方法：

```ts
/** 整组替换工作流标签；校验失败返回 400/404 */
setTags(req: Request, res: Response): void {
  const id = req.params.id as string;
  const existing = workflowService.getById(id);
  if (!existing) {
    res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
    return;
  }
  const body = req.body as { tags?: unknown };
  if (!Array.isArray(body.tags)) {
    res.status(400).json({ error: 'tags array is required', code: 'missing_parameter' });
    return;
  }
  try {
    const input = (body.tags as Array<{ tagId?: unknown; metadataValues?: unknown }>).map((t) => ({
      tagId: typeof t.tagId === 'string' ? t.tagId : '',
      metadataValues: t.metadataValues as WorkflowTagInput['metadataValues'],
    }));
    workflowTagService.setWorkflowTags(id, input);
    res.json(workflowTagService.getTagGroups(id));
  } catch (err) {
    if (err instanceof TagError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}
```

并在文件顶部导入 `TagError`：

```ts
import { TagError } from '../services/tag.service';
```

- [ ] **Step 4: 修改 routes**

在 `packages/server/src/routes/workflow.routes.ts` 追加（放在 `/:id/params` 相关路由附近）：

```ts
router.put('/:id/tags', auth, controller.setTags);
```

- [ ] **Step 5: 运行测试 + 全量回归 + 类型检查**

Run: `pnpm --filter server exec vitest run src/routes/workflow.routes.test.ts`
Expected: PASS

Run: `pnpm --filter server test`
Expected: 全部通过

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/controllers/workflow.controller.ts packages/server/src/routes/workflow.routes.ts packages/server/src/routes/workflow.routes.test.ts
git commit -m "feat: 工作流 API 支持打标签与按标签筛选"
```

---

### Task 6: 导入导出 manifest v2（标签）

**Files:**
- Modify: `packages/server/src/services/workflow-io.service.ts`
- Test: `packages/server/src/services/workflow-io.service.test.ts`（追加用例）

- [ ] **Step 1: 追加导入导出测试**

在 `packages/server/src/services/workflow-io.service.test.ts` 追加（沿用既有 `:memory:` + WorkflowIOService 构造方式）：

```ts
it('导出包含标签定义与工作流标签关联；导入后还原', async () => {
  // 准备工作流 + 标签
  db.insert(schema.workflows).values({
    id: 'wf-tag', name: '标签流', rawJson: '{}', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }).run();
  const wt = new WorkflowTagService(db);
  wt.setWorkflowTags('wf-tag', [
    { tagId: 'image-to-video' },
    { tagId: 'reference', metadataValues: { maxImageCount: 12 } },
  ]);
  // 新建一个自定义标签并打上
  const tagService = new TagService(db);
  const custom = tagService.create({ name: '自定义标签', parentId: null, metadataDef: [] });
  wt.setWorkflowTags('wf-tag', [
    { tagId: 'image-to-video' },
    { tagId: 'reference', metadataValues: { maxImageCount: 12 } },
    { tagId: custom.id },
  ]);

  // 导出
  const io = new WorkflowIOService(db);
  const zip = await io.exportWorkflows(['wf-tag']);
  const loaded = await JSZip.loadAsync(zip);
  const manifest = JSON.parse(await loaded.file('manifest.json')!.async('string')) as {
    version: number;
    tags: Array<{ id: string; name: string; parentId: string | null; isPreset: number }>;
    workflows: Array<{ id: string; tags: Array<{ tagId: string; metadataValues: Record<string, number> }> }>;
  };
  expect(manifest.version).toBe(2);
  expect(manifest.tags.find((t) => t.id === 'reference')?.isPreset).toBe(1);
  expect(manifest.tags.find((t) => t.id === custom.id)?.name).toBe('自定义标签');
  const wfTags = manifest.workflows.find((w) => w.id === 'wf-tag')!.tags;
  expect(wfTags.find((t) => t.tagId === 'reference')?.metadataValues.maxImageCount).toBe(12);

  // 导入到新库
  const sqlite2 = new Database(':memory:');
  runMigrations(sqlite2);
  const db2 = drizzle(sqlite2, { schema });
  const io2 = new WorkflowIOService(db2);
  const result = await io2.importWorkflows(zip);
  expect(result.imported).toBe(1);
  const groups = new WorkflowTagService(db2).getTagGroups('wf-tag');
  expect(groups.map((g) => g.id)).toEqual(['image-to-video', custom.id]);
  const ref = groups.find((g) => g.id === 'image-to-video')!.tags.find((t) => t.id === 'reference')!;
  expect(ref.metadata.maxImageCount).toBe(12);
  expect(ref.configuredMetadata).toEqual({ maxImageCount: 12 });
  // 导入后自定义标签已重建
  expect(new TagService(db2).getById(custom.id)?.name).toBe('自定义标签');
});

it('v1 旧包（无 tags）导入行为不变', async () => {
  const sqlite2 = new Database(':memory:');
  runMigrations(sqlite2);
  const db2 = drizzle(sqlite2, { schema });
  const io2 = new WorkflowIOService(db2);
  const zip = await new JSZip()
    .file('manifest.json', JSON.stringify({ version: 1, exportedAt: 'x', workflows: [{ id: 'old', name: '旧', rawJson: '{}' }] }))
    .generateAsync({ type: 'nodebuffer' });
  const result = await io2.importWorkflows(zip);
  expect(result.imported).toBe(1);
});
```

> 若测试文件尚未导入 `JSZip` / `WorkflowTagService` / `TagService` / `Database` / `drizzle` / `runMigrations`，在文件顶部补齐。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/services/workflow-io.service.test.ts`
Expected: 新用例 FAIL（未实现 v2）

- [ ] **Step 3: 修改 exportWorkflows**

在 `packages/server/src/services/workflow-io.service.ts`：

1) 顶部导入：

```ts
import { WorkflowTagService } from './workflow-tag.service';
```

2) `ExportManifest` 接口增加顶层 `tags` 与 `version` 说明，`ExportWorkflow` 增加 `tags`：

```ts
/** 导出清单中的标签定义 */
interface ExportTagDef {
  id: string;
  name: string;
  parentId: string | null;
  isPreset: number;
  metadataDef: unknown;
}

/** 导出清单中的工作流标签关联 */
interface ExportWorkflowTag {
  tagId: string;
  metadataValues: Record<string, number | string | boolean>;
}

interface ExportManifest {
  version: number;
  exportedAt: string;
  /** 涉及的全部标签定义（去重，父在前） */
  tags: ExportTagDef[];
  workflows: ExportWorkflow[];
}
```

3) `ExportWorkflow` 增加字段：

```ts
/** 标签关联（tagId + 用户元数据） */
tags: ExportWorkflowTag[];
```

4) `exportWorkflows` 中，循环内为每个工作流组装 tags，并收集标签定义到 `tagDefMap`：

```ts
const workflowTagService = new WorkflowTagService(this.db);
const tagDefMap = new Map<string, ExportTagDef>();
// 在 push workflow 之前：
const tagRows = workflowTagService.listAssociationsWithTags(id); // 见 Step 4 新增的辅助方法
const tags: ExportWorkflowTag[] = tagRows.map((t) => ({
  tagId: t.tagId,
  metadataValues: t.metadataValues,
}));
for (const t of tagRows) {
  if (!tagDefMap.has(t.tagId)) {
    tagDefMap.set(t.tagId, { id: t.tagId, name: t.name, parentId: t.parentId, isPreset: t.isPreset, metadataDef: t.metadataDef });
  }
}
// workflow 对象内追加 tags
```

5) 循环结束后、写 manifest 前：

```ts
manifest.tags = [...tagDefMap.values()].sort((a, b) => (a.parentId === null ? -1 : 1) - (b.parentId === null ? -1 : 1));
manifest.version = 2;
```

- [ ] **Step 4: 在 WorkflowTagService 增加辅助方法（供导出用）**

在 `packages/server/src/services/workflow-tag.service.ts` 追加：

```ts
/** 工作流标签关联（含标签定义信息，供导入导出） */
export interface WorkflowTagAssociationDetail {
  tagId: string;
  name: string;
  parentId: string | null;
  isPreset: number;
  metadataDef: string;
  metadataValues: TagMetadataValues;
}

/**
 * 查询工作流的全部标签关联（含标签定义），供导出使用。
 * @param workflowId 工作流 ID
 */
listAssociationsWithTags(workflowId: string): WorkflowTagAssociationDetail[] {
  const assocs = this.db.select().from(schema.workflowTags).where(eq(schema.workflowTags.workflowId, workflowId)).all();
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
```

- [ ] **Step 5: 修改 importWorkflows**

在 `importWorkflows` 中：

1) 解析 manifest 后，先处理顶层标签定义（父在前排序；已存在复用，不存在创建）：

```ts
// ① 确保标签定义存在（父先子后）
const tagDefs = (manifest.tags ?? []).slice().sort((a, b) => (a.parentId === null ? -1 : 1) - (b.parentId === null ? -1 : 1));
const now = new Date().toISOString();
for (const def of tagDefs) {
  const exists = this.db.select().from(schema.tags).where(eq(schema.tags.id, def.id)).get();
  if (exists) continue;
  this.db.insert(schema.tags).values({
    id: def.id,
    name: def.name,
    parentId: def.parentId,
    isPreset: def.isPreset,
    metadataDef: typeof def.metadataDef === 'string' ? def.metadataDef : JSON.stringify(def.metadataDef ?? []),
    createdAt: now,
    updatedAt: now,
  }).run();
}
```

> 需要导入 `eq` from `drizzle-orm`（文件顶部）。

2) 创建 workflow 后，写入标签关联（含防御：子标签缺父时自动补父关联）：

```ts
// 创建标签关联（防御：子缺父自动补父）
const entryTags = entry.tags ?? [];
const present = new Set(entryTags.map((t) => t.tagId));
const allTagIds = new Set(tagDefs.map((t) => t.id));
const toInsert: Array<{ tagId: string; metadataValues: Record<string, number | string | boolean> }> = [...entryTags];
for (const t of entryTags) {
  const def = tagDefs.find((d) => d.id === t.tagId);
  if (def?.parentId && !present.has(def.parentId) && allTagIds.has(def.parentId)) {
    toInsert.push({ tagId: def.parentId, metadataValues: {} });
    present.add(def.parentId);
  }
}
for (const t of toInsert) {
  this.db.insert(schema.workflowTags).values({
    workflowId: newId,
    tagId: t.tagId,
    metadataValues: JSON.stringify(t.metadataValues ?? {}),
  }).run();
}
```

- [ ] **Step 6: 运行测试 + 全量回归 + 类型检查**

Run: `pnpm --filter server exec vitest run src/services/workflow-io.service.test.ts`
Expected: PASS

Run: `pnpm --filter server test`
Expected: 全部通过

Run: `pnpm --filter server exec tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/services/workflow-io.service.ts packages/server/src/services/workflow-io.service.test.ts packages/server/src/services/workflow-tag.service.ts
git commit -m "feat: 工作流导入导出支持标签（manifest v2，兼容 v1）"
```

---

### Task 7: 前端类型 + API 模块

**Files:**
- Modify: `packages/client/src/types/index.ts`
- Create: `packages/client/src/api/tags.ts`
- Modify: `packages/client/src/api/workflows.ts`

- [ ] **Step 1: 追加类型定义**

在 `packages/client/src/types/index.ts` 追加：

```ts
/** 标签元数据字段类型 */
export type TagMetadataFieldType = 'number' | 'string' | 'boolean';

/** 标签元数据字段定义 */
export interface TagMetadataFieldDef {
  /** 字段键，如 "maxImageCount" */
  key: string;
  /** 显示名，如 "图片数量" */
  label: string;
  /** 字段类型 */
  type: TagMetadataFieldType;
  /** 默认值 */
  defaultValue: number | string | boolean;
}

/** 标签元数据值 */
export type TagMetadataValues = Record<string, number | string | boolean>;

/** 标签树节点（/api/tags 响应） */
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
  /** 子标签 */
  children: TagTreeNode[];
}

/** 工作流标签分组中的子标签节点 */
export interface WorkflowTagNode {
  /** 标签 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** 合并默认值后的完整元数据 */
  metadata: TagMetadataValues;
  /** 用户原始配置值 */
  configuredMetadata: TagMetadataValues;
}

/** 工作流标签分组（父标签） */
export interface WorkflowTagGroup {
  /** 父标签 ID */
  id: string;
  /** 父标签显示名 */
  name: string;
  /** 该父标签下被选中的子标签 */
  tags: WorkflowTagNode[];
}
```

`Workflow` 接口增加字段：

```ts
export interface Workflow {
  // ...现有字段...
  /** 工作流标签（嵌套分组结构） */
  tags: WorkflowTagGroup[];
}
```

- [ ] **Step 2: 新建 api/tags.ts**

```ts
import client from './client';
import type { TagMetadataFieldDef, TagTreeNode } from '@/types';

/**
 * 列出全部标签树
 * @returns 标签树（顶层节点含 children）
 */
export async function listTags(): Promise<TagTreeNode[]> {
  const res = await client.get<TagTreeNode[]>('/tags');
  return res.data;
}

/**
 * 新建自定义标签的入参
 */
export interface TagCreateInput {
  /** 显示名 */
  name: string;
  /** 父标签 ID（可选，null=顶层） */
  parentId?: string | null;
  /** 元数据字段定义（可选） */
  metadataDef?: TagMetadataFieldDef[];
}

/**
 * 新建自定义标签
 * @param data 新建入参
 * @returns 新标签（DB 行结构）
 */
export async function createTag(data: TagCreateInput): Promise<TagTreeNode & { isPreset: number }> {
  const res = await client.post('/tags', data);
  return res.data;
}

/**
 * 更新自定义标签（预设标签会被后端拒绝）
 * @param id 标签 ID
 * @param data 可更新字段
 */
export async function updateTag(id: string, data: Partial<TagCreateInput>): Promise<TagTreeNode & { isPreset: number }> {
  const res = await client.put(`/tags/${id}`, data);
  return res.data;
}

/**
 * 删除自定义标签（预设/有子/被引用会被后端拒绝）
 * @param id 标签 ID
 */
export async function deleteTag(id: string): Promise<void> {
  await client.delete(`/tags/${id}`);
}

/**
 * 设置工作流标签（整组替换）
 * @param workflowId 工作流 ID
 * @param tags 标签数组（tagId + 可选 metadataValues）
 * @returns 替换后的标签分组
 */
export async function setWorkflowTags(
  workflowId: string,
  tags: Array<{ tagId: string; metadataValues?: Record<string, number | string | boolean> }>,
): Promise<import('@/types').WorkflowTagGroup[]> {
  const res = await client.put(`/workflows/${workflowId}/tags`, { tags });
  return res.data;
}
```

- [ ] **Step 3: 修改 api/workflows.ts**

`listWorkflows` 支持筛选参数：

```ts
/**
 * 列出工作流；支持按标签筛选（多标签 AND）
 * @param tagIds 选中的标签 ID 数组（可选）
 * @returns 工作流列表（含 tags 结构）
 */
export async function listWorkflows(tagIds?: string[]): Promise<Workflow[]> {
  const res = await client.get<Workflow[]>('/workflows', {
    params: tagIds && tagIds.length > 0 ? { tags: tagIds } : undefined,
  });
  return res.data;
}
```

- [ ] **Step 4: 前端类型检查**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/types/index.ts packages/client/src/api/tags.ts packages/client/src/api/workflows.ts
git commit -m "feat: 前端标签类型与 API 模块"
```

---

### Task 8: 标签管理页面（TagManagementPage + 路由 + 导航入口）

**Files:**
- Create: `packages/client/src/pages/TagManagementPage.vue`
- Modify: `packages/client/src/router/index.ts`
- Modify: `packages/client/src/pages/WorkflowListPage.vue`（app bar 加导航按钮，仅加按钮）

- [ ] **Step 1: 新建 TagManagementPage.vue**

参照 `SettingsPage.vue` 的页面结构（自带 `<v-app-bar color="primary">` + 返回按钮 + `<v-container>`）。页面包含：

- **标签树展示**：使用 `v-treeview` 或嵌套 `v-list`（父节点可展开）。每个节点显示：名称、`isPreset` 徽标（预设显示「预设」chip）、元数据字段数量；操作按钮：编辑（自定义）、删除（自定义）。
- **新建标签按钮**：顶部「新建标签」。
- **新建/编辑弹窗**：字段——显示名（必填）、父标签（`v-select` 可选，选项为全部顶层标签 + 其子标签两级展开；编辑时禁用）、元数据字段编辑器（行列表：键 / 显示名 / 类型 `v-select`（number/string/boolean）/ 默认值控件按类型切换——number 用 `v-text-field type="number"`、string 用 `v-text-field`、boolean 用 `v-switch`；支持增删行）。
- **删除确认**：`v-dialog` 确认后调 `deleteTag`；后端拒绝（403/409）时展示 `error` 字段中的错误信息。
- 数据加载：`onMounted` 调 `listTags()`；错误提示用 `v-alert`。

关键脚本结构（要点，完整实现参照 SettingsPage 的弹窗模式）：

```ts
import { onMounted, ref } from 'vue';
import { listTags, createTag, updateTag, deleteTag, type TagCreateInput } from '@/api/tags';
import type { TagTreeNode, TagMetadataFieldDef } from '@/types';

/** 弹窗中的元数据字段编辑行 */
interface FieldRow {
  key: string;
  label: string;
  type: TagMetadataFieldDef['type'];
  defaultValue: number | string | boolean;
}

const tags = ref<TagTreeNode[]>([]);
const loading = ref(false);
const error = ref('');
const dialog = ref(false);
const editingId = ref<string | null>(null);
const name = ref('');
const parentId = ref<string | null>(null);
const isPreset = ref(false);
const fields = ref<FieldRow[]>([{ key: '', label: '', type: 'number', defaultValue: 0 }]);
const deletingId = ref<string | null>(null);
const deleteDialog = ref(false);

/** 父标签选择项：顶层标签 + 其子标签（两级展开，子标签缩进） */
function parentOptions(tags: TagTreeNode[]): Array<{ title: string; value: string }> {
  const out: Array<{ title: string; value: string }> = [];
  for (const t of tags) {
    out.push({ title: t.name, value: t.id });
    for (const c of t.children) {
      out.push({ title: `　└ ${c.name}`, value: c.id });
    }
  }
  return out;
}
```

模板要点：

```html
<v-app-bar color="primary">
  <v-app-bar-title>标签管理</v-app-bar-title>
  <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">返回</v-btn>
</v-app-bar>
<v-container>
  <v-row class="mb-4 align-center">
    <v-col><h2 class="text-h5">标签管理</h2></v-col>
    <v-col cols="auto">
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">新建标签</v-btn>
    </v-col>
  </v-row>
  <v-alert v-if="error" type="error" closable class="mb-4">{{ error }}</v-alert>
  <!-- 树形列表：v-treeview 或嵌套 v-list；每个节点右侧操作按钮 -->
</v-container>
<!-- 新建/编辑弹窗 -->
```

- [ ] **Step 2: 注册路由**

在 `packages/client/src/router/index.ts` 追加：

```ts
{
  path: '/admin/tags',
  name: 'Tags',
  component: () => import('@/pages/TagManagementPage.vue'),
},
```

- [ ] **Step 3: 列表页 app bar 加导航按钮**

在 `packages/client/src/pages/WorkflowListPage.vue` 的 `<v-app-bar>` 中、任务日志按钮旁追加：

```html
<v-btn to="/admin/tags" variant="text" prepend-icon="mdi-tag-multiple">
  标签管理
</v-btn>
```

- [ ] **Step 4: 前端类型检查 + 构建**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 无类型错误

Run: `pnpm --filter client exec vite build`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/pages/TagManagementPage.vue packages/client/src/router/index.ts packages/client/src/pages/WorkflowListPage.vue
git commit -m "feat: 标签管理页面与路由"
```

---

### Task 9: 工作流打标签弹窗（WorkflowTagEditorDialog）

**Files:**
- Create: `packages/client/src/components/WorkflowTagEditorDialog.vue`

- [ ] **Step 1: 新建组件**

新建 `packages/client/src/components/WorkflowTagEditorDialog.vue`。这是一个可复用弹窗，供列表页与详情页使用。

**Props：**

```ts
defineProps<{
  /** 弹窗可见性（v-model） */
  modelValue: boolean;
  /** 可用标签树 */
  allTags: TagTreeNode[];
  /** 当前工作流的标签分组 */
  currentTags: WorkflowTagGroup[];
}>();
```

**Emits：**

```ts
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  /** 保存：返回整组标签（tagId + 用户元数据） */
  (e: 'save', tags: Array<{ tagId: string; metadataValues: TagMetadataValues }>): void;
}>();
```

**内部状态：**

```ts
// 选中状态：父标签 id → 是否选中；子标签 id → 是否选中
const checkedParents = ref<Set<string>>(new Set());
const checkedChildren = ref<Set<string>>(new Set());
// 元数据输入：tagId → { key: 当前值 }
const metadataInputs = ref<Record<string, TagMetadataValues>>({});
// 元数据展开状态：tagId → boolean（默认 false）
const expandedMetadata = ref<Record<string, boolean>>({});
```

**逻辑：**

- `open`（监听 `modelValue` 变 true 时）：根据 `currentTags` 初始化 `checkedParents` / `checkedChildren` / `metadataInputs`：
  - 外层每个 group 的 id 加入 `checkedParents`
  - group.tags 中每个子标签 id 加入 `checkedChildren`
  - 子标签的 `configuredMetadata` 填入 `metadataInputs[tagId]`（没有则用定义默认值，但注意**保存时只提交用户显式填写的键**——为满足「空值用默认」，保存前把与默认值相等的键过滤掉；简化为：保存时提交 `metadataInputs[tagId]` 中**值不等于定义默认值**的键）
- 打开时重置 `expandedMetadata = {}`（默认收起）
- 父标签 checkbox：`@change` 切换 `checkedParents`；**子标签 checkbox 在父未选中时 `:disabled`**
- 元数据区：对选中的、`metadataDef.length > 0` 的标签显示「元数据」折叠区（`v-expand-transition` + 展开按钮），内部按字段类型渲染输入（number → `v-text-field type="number"`、string → `v-text-field`、boolean → `v-switch`）
- **确认保存**：组装 `result` —— 遍历 `checkedParents`：父 id 入组（`{tagId: parentId, metadataValues: {}}`，父标签无元数据定义故空）；遍历 `checkedChildren`：若对应父在 `checkedParents` 中（不变量），入组并带上过滤后的元数据；随后 `emit('save', result)` 并关闭弹窗
- 顶部提示文案：*「勾选子标签需先勾选其父标签」*

**模板骨架：**

```html
<v-dialog :model-value="modelValue" max-width="560" @update:model-value="emit('update:modelValue', $event)">
  <v-card>
    <v-card-title>编辑标签</v-card-title>
    <v-card-text>
      <p class="text-caption text-grey mb-2">勾选子标签需先勾选其父标签</p>
      <div v-for="parent in allTags" :key="parent.id" class="mb-2">
        <v-checkbox
          :label="parent.name"
          :model-value="checkedParents.has(parent.id)"
          density="compact"
          hide-details
          @update:model-value="toggleParent(parent)"
        />
        <div class="ml-8">
          <template v-for="child in parent.children" :key="child.id">
            <v-checkbox
              :label="child.name"
              :model-value="checkedChildren.has(child.id)"
              :disabled="!checkedParents.has(parent.id)"
              density="compact"
              hide-details
              @update:model-value="toggleChild(child)"
            />
            <!-- 选中的、带元数据定义的子标签：默认收起的元数据编辑区 -->
            <div v-if="checkedChildren.has(child.id) && child.metadataDef.length > 0" class="ml-8 mb-2">
              <v-btn
                size="small" variant="text" color="primary"
                :prepend-icon="expandedMetadata[child.id] ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                @click="expandedMetadata[child.id] = !expandedMetadata[child.id]"
              >
                元数据
              </v-btn>
              <v-expand-transition>
                <div v-show="expandedMetadata[child.id]" class="ml-4">
                  <!-- 按字段类型渲染输入 -->
                </div>
              </v-expand-transition>
            </div>
          </template>
        </div>
      </div>
    </v-card-text>
    <v-card-actions>
      <v-spacer />
      <v-btn variant="text" @click="emit('update:modelValue', false)">取消</v-btn>
      <v-btn color="primary" @click="handleSave">保存</v-btn>
    </v-card-actions>
  </v-card>
</v-dialog>
```

> 说明：若某标签的元数据输入值为**空串/空**，保存时该键不提交（后端合并默认值）。boolean 开关总是有值（true/false），保存时若与默认值一致也可不提交（由组件内「值 ≠ 默认值才提交」规则统一处理）。

- [ ] **Step 2: 前端类型检查**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: 提交**

```bash
git add packages/client/src/components/WorkflowTagEditorDialog.vue
git commit -m "feat: 工作流打标签弹窗组件（层级选择 + 元数据编辑）"
```

---

### Task 10: 详情页标签卡片

**Files:**
- Modify: `packages/client/src/pages/WorkflowDetailPage.vue`

- [ ] **Step 1: 实现标签卡片与编辑**

在 `packages/client/src/pages/WorkflowDetailPage.vue`：

1) 顶部信息卡片（`workflow` 基础信息卡）中新增「标签」区块：

```html
<!-- 标签展示 -->
<v-divider class="my-2" />
<div class="d-flex align-center flex-wrap ga-2">
  <span class="text-subtitle-2">标签</span>
  <template v-if="workflow?.tags && workflow.tags.length > 0">
    <template v-for="group in workflow.tags" :key="group.id">
      <v-chip color="primary" variant="tonal" size="small">{{ group.name }}</v-chip>
      <v-chip
        v-for="child in group.tags" :key="child.id"
        size="small" variant="flat" color="secondary" class="ml-1"
      >
        {{ child.name }}
      </v-chip>
    </template>
  </template>
  <span v-else class="text-caption text-grey">暂无标签</span>
  <v-spacer />
  <v-btn size="small" variant="text" color="primary" prepend-icon="mdi-tag-edit" @click="tagDialog = true">
    编辑标签
  </v-btn>
</div>
```

2) 引入 `WorkflowTagEditorDialog`、`listTags`、`setWorkflowTags`：

```ts
import WorkflowTagEditorDialog from '@/components/WorkflowTagEditorDialog.vue';
import { listTags, setWorkflowTags } from '@/api/tags';
import type { TagTreeNode } from '@/types';
```

3) 脚本状态与逻辑：

```ts
const allTags = ref<TagTreeNode[]>([]);
const tagDialog = ref(false);
const savingTags = ref(false);
const tagError = ref('');

/** 加载标签树（供弹窗使用） */
async function loadTags() {
  try { allTags.value = await listTags(); } catch { /* 忽略，弹窗内无标签时提示 */ }
}

/** 保存标签 */
async function handleSaveTags(tags: Array<{ tagId: string; metadataValues: Record<string, number | string | boolean> }>) {
  if (!workflow.value) return;
  savingTags.value = true;
  tagError.value = '';
  try {
    await setWorkflowTags(workflow.value.id, tags);
    await loadWorkflow(); // 重新拉取详情刷新 tags
    tagDialog.value = false;
  } catch (err) {
    tagError.value = err instanceof Error ? err.message : String(err);
  } finally {
    savingTags.value = false;
  }
}
```

4) 在模板末尾（`</v-container>` 之前）放置弹窗：

```html
<WorkflowTagEditorDialog
  v-model="tagDialog"
  :all-tags="allTags"
  :current-tags="workflow?.tags ?? []"
  @save="handleSaveTags"
/>
```

> `loadTags()` 在 `onMounted`（或进入详情加载流程）中调用。

- [ ] **Step 2: 前端类型检查 + 构建**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 无类型错误

Run: `pnpm --filter client exec vite build`
Expected: 构建成功

- [ ] **Step 3: 提交**

```bash
git add packages/client/src/pages/WorkflowDetailPage.vue
git commit -m "feat: 工作流详情页支持打标签"
```

---

### Task 11: 列表页标签展示 / 筛选 / 编辑入口

**Files:**
- Modify: `packages/client/src/pages/WorkflowListPage.vue`

- [ ] **Step 1: 实现列表页标签能力**

在 `packages/client/src/pages/WorkflowListPage.vue`：

1) 顶部筛选条（在工作流列表标题行下方，多选 chips）：

```html
<!-- 标签筛选条 -->
<v-row v-if="tagTree.length > 0" class="mb-2 align-center">
  <v-col cols="auto" class="text-subtitle-2">按标签筛选：</v-col>
  <v-col>
    <div class="d-flex flex-wrap ga-1">
      <template v-for="parent in tagTree" :key="parent.id">
        <v-chip
          :color="selectedTagIds.has(parent.id) ? 'primary' : ''"
          variant="tonal"
          filter
          @click="toggleFilterTag(parent.id)"
        >
          {{ parent.name }}
        </v-chip>
        <v-chip
          v-for="child in parent.children" :key="child.id"
          :color="selectedTagIds.has(child.id) ? 'secondary' : ''"
          variant="flat"
          filter
          size="small"
          class="ml-1"
          @click="toggleFilterTag(child.id)"
        >
          {{ child.name }}
        </v-chip>
      </template>
      <v-btn v-if="selectedTagIds.size > 0" size="small" variant="text" @click="clearFilter">清空</v-btn>
    </div>
  </v-col>
</v-row>
```

2) 列表项 `v-list-item` 的 subtitle 下方追加标签 chips（利用 `v-list-item` 的默认插槽或追加一行）：

```html
<template #default>
  <div v-if="wf.tags && wf.tags.length > 0" class="d-flex flex-wrap ga-1 mt-1">
    <template v-for="group in wf.tags" :key="group.id">
      <v-chip size="x-small" color="primary" variant="tonal">{{ group.name }}</v-chip>
      <v-chip v-for="child in group.tags" :key="child.id" size="x-small" color="secondary" variant="flat">
        {{ child.name }}
      </v-chip>
    </template>
  </div>
</template>
```

3) 每项操作区追加「标签」编辑按钮（在播放/复制按钮附近）：

```html
<v-btn
  icon
  variant="text"
  size="small"
  class="mr-2"
  @click.stop="openTagDialog(wf)"
>
  <v-icon>mdi-tag-outline</v-icon>
</v-btn>
```

4) 脚本逻辑：

```ts
import { listTags, setWorkflowTags } from '@/api/tags';
import WorkflowTagEditorDialog from '@/components/WorkflowTagEditorDialog.vue';
import type { TagTreeNode } from '@/types';

const tagTree = ref<TagTreeNode[]>([]);
const selectedTagIds = ref<Set<string>>(new Set());
const tagDialogWorkflow = ref<Workflow | null>(null);
const tagDialog = ref(false);

/** 加载标签树（顶部筛选条与弹窗共用） */
async function loadTags() {
  try { tagTree.value = await listTags(); } catch { tagTree.value = []; }
}

/** 切换筛选标签并重新拉取列表 */
function toggleFilterTag(id: string) {
  const next = new Set(selectedTagIds.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  selectedTagIds.value = next;
  loadWorkflows(); // 需将 loadWorkflows 改造为接收筛选参数
}

function clearFilter() {
  selectedTagIds.value = new Set();
  loadWorkflows();
}

function openTagDialog(wf: Workflow) {
  tagDialogWorkflow.value = wf;
  tagDialog.value = true;
}

async function handleSaveTags(tags: Array<{ tagId: string; metadataValues: Record<string, number | string | boolean> }>) {
  if (!tagDialogWorkflow.value) return;
  await setWorkflowTags(tagDialogWorkflow.value.id, tags);
  tagDialog.value = false;
  loadWorkflows();
}
```

5) `loadWorkflows` 改造：请求时带 `selectedTagIds`：

```ts
async function loadWorkflows() {
  const ids = [...selectedTagIds.value];
  workflows.value = await listWorkflows(ids.length > 0 ? ids : undefined);
  // ...现有逻辑不变
}
```

6) 模板末尾放置弹窗：

```html
<WorkflowTagEditorDialog
  v-model="tagDialog"
  :all-tags="tagTree"
  :current-tags="tagDialogWorkflow?.tags ?? []"
  @save="handleSaveTags"
/>
```

7) `onMounted` 中追加 `loadTags()`。

- [ ] **Step 2: 前端类型检查 + 构建**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: 无类型错误

Run: `pnpm --filter client exec vite build`
Expected: 构建成功

- [ ] **Step 3: 提交**

```bash
git add packages/client/src/pages/WorkflowListPage.vue
git commit -m "feat: 工作流列表支持标签展示、筛选与打标签"
```

---

## 最终验证

- [ ] 后端全量测试：`pnpm --filter server test` → 全部通过
- [ ] 后端类型：`pnpm --filter server exec tsc --noEmit` → 无错误
- [ ] 前端类型：`pnpm --filter client exec tsc --noEmit` → 无错误
- [ ] 前端构建：`pnpm --filter client exec vite build` → 成功
- [ ] 手工冒烟：启动 `pnpm dev:server` + `pnpm dev:client`，在浏览器验证：
  - 标签管理页展示 11 个预设标签树，参考模板显示元数据定义
  - 新建/编辑/删除自定义标签（预设只读）
  - 详情页对工作流打标签（子标签需先勾父；reference 元数据展开编辑）
  - 列表页标签 chips 展示、按标签 AND 筛选、每项编辑标签
  - 导出 ZIP → 导入到新库，标签与元数据保留
