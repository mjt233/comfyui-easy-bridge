import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { WorkflowService } from './workflow.service';
import { AttachmentService } from './attachment.service';
import { WorkflowIOService } from './workflow-io.service';

// 使用临时目录作为 DATA_DIR，避免污染真实数据目录
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-io-'));
process.env.DATA_DIR = tempDataDir;

/** 建表 SQL（与 db.ts 保持一致） */
const DDL = `
  CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE workflow_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    alias TEXT,
    label TEXT,
    param_type TEXT NOT NULL DEFAULT 'text',
    default_value TEXT,
    UNIQUE(workflow_id, alias)
  );
  CREATE TABLE workflow_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mimetype TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * 创建一套独立的 in-memory 环境（DB + 各服务）
 * @returns 环境对象
 */
function createEnv() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(DDL);
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
});
