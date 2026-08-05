import { v1 } from './v1-initial-schema';
import { v2 } from './v2-task-original-form';
import { v3 } from './v3-declared-params';
import type { Migration } from './runner';

/** 迁移注册表：按 version 升序排列；新增迁移时在此追加 */
export const migrations: readonly Migration[] = [v1, v2, v3];
