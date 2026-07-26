import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from './settings.service';

const JWT_SECRET = process.env.JWT_SECRET ?? 'comfyui-easy-bridge-secret-key-change-in-production';
const DEFAULT_PASSWORD = '0d000721';

export class AuthService {
  private settings: SettingsService;

  constructor(db: BetterSQLite3Database<typeof schema>) {
    this.settings = new SettingsService(db);
    this.ensureDefaultPassword();
  }

  private ensureDefaultPassword(): void {
    const existing = this.settings.get('admin_password_hash');
    if (!existing) {
      const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
      this.settings.set('admin_password_hash', hash);
    }
  }

  verifyPassword(password: string): boolean {
    const hash = this.settings.get('admin_password_hash');
    if (!hash) return false;
    return bcrypt.compareSync(password, hash);
  }

  login(password: string): string {
    if (!this.verifyPassword(password)) {
      throw new Error('Invalid password');
    }
    return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  }

  verifyToken(token: string): { role: string } {
    return jwt.verify(token, JWT_SECRET) as { role: string };
  }
}
