import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

export function createAuthController(db: BetterSQLite3Database<typeof schema>) {
  const authService = new AuthService(db);

  return {
    login(req: Request, res: Response): void {
      const { password } = req.body;
      if (!password) {
        res.status(400).json({ error: 'Password is required', code: 'missing_parameter' });
        return;
      }
      try {
        const token = authService.login(password);
        res.json({ token });
      } catch {
        res.status(401).json({ error: 'Invalid password', code: 'unauthorized' });
      }
    },

    status(_req: Request, res: Response): void {
      res.json({ authEnabled: authService.isAuthEnabled() });
    },
  };
}
