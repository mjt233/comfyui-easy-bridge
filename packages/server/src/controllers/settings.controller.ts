import { Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from '../services/settings.service';
import { notifyProviderChange } from '../services/providers/provider.service';

export function createSettingsController(db: BetterSQLite3Database<typeof schema>) {
  const settingsService = new SettingsService(db);

  return {
    getAll(_req: Request, res: Response): void {
      res.json(settingsService.getAll());
    },

    update(req: Request, res: Response): void {
      const { key, value } = req.body;
      if (!key || value === undefined) {
        res.status(400).json({ error: 'key and value are required', code: 'missing_parameter' });
        return;
      }
      settingsService.set(key, value);
      // 默认实例切换需触发执行服务重建跟踪器，让新的默认实例立即生效
      if (key === 'default_provider_id') {
        notifyProviderChange();
      }
      res.json({ key, value });
    },
  };
}
