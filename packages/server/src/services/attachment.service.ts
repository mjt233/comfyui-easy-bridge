import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

/**
 * 计算附件存储目录。
 * 每次调用时读取环境变量，便于测试通过 DATA_DIR 覆盖。
 * @returns 附件目录绝对路径
 */
function getAttachmentsDir(): string {
  return path.join(
    process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
    'attachments',
  );
}

/**
 * 从原始文件名提取并清理扩展名（仅保留字母数字、点、下划线、连字符）。
 * @param filename 原始文件名
 * @returns 清理后的扩展名（含前导点，可能为空字符串）
 */
function sanitizeExt(filename: string): string {
  return path.extname(filename).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 20);
}

/**
 * 修正 multer 对 multipart 文件名的 latin1 误解码。
 * multer 将原始字节按 latin1 解码，而浏览器实际发送 UTF-8 文件名；
 * 仅当 latin1→utf8 转换结果不含替换字符时采用，避免破坏本就合法的字符串。
 * @param name 原始文件名
 * @returns 规范化后的文件名
 */
function normalizeOriginalName(name: string): string {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? name : utf8;
}

/**
 * 新增附件的输入
 */
export interface CreateAttachmentInput {
  /** 用户上传的原始文件名 */
  filename: string;
  /** 文件二进制内容 */
  buffer: Buffer;
  /** MIME 类型；可空 */
  mimetype: string | null;
}

/**
 * 工作流附件业务服务：附件记录 CRUD + 磁盘文件读写。
 * 文件以 <DATA_DIR>/attachments/<stored_name> 扁平存储，
 * stored_name 为 uuid + 扩展名，工作流改 ID 时磁盘文件无需迁移。
 */
export class AttachmentService {
  /**
   * @param db Drizzle 数据库实例
   */
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /**
   * 列出工作流的全部附件
   * @param workflowId 工作流 ID
   * @returns 附件记录列表
   */
  list(workflowId: string) {
    return this.db.select()
      .from(schema.workflowAttachments)
      .where(eq(schema.workflowAttachments.workflowId, workflowId))
      .all();
  }

  /**
   * 按附件行 ID 查询
   * @param id 附件行 ID
   * @returns 附件记录或 null
   */
  getById(id: number) {
    return this.db.select()
      .from(schema.workflowAttachments)
      .where(eq(schema.workflowAttachments.id, id))
      .get() ?? null;
  }

  /**
   * 创建附件：写入磁盘并插入记录
   * @param workflowId 工作流 ID
   * @param input 附件内容
   * @returns 新建的附件记录
   */
  create(workflowId: string, input: CreateAttachmentInput) {
    // 生成唯一存储名：uuid + 清理后的扩展名
    const storedName = `${randomUUID()}${sanitizeExt(input.filename)}`;
    // 确保目录存在
    const dir = getAttachmentsDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // 写入磁盘
    fs.writeFileSync(path.join(dir, storedName), input.buffer);

    const now = new Date().toISOString();
    this.db.insert(schema.workflowAttachments).values({
      workflowId,
      filename: normalizeOriginalName(input.filename),
      storedName,
      size: input.buffer.length,
      mimetype: input.mimetype,
      createdAt: now,
    }).run();

    // 按存储名回查（storedName 唯一）
    return this.db.select()
      .from(schema.workflowAttachments)
      .where(eq(schema.workflowAttachments.storedName, storedName))
      .get()!;
  }

  /**
   * 计算附件在磁盘上的绝对路径
   * @param storedName 存储名
   * @returns 绝对路径
   */
  getFilePath(storedName: string): string {
    return path.join(getAttachmentsDir(), storedName);
  }

  /**
   * 读取附件二进制内容
   * @param attachment 附件记录（含 storedName）
   * @returns 文件内容 Buffer
   */
  readBuffer(attachment: { storedName: string }): Buffer {
    return fs.readFileSync(this.getFilePath(attachment.storedName));
  }

  /**
   * 删除附件：先删磁盘文件（不存在时忽略），再删记录行
   * @param id 附件行 ID
   */
  delete(id: number): void {
    const attachment = this.getById(id);
    if (!attachment) return;
    try {
      fs.unlinkSync(this.getFilePath(attachment.storedName));
    } catch {
      // 文件可能已丢失，忽略
    }
    this.db.delete(schema.workflowAttachments)
      .where(eq(schema.workflowAttachments.id, id))
      .run();
  }

  /**
   * 删除某工作流全部附件（磁盘文件 + 记录行）。
   * 供工作流删除时清理使用；DB 行也可依赖 FK 级联，但磁盘文件必须手动清理。
   * @param workflowId 工作流 ID
   */
  deleteByWorkflow(workflowId: string): void {
    const attachments = this.list(workflowId);
    for (const attachment of attachments) {
      try {
        fs.unlinkSync(this.getFilePath(attachment.storedName));
      } catch {
        // 文件可能已丢失，忽略
      }
    }
    this.db.delete(schema.workflowAttachments)
      .where(eq(schema.workflowAttachments.workflowId, workflowId))
      .run();
  }
}
