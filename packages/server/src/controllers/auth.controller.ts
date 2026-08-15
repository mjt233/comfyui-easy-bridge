import { NextFunction, Request, Response } from 'express';
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

    changePassword(req: Request, res: Response, next: NextFunction): void {
      const { oldPassword, newPassword } = req.body;
      // 必填参数缺失时直接返回 400，不进入业务逻辑
      if (!oldPassword || !newPassword) {
        res.status(400).json({
          error: 'oldPassword and newPassword are required',
          code: 'missing_parameter',
        });
        return;
      }
      try {
        authService.changePassword(oldPassword, newPassword);
        res.json({ ok: true });
      } catch (err) {
        // 统一交给 errorHandler：旧密码错误→401，新密码过短→400
        next(err as Error);
      }
    },
  };
}
