import { randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { WorkflowService } from './workflow.service';
import { AttachmentService } from './attachment.service';

/**
 * 导出清单中的附件元信息
 */
interface ExportAttachment {
  /** 原始文件名 */
  filename: string;
  /** 磁盘存储名（zip 内位于 attachments/ 目录） */
  storedName: string;
  /** 文件字节数 */
  size: number;
  /** MIME 类型；可空 */
  mimetype: string | null;
}

/**
 * 导出清单中的单个工作流
 */
interface ExportWorkflow {
  /** 工作流 ID */
  id: string;
  /** 工作流名称 */
  name: string;
  /** 原始 JSON 字符串 */
  rawJson: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
  /** 参数配置 */
  params: Array<{
    nodeId: string;
    fieldName: string;
    alias: string | null;
    label: string | null;
    paramType: string;
    defaultValue: string | null;
  }>;
  /** 附件元信息 */
  attachments: ExportAttachment[];
}

/**
 * 导出清单（manifest.json 的结构）
 */
interface ExportManifest {
  /** 格式版本号 */
  version: number;
  /** 导出时间 */
  exportedAt: string;
  /** 工作流列表 */
  workflows: ExportWorkflow[];
}

/**
 * 导入结果摘要
 */
export interface ImportResult {
  /** 成功导入的工作流数量 */
  imported: number;
  /** 因 ID 冲突被改名的工作流映射 */
  renamed: Array<{ old: string; new: string }>;
  /** 导入失败的工作流 */
  failed: Array<{ id: string; reason: string }>;
}

/**
 * 工作流导入导出服务：多选导出为 ZIP、批量导入 ZIP。
 * ZIP 结构：
 *   manifest.json    { version, exportedAt, workflows: [...] }
 *   attachments/     附件二进制文件（storedName）
 */
export class WorkflowIOService {
  private workflowService: WorkflowService;
  private attachmentService: AttachmentService;

  /**
   * @param db Drizzle 数据库实例
   */
  constructor(private db: BetterSQLite3Database<typeof schema>) {
    this.workflowService = new WorkflowService(db);
    this.attachmentService = new AttachmentService(db);
  }

  /**
   * 将选中的工作流打包为 ZIP（含参数与附件）
   * @param ids 选中的工作流 ID 列表
   * @returns ZIP 文件 Buffer
   */
  async exportWorkflows(ids: string[]): Promise<Buffer> {
    const zip = new JSZip();
    const manifest: ExportManifest = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workflows: [],
    };

    for (const id of ids) {
      // 跳过不存在的工作流
      const wf = this.workflowService.getById(id);
      if (!wf) continue;

      const params = this.workflowService.getParams(id);
      const attachments = this.attachmentService.list(id);

      manifest.workflows.push({
        id: wf.id,
        name: wf.name,
        rawJson: wf.rawJson,
        createdAt: wf.createdAt,
        updatedAt: wf.updatedAt,
        params: params.map((p) => ({
          nodeId: p.nodeId,
          fieldName: p.fieldName,
          alias: p.alias,
          label: p.label,
          paramType: p.paramType,
          defaultValue: p.defaultValue,
        })),
        attachments: attachments.map((a) => ({
          filename: a.filename,
          storedName: a.storedName,
          size: a.size,
          mimetype: a.mimetype,
        })),
      });

      // 附件二进制写入 zip 的 attachments/ 目录
      for (const attachment of attachments) {
        zip.file(
          `attachments/${attachment.storedName}`,
          this.attachmentService.readBuffer(attachment),
        );
      }
    }

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  /**
   * 导入 ZIP：解析 manifest 并创建工作流、参数与附件。
   * ID 冲突时自动生成新 ID（追加 -import-<随机> 后缀）并记录映射。
   * @param zipBuffer ZIP 文件 Buffer
   * @returns 导入结果摘要
   */
  async importWorkflows(zipBuffer: Buffer): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, renamed: [], failed: [] };
    const zip = await JSZip.loadAsync(zipBuffer);
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      throw new Error('Invalid export file: missing manifest.json');
    }
    const manifest = JSON.parse(await manifestFile.async('string')) as ExportManifest;

    for (const entry of manifest.workflows) {
      try {
        // 生成唯一 ID：冲突时改名
        let newId = entry.id;
        if (this.workflowService.getById(newId)) {
          newId = this.generateUniqueId(entry.id, 'import');
          result.renamed.push({ old: entry.id, new: newId });
        }

        // 创建 workflow（保留原始时间戳）
        this.db.insert(schema.workflows).values({
          id: newId,
          name: entry.name,
          rawJson: entry.rawJson,
          createdAt: entry.createdAt ?? new Date().toISOString(),
          updatedAt: entry.updatedAt ?? new Date().toISOString(),
        }).run();

        // 创建参数配置
        for (const p of entry.params ?? []) {
          this.db.insert(schema.workflowParams).values({
            workflowId: newId,
            nodeId: p.nodeId,
            fieldName: p.fieldName,
            alias: p.alias ?? null,
            label: p.label ?? null,
            paramType: p.paramType ?? 'text',
            defaultValue: p.defaultValue ?? null,
          }).run();
        }

        // 创建附件：从 zip 读取二进制写入磁盘
        for (const att of entry.attachments ?? []) {
          const zipFile = zip.file(`attachments/${att.storedName}`);
          if (!zipFile) {
            // 附件文件缺失：记录失败但不中断其他工作流
            result.failed.push({ id: newId, reason: `attachment file missing: ${att.filename}` });
            continue;
          }
          const buffer = await zipFile.async('nodebuffer');
          this.attachmentService.create(newId, {
            filename: att.filename,
            buffer,
            mimetype: att.mimetype ?? null,
          });
        }

        result.imported += 1;
      } catch (err: unknown) {
        // 单个工作流失败不中断整体导入
        result.failed.push({
          id: entry.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * 基于基础 ID 生成唯一新 ID（追加 -<kind>-<6位hex> 后缀，冲突时重试）
   * @param baseId 基础 ID
   * @param kind 后缀标识（如 import / copy）
   * @returns 唯一的新 ID
   */
  private generateUniqueId(baseId: string, kind: string): string {
    let candidate = '';
    do {
      const suffix = randomBytes(3).toString('hex');
      candidate = `${baseId}-${kind}-${suffix}`;
    } while (this.workflowService.getById(candidate) != null);
    return candidate;
  }

  /**
   * 复制工作流：生成唯一新 ID，克隆工作流本体（含动态构建脚本）、参数与附件（含磁盘文件）。
   * 源工作流保持不变，复制品使用新的创建/更新时间戳。
   * @param id 源工作流 ID
   * @returns 复制后的新工作流行；源工作流不存在时返回 null
   */
  duplicate(id: string) {
    const existing = this.workflowService.getById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    // 生成唯一新 ID（-copy- 后缀，冲突时重试）
    const newId = this.generateUniqueId(id, 'copy');

    // ① 复制工作流本体：rawJson + 动态构建脚本与启用状态，名称追加 " (copy)"
    this.db.insert(schema.workflows).values({
      id: newId,
      name: `${existing.name} (copy)`,
      rawJson: existing.rawJson,
      buildScript: existing.buildScript,
      buildScriptEnabled: existing.buildScriptEnabled,
      createdAt: now,
      updatedAt: now,
    }).run();

    // ② 复制参数配置（含别名、标签、类型与默认值覆盖）
    for (const p of this.workflowService.getParams(id)) {
      this.db.insert(schema.workflowParams).values({
        workflowId: newId,
        nodeId: p.nodeId,
        fieldName: p.fieldName,
        alias: p.alias,
        label: p.label,
        paramType: p.paramType,
        defaultValue: p.defaultValue,
      }).run();
    }

    // ③ 复制附件：读取源磁盘文件，写入新记录与新的磁盘文件
    for (const attachment of this.attachmentService.list(id)) {
      this.attachmentService.create(newId, {
        filename: attachment.filename,
        buffer: this.attachmentService.readBuffer(attachment),
        mimetype: attachment.mimetype,
      });
    }

    // 回查并返回新工作流行
    return this.workflowService.getById(newId)!;
  }
}
