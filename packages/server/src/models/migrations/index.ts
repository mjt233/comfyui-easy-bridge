import { v1 } from './v1-initial-schema';
import type { Migration } from './runner';

/** 迁移注册表：按 version 升序排列；新增迁移时在此追加 */
export const migrations: readonly Migration[] = [v1];
