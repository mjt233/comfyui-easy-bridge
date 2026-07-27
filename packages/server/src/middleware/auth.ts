import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

export function createAuthMiddleware(db: BetterSQLite3Database<typeof schema>) {
  const authService = new AuthService(db);

  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!authService.isAuthEnabled()) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid token', code: 'unauthorized' });
      return;
    }

    const token = authHeader.slice(7);
    try {
      authService.verifyToken(token);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token', code: 'unauthorized' });
    }
  };
}
