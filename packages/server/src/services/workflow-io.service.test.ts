import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { runMigrations } from '../models/migrations/runner';
import { WorkflowService } from './workflow.service';
import { AttachmentService } from './attachment.service';
import { WorkflowIOService } from './workflow-io.service';
import { WorkflowTagService } from './workflow-tag.service';
import { TagService } from './tag.service';

// 使用临时目录作为 DATA_DIR，避免污染真实数据目录
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-io-'));
process.env.DATA_DIR = tempDataDir;

/**
 * 创建一套独立的 in-memory 环境（DB + 各服务）
 * @returns 环境对象
 */
function createEnv() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  // 通过迁移建全量表（含 tags / workflow_tags），与生产保持一致
  runMigrations(sqlite);
  const db: BetterSQLite3Database<typeof schema> = drizzle(sqlite, { schema });
  return {
    db,
    workflowService: new WorkflowService(db),
    attachmentService: new AttachmentService(db),
    ioService: new WorkflowIOService(db),
  };
}

/** 便捷创建工作流 + 参数 + 附件 */
function seedWorkflow(env: ReturnType<typeof createEnv>, id: string) {
  env.workflowService.create({ id, name: `WF-${id}`, rawJson: '{"1":{"inputs":{}}}' });
  env.workflowService.addParam({
    workflowId: id,
    nodeId: '1',
    fieldName: 'text',
    alias: 'prompt',
    label: '提示词',
    paramType: 'text',
    defaultValue: null,
  });
  const attachment = env.attachmentService.create(id, {
    filename: 'note.txt',
    buffer: Buffer.from(`content-of-${id}`),
    mimetype: 'text/plain',
  });
  return { id, attachment };
}

