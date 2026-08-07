import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from '../models/migrations/runner';
import * as schema from '../models/schema';
import { TagService } from './tag.service';
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
