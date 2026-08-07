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