describe('WorkflowIOService', () => {
  afterAll(() => {
    // 清理临时数据目录
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('export then import round-trips workflow, params and attachments', async () => {
    const envA = createEnv();
    const { id, attachment } = seedWorkflow(envA, 'wf-a');

    // 导出
    const zipBuffer = await envA.ioService.exportWorkflows([id]);
    expect(zipBuffer.length).toBeGreaterThan(0);

    // 校验 ZIP 结构
    const zip = await JSZip.loadAsync(zipBuffer);
    expect(zip.file('manifest.json')).toBeDefined();
    expect(zip.file(`attachments/${attachment.storedName}`)).toBeDefined();

    // 导入到全新环境
    const envB = createEnv();
    const result = await envB.ioService.importWorkflows(zipBuffer);
    expect(result.imported).toBe(1);
    expect(result.renamed).toHaveLength(0);

    // 工作流本体
    const wf = envB.workflowService.getById(id);
    expect(wf?.name).toBe(`WF-${id}`);
    expect(wf?.rawJson).toBe('{"1":{"inputs":{}}}');

    // 参数
    const params = envB.workflowService.getParams(id);
    expect(params).toHaveLength(1);
    expect(params[0].alias).toBe('prompt');
    expect(params[0].label).toBe('提示词');
    expect(params[0].paramType).toBe('text');

    // 附件（内容与文件名一致）
    const attachments = envB.attachmentService.list(id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('note.txt');
    expect(envB.attachmentService.readBuffer(attachments[0]).toString()).toBe(`content-of-${id}`);
  });

  it('export then import round-trips workflow description', async () => {
    const envA = createEnv();
    const { id } = seedWorkflow(envA, 'wf-desc');
    // 更新备注说明（Markdown 文本）
    envA.workflowService.update(id, { description: '# 备注\nMarkdown **说明**' });

    const zipBuffer = await envA.ioService.exportWorkflows([id]);
    const envB = createEnv();
    const result = await envB.ioService.importWorkflows(zipBuffer);
    expect(result.imported).toBe(1);
    expect(envB.workflowService.getById(id)?.description).toBe('# 备注\nMarkdown **说明**');
  });

  it('export then import round-trips declared params', async () => {
    const envA = createEnv();
    const { id } = seedWorkflow(envA, 'wf-dp');
    // 写入动态字段静态声明
    envA.workflowService.updateDeclaredParams(id, [
      { alias: 'input_image', label: '输入图片', paramType: 'image', defaultValue: null },
      { alias: 'steps', label: '步数', paramType: 'number', defaultValue: '20' },
    ]);

    const zipBuffer = await envA.ioService.exportWorkflows([id]);
    const envB = createEnv();
    const result = await envB.ioService.importWorkflows(zipBuffer);
    expect(result.imported).toBe(1);
    expect(envB.workflowService.getDeclaredParams(id)).toEqual([
      { alias: 'input_image', label: '输入图片', paramType: 'image', defaultValue: null },
      { alias: 'steps', label: '步数', paramType: 'number', defaultValue: '20' },
    ]);
  });

  it('export then import round-trips dynamic build script', async () => {
    const envA = createEnv();
    const { id } = seedWorkflow(envA, 'wf-bs');
    // 配置动态构建脚本并启用
    envA.workflowService.updateBuildScript(id, { script: 'export default (ctx) => ctx.workflow', enabled: true });

    const zipBuffer = await envA.ioService.exportWorkflows([id]);
    const envB = createEnv();
    const result = await envB.ioService.importWorkflows(zipBuffer);
    expect(result.imported).toBe(1);
    // 动态构建脚本与启用状态完整还原
    const wf = envB.workflowService.getById(id);
    expect(wf?.buildScript).toBe('export default (ctx) => ctx.workflow');
    expect(wf?.buildScriptEnabled).toBe(1);
  });

  it('import of legacy export without buildScript defaults to disabled', async () => {
    const env = createEnv();
    // 手工构造不含 buildScript 字段的 v2 旧版导出清单
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      version: 2,
      exportedAt: new Date().toISOString(),
      workflows: [{
        id: 'wf-legacy-bs',
        name: 'WF-legacy-bs',
        rawJson: '{}',
        description: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        params: [],
        declaredParams: [],
        attachments: [],
      }],
    }));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await env.ioService.importWorkflows(buffer);
    expect(result.imported).toBe(1);
    // 旧版导出无 buildScript → 导入后为空脚本且未启用
    const wf = env.workflowService.getById('wf-legacy-bs');
    expect(wf?.buildScript).toBe('');
    expect(wf?.buildScriptEnabled).toBe(0);
  });

  it('import renames workflow when ID conflicts', async () => {
    const env = createEnv();
    const { id } = seedWorkflow(env, 'wf-dup');

    const zipBuffer = await env.ioService.exportWorkflows([id]);
    // 导入回同一环境 → ID 冲突
    const result = await env.ioService.importWorkflows(zipBuffer);

    expect(result.imported).toBe(1);
    expect(result.renamed).toHaveLength(1);
    expect(result.renamed[0].old).toBe('wf-dup');
    expect(result.renamed[0].new).not.toBe('wf-dup');

    // 新 ID 的工作流存在，且附件也迁移
    const renamedId = result.renamed[0].new;
    expect(env.workflowService.getById(renamedId)).toBeDefined();
    expect(env.attachmentService.list(renamedId)).toHaveLength(1);
    // 原 ID 仍保留
    expect(env.workflowService.getById('wf-dup')).toBeDefined();
  });

  it('import throws when manifest.json is missing', async () => {
    const env = createEnv();
    const zip = new JSZip();
    zip.file('random.txt', 'not a manifest');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(env.ioService.importWorkflows(buffer)).rejects.toThrow(/manifest/i);
  });

  it('export skips nonexistent workflow ids', async () => {
    const env = createEnv();
    const zipBuffer = await env.ioService.exportWorkflows(['missing-id']);
    const zip = await JSZip.loadAsync(zipBuffer);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
      workflows: unknown[];
    };
    expect(manifest.workflows).toHaveLength(0);
  });

  it('duplicate clones workflow, params, build script and attachments', () => {
    const env = createEnv();
    const { id, attachment } = seedWorkflow(env, 'src');
    // 附加动态构建脚本
    env.workflowService.updateBuildScript(id, { script: 'export default {}', enabled: true });
    // 附加动态字段静态声明
    env.workflowService.updateDeclaredParams(id, [
      { alias: 'input_image', label: '输入图片', paramType: 'image', defaultValue: null },
    ]);

    const copy = env.ioService.duplicate(id);
    expect(copy).not.toBeNull();
    const newId = copy!.id;
    // 新 ID 唯一，与源不同
    expect(newId).not.toBe(id);
    // 名称追加 (copy)，rawJson / 构建脚本 / 启用状态一致
    expect(copy!.name).toBe('WF-src (copy)');
    expect(copy!.rawJson).toBe('{"1":{"inputs":{}}}');
    expect(copy!.buildScript).toBe('export default {}');
    expect(copy!.buildScriptEnabled).toBe(1);

    // 动态字段声明已复制
    expect(env.workflowService.getDeclaredParams(newId)).toEqual([
      { alias: 'input_image', label: '输入图片', paramType: 'image', defaultValue: null },
    ]);

    // 参数已复制
    const params = env.workflowService.getParams(newId);
    expect(params).toHaveLength(1);
    expect(params[0].alias).toBe('prompt');
    expect(params[0].label).toBe('提示词');
    expect(params[0].paramType).toBe('text');

    // 附件已复制（文件名与内容一致，storedName 不同）
    const attachments = env.attachmentService.list(newId);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('note.txt');
    expect(attachments[0].storedName).not.toBe(attachment.storedName);
    expect(env.attachmentService.readBuffer(attachments[0]).toString()).toBe(`content-of-${id}`);

    // 源工作流不受影响
    expect(env.workflowService.getById(id)).toBeDefined();
    expect(env.attachmentService.list(id)).toHaveLength(1);
  });

  it('duplicate returns null for nonexistent workflow', () => {
    const env = createEnv();
    expect(env.ioService.duplicate('missing')).toBeNull();
  });

  it('duplicate preserves providerId', () => {
    const env = createEnv();
    // 创建工作流并指定执行提供商实例
    env.workflowService.create({ id: 'src-prov', name: 'WF-prov', rawJson: '{}', providerId: 'prov-1' });

    const copy = env.ioService.duplicate('src-prov');
    expect(copy).not.toBeNull();
    // 复制品保留源工作流的 providerId（不回退全局默认）
    expect(copy!.providerId).toBe('prov-1');
  });

  it('duplicate copies workflow tags with metadata values', () => {
    const env = createEnv();
    env.workflowService.create({ id: 'src-tag', name: 'WF-tag', rawJson: '{}' });
    // 源工作流打标签（含元数据配置）
    const wt = new WorkflowTagService(env.db);
    wt.setWorkflowTags('src-tag', [
      { tagId: 'image-to-video' },
      { tagId: 'reference', metadataValues: { maxImageCount: 12 } },
    ]);

    const copy = env.ioService.duplicate('src-tag');
    expect(copy).not.toBeNull();
    // 复制品继承标签分组与用户元数据配置
    const groups = wt.getTagGroups(copy!.id);
    expect(groups.map((g) => g.id)).toEqual(['image-to-video']);
    expect(groups[0].tags.map((t) => t.id)).toEqual(['reference']);
    expect(groups[0].tags[0].metadata.maxImageCount).toBe(12);
    expect(groups[0].tags[0].configuredMetadata).toEqual({ maxImageCount: 12 });
    // 源工作流标签不受影响
    expect(wt.getTagGroups('src-tag').length).toBe(1);
  });

  it('export includes providerId in manifest', async () => {
    const env = createEnv();
    env.workflowService.create({ id: 'wf-prov-export', name: 'WF-export', rawJson: '{}', providerId: 'prov-1' });

    const zipBuffer = await env.ioService.exportWorkflows(['wf-prov-export']);
    const zip = await JSZip.loadAsync(zipBuffer);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
      workflows: Array<{ providerId: string | null }>;
    };
    expect(manifest.workflows).toHaveLength(1);
    // 清单中携带执行提供商实例 ID
    expect(manifest.workflows[0].providerId).toBe('prov-1');
  });

  it('export then import round-trips providerId', async () => {
    const envA = createEnv();
    envA.workflowService.create({ id: 'wf-prov-rt', name: 'WF-rt', rawJson: '{}', providerId: 'prov-1' });

    const zipBuffer = await envA.ioService.exportWorkflows(['wf-prov-rt']);
    const envB = createEnv();
    const result = await envB.ioService.importWorkflows(zipBuffer);
    expect(result.imported).toBe(1);
    // 导入后 providerId 恢复（不回退全局默认）
    expect(envB.workflowService.getById('wf-prov-rt')?.providerId).toBe('prov-1');
  });

  it('import of legacy export without providerId defaults to null', async () => {
    const env = createEnv();
    // 手工构造不含 providerId 字段的旧版导出清单
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      workflows: [{
        id: 'wf-legacy',
        name: 'WF-legacy',
        rawJson: '{}',
        description: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        params: [],
        declaredParams: [],
        attachments: [],
      }],
    }));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await env.ioService.importWorkflows(buffer);
    expect(result.imported).toBe(1);
    // 旧版导出无 providerId → 导入后为 null（使用全局默认实例）
    expect(env.workflowService.getById('wf-legacy')?.providerId).toBeNull();
  });

  it('导出包含标签定义与工作流标签关联；导入后还原', async () => {
    const env = createEnv();
    const { db } = env;

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
    expect(manifest.version).toBe(3);
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

  it('自定义标签导出后导入全新系统：同 ID 完整还原（父子关系 + 元数据定义 + 关联值）', async () => {
    // 源系统：迁移种子 + 自定义标签
    const sqlite1 = new Database(':memory:');
    runMigrations(sqlite1);
    const db1 = drizzle(sqlite1, { schema });
    const io1 = new WorkflowIOService(db1);
    const tagService1 = new TagService(db1);
    // 自定义顶层标签 + 自定义子标签（挂在其下，含元数据字段定义）
    const customParent = tagService1.create({ name: '我的分组', parentId: null, metadataDef: [] });
    const customChild = tagService1.create({
      name: '我的子标签',
      parentId: customParent.id,
      metadataDef: [{ key: 'count', label: '数量', type: 'number', defaultValue: 1 }],
    });
    db1.insert(schema.workflows).values({
      id: 'wf-custom', name: '自定义流', rawJson: '{}', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }).run();
    const wt1 = new WorkflowTagService(db1);
    wt1.setWorkflowTags('wf-custom', [
      { tagId: customParent.id },
      { tagId: customChild.id, metadataValues: { count: 5 } },
    ]);

    // 导出
    const zip = await io1.exportWorkflows(['wf-custom']);

    // 导入到全新系统（仅迁移种子，无任何自定义数据）
    const sqlite2 = new Database(':memory:');
    runMigrations(sqlite2);
    const db2 = drizzle(sqlite2, { schema });
    const io2 = new WorkflowIOService(db2);
    const result = await io2.importWorkflows(zip);
    expect(result.imported).toBe(1);

    // 自定义标签按原 ID 重建，名称 / 父子关系 / 自定义属性保留
    const tagService2 = new TagService(db2);
    const restoredParent = tagService2.getById(customParent.id);
    expect(restoredParent?.name).toBe('我的分组');
    expect(restoredParent?.isPreset).toBe(0);
    const restoredChild = tagService2.getById(customChild.id);
    expect(restoredChild?.name).toBe('我的子标签');
    expect(restoredChild?.parentId).toBe(customParent.id);
    expect(restoredChild?.isPreset).toBe(0);
    expect(restoredChild?.metadataDef).toContain('count');

    // 关联还原（含用户配置的元数据值）
    const groups = new WorkflowTagService(db2).getTagGroups('wf-custom');
    const parentGroup = groups.find((g) => g.id === customParent.id)!;
    expect(parentGroup).toBeDefined();
    expect(parentGroup.tags.map((t) => t.id)).toEqual([customChild.id]);
    const child = parentGroup.tags[0];
    expect(child.configuredMetadata).toEqual({ count: 5 });
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

  it('v2 包中缺父定义的子标签关联，导入时自动补父关联', async () => {
    const sqlite2 = new Database(':memory:');
    runMigrations(sqlite2);
    const db2 = drizzle(sqlite2, { schema });
    const io2 = new WorkflowIOService(db2);
    // 手动构造 v2 manifest：reference 关联存在，但其父 image-to-video 定义缺失
    const zip = await new JSZip()
      .file('manifest.json', JSON.stringify({
        version: 2,
        exportedAt: 'x',
        tags: [{ id: 'reference', name: '全能参考', parentId: 'image-to-video', isPreset: 1, metadataDef: '[]' }],
        workflows: [{
          id: 'wf-child', name: '子', rawJson: '{}',
          tags: [{ tagId: 'reference', metadataValues: {} }],
        }],
      }))
      .generateAsync({ type: 'nodebuffer' });
    const result = await io2.importWorkflows(zip);
    expect(result.imported).toBe(1);
    // 父关联被自动补上：父 image-to-video 与子 reference 都存在（image-to-video 是预设种子）
    const groups = new WorkflowTagService(db2).getTagGroups('wf-child');
    expect(groups.map((g) => g.id)).toEqual(['image-to-video']);
    expect(groups[0].tags.map((t) => t.id)).toEqual(['reference']);
  });
});
