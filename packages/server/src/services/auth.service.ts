import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from './settings.service';

const JWT_SECRET = process.env.JWT_SECRET ?? 'comfyui-easy-bridge-secret-key-change-in-production';
const DEFAULT_PASSWORD = '0d000721';
/** 新密码最短长度 */
const MIN_PASSWORD_LENGTH = 6;

/**
 * 确保管理员密码已初始化：settings 表中不存在 admin_password_hash 时，
 * 写入默认密码 0d000721 的 bcrypt 哈希。服务启动与 AuthService 构造时均会调用。
 * @param db Drizzle 数据库实例
 */
export function ensureDefaultPassword(db: BetterSQLite3Database<typeof schema>): void {
  const settings = new SettingsService(db);
  const existing = settings.get('admin_password_hash');
  if (!existing) {
    // 默认密码仅在从未设置过时写入，已有哈希则保持不变
    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
    settings.set('admin_password_hash', hash);
  }
}

export class AuthService {
  private settings: SettingsService;

  constructor(db: BetterSQLite3Database<typeof schema>) {
    this.settings = new SettingsService(db);
    ensureDefaultPassword(db);
  }

  /**
   * 校验密码是否与 settings 表中存储的 bcrypt 哈希匹配。
   * @param password 待校验的明文密码
   * @returns 是否匹配
   */
  verifyPassword(password: string): boolean {
    const hash = this.settings.get('admin_password_hash');
    if (!hash) return false;
    return bcrypt.compareSync(password, hash);
  }

  /**
   * 校验旧密码后更新为新密码（bcrypt 哈希写入 settings 表），
   * 并将 token 版本号 +1，使所有旧 token 立即失效。
   * @param oldPassword 当前密码
   * @param newPassword 新密码（至少 MIN_PASSWORD_LENGTH 位）
   * @throws 旧密码错误时抛 'Invalid password'；新密码过短抛 'New password too short'
   */
  changePassword(oldPassword: string, newPassword: string): void {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error('New password too short');
    }
    if (!this.verifyPassword(oldPassword)) {
      throw new Error('Invalid password');
    }
    // 重新计算哈希并覆盖写入，旧哈希随之失效
    const hash = bcrypt.hashSync(newPassword, 10);
    this.settings.set('admin_password_hash', hash);
    // 版本号 +1：所有在该版本之前签发的 token 全部作废
    const nextVersion = String(Number(this.tokenVersion()) + 1);
    this.settings.set('auth_token_version', nextVersion);
  }

  /**
   * 校验密码并签发 JWT（24 小时有效期）。token 内携带当前 token 版本号，
   * 用于密码修改后使旧 token 立即失效。
   * @param password 明文密码
   * @returns JWT token
   */
  login(password: string): string {
    if (!this.verifyPassword(password)) {
      throw new Error('Invalid password');
    }
    return jwt.sign({ role: 'admin', v: this.tokenVersion() }, JWT_SECRET, { expiresIn: '24h' });
  }

  /**
   * 校验 token 签名与 token 版本号，返回 payload。
   * 密码已修改（版本号落后）或签名无效时抛出异常。
   * @param token JWT token
   * @returns payload（含 role）
   */
  verifyToken(token: string): { role: string } {
    const payload = jwt.verify(token, JWT_SECRET) as { role: string; v?: string };
    // 版本号不一致说明密码在签发后被修改，该 token 视为已吊销
    if (!payload.v || payload.v !== this.tokenVersion()) {
      throw new Error('Token revoked');
    }
    return payload;
  }

  /**
   * 身份验证开关状态（settings.auth_enabled，默认开启）。
   * @returns 是否启用鉴权
   */
  isAuthEnabled(): boolean {
    const value = this.settings.get('auth_enabled');
    return value !== '0'; // default to enabled
  }

  /**
   * 读取当前 token 版本号（未设置过视为 0，改密时 +1）。
   * @returns 版本号字符串
   */
  private tokenVersion(): string {
    return this.settings.get('auth_token_version') ?? '0';
  }
}
