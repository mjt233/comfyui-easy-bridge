import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { AttachmentService } from './attachment.service';

// 使用临时目录作为 DATA_DIR，避免污染真实数据目录
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-svc-'));
process.env.DATA_DIR = tempDataDir;

describe('AttachmentService', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let service: AttachmentService;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        mimetype TEXT,
        created_at TEXT NOT NULL
      );
    `);
    db = drizzle(sqlite, { schema });
    service = new AttachmentService(db);

    // 预置工作流，供附件外键引用
    const now = new Date().toISOString();
    for (const id of ['wf1', 'wf2', 'wf-del']) {
      db.insert(schema.workflows).values({ id, name: `WF-${id}`, rawJson: '{}', createdAt: now, updatedAt: now }).run();
    }
  });

  afterAll(() => {
    // 清理临时数据目录
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('create writes file to disk and returns record', () => {
    const attachment = service.create('wf1', {
      filename: '参考图.png',
      buffer: Buffer.from('hello world'),
      mimetype: 'image/png',
    });

    expect(attachment.workflowId).toBe('wf1');
    expect(attachment.filename).toBe('参考图.png');
    expect(attachment.size).toBe(11);
    expect(attachment.mimetype).toBe('image/png');
    // stored_name 应为 uuid + .png
    expect(attachment.storedName).toMatch(/^[0-9a-f-]{36}\.png$/);

    // 磁盘文件存在且内容一致
    const filePath = service.getFilePath(attachment.storedName);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath).toString()).toBe('hello world');
  });

  it('list returns only attachments of the given workflow', () => {
    service.create('wf1', {
      filename: 'a.txt',
      buffer: Buffer.from('a'),
      mimetype: 'text/plain',
    });
    service.create('wf2', {
      filename: 'b.txt',
      buffer: Buffer.from('b'),
      mimetype: 'text/plain',
    });

    const list1 = service.list('wf1');
    const list2 = service.list('wf2');
    expect(list1).toHaveLength(2);
    expect(list2).toHaveLength(1);
    expect(list2[0].filename).toBe('b.txt');
  });

  it('readBuffer returns original content', () => {
    const attachment = service.list('wf1')[0];
    expect(service.readBuffer(attachment).toString()).toBe('hello world');
  });

  it('delete removes disk file and record row', () => {
    const created = service.create('wf1', {
      filename: 'temp.txt',
      buffer: Buffer.from('temp'),
      mimetype: 'text/plain',
    });
    const filePath = service.getFilePath(created.storedName);
    expect(fs.existsSync(filePath)).toBe(true);

    service.delete(created.id);

    expect(fs.existsSync(filePath)).toBe(false);
    expect(service.getById(created.id)).toBeNull();
  });

  it('deleteByWorkflow removes all files and rows of a workflow', () => {
    const a1 = service.create('wf-del', {
      filename: 'x.txt',
      buffer: Buffer.from('x'),
      mimetype: 'text/plain',
    });
    const a2 = service.create('wf-del', {
      filename: 'y.txt',
      buffer: Buffer.from('y'),
      mimetype: 'text/plain',
    });

    service.deleteByWorkflow('wf-del');

    expect(fs.existsSync(service.getFilePath(a1.storedName))).toBe(false);
    expect(fs.existsSync(service.getFilePath(a2.storedName))).toBe(false);
    expect(service.list('wf-del')).toHaveLength(0);
  });
});
