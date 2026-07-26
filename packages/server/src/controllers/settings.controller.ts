import { Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from '../services/settings.service';

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
      res.json({ key, value });
    },
  };
}
