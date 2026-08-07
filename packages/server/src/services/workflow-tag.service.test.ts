import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from '../models/migrations/runner';
import * as schema from '../models/schema';
import { WorkflowTagService } from './workflow-tag.service';
import { WorkflowService } from './workflow.service';
import { TagService } from './tag.service';

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
    // 入参为非空数组，返回值不可能是 null（strict 下用非空断言收窄类型）
    expect(ids!.sort()).toEqual(['wf1', 'wf2']);
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

  it('顶层标签可携带元数据（根标签元数据定义生效）', () => {
    // 新建一个带元数据定义的顶层自定义标签
    const tagService = new TagService(db);
    const root = tagService.create({
      id: 'root-meta',
      name: '根元数据',
      parentId: null,
      metadataDef: [{ key: 'maxCount', label: '数量', type: 'number', defaultValue: 5 }],
    });
    service.setWorkflowTags('wf1', [
      { tagId: root.id, metadataValues: { maxCount: 8 } },
    ]);
    const groups = service.getTagGroups('wf1');
    expect(groups.length).toBe(1);
    expect(groups[0].id).toBe(root.id);
    // 根标签的 metadata 为合并默认值后的完整对象，configuredMetadata 为原始配置值
    expect(groups[0].metadata).toEqual({ maxCount: 8 });
    expect(groups[0].configuredMetadata).toEqual({ maxCount: 8 });
  });

  it('顶层标签未配置元数据时返回默认值', () => {
    const tagService = new TagService(db);
    const root = tagService.create({
      id: 'root-meta-default',
      name: '根元数据默认',
      parentId: null,
      metadataDef: [{ key: 'maxCount', label: '数量', type: 'number', defaultValue: 5 }],
    });
    service.setWorkflowTags('wf1', [{ tagId: root.id }]);
    const groups = service.getTagGroups('wf1');
    expect(groups[0].metadata).toEqual({ maxCount: 5 });
    expect(groups[0].configuredMetadata).toEqual({});
  });

  it('工作流改名后标签保留（FK 级联迁移）', () => {
    service.setWorkflowTags('wf1', [{ tagId: 'text-to-image' }]);
    // 通过 WorkflowService.update 改名
    const wfService = new WorkflowService(db);
    wfService.update('wf1', { id: 'wf1-renamed' });
    expect(service.getTagGroups('wf1-renamed').map((g) => g.id)).toEqual(['text-to-image']);
    expect(service.getTagGroups('wf1')).toEqual([]);
  });
});
