import { v1 } from './v1-initial-schema';
import { v2 } from './v2-task-original-form';
import { v3 } from './v3-declared-params';
import { v4 } from './v4-execution-providers';
import { v5 } from './v5-workflow-tags';
import { v6 } from './v6-task-uploaded-files';
import { v7 } from './v7-add-tts-voice-clone-tag';
import type { Migration } from './runner';

/** 迁移注册表：按 version 升序排列；新增迁移时在此追加 */
export const migrations: readonly Migration[] = [v1, v2, v3, v4, v5, v6, v7];
