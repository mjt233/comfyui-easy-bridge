import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/** 迁移 10：workflow_params 增加 candidates（候选项 JSON 数组，元素为 {label, value}）与 multiple（是否多选）列，供执行表单下拉选择 */
export const v10: Migration = {
  version: 10,
  name: 'workflow param candidates',
  up: (sqlite: Database) => {
    // 幂等补齐：重复执行时列已存在则跳过
    const cols = sqlite.prepare('PRAGMA table_info(workflow_params)').all() as Array<{ name: string }>;
    // 候选项 JSON 数组（[{label, value}]，label 展示 / value 提交；兼容旧版纯字符串项）；'[]' 表示未配置
    if (!cols.some((c) => c.name === 'candidates')) {
      sqlite.exec("ALTER TABLE workflow_params ADD COLUMN candidates TEXT NOT NULL DEFAULT '[]'");
    }
    // 是否多选：0=单选，1=多选（多选提交时值以英文逗号拼接）
    if (!cols.some((c) => c.name === 'multiple')) {
      sqlite.exec('ALTER TABLE workflow_params ADD COLUMN multiple INTEGER NOT NULL DEFAULT 0');
    }
  },
};
