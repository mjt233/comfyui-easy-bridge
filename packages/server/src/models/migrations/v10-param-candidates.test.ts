import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './runner';

describe('迁移 v10 参数候选项列', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    runMigrations(sqlite);
  });

  it('workflow_params 增加 candidates（非空默认 []）与 multiple（非空默认 0）列', () => {
    const cols = sqlite.prepare('PRAGMA table_info(workflow_params)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const candidates = cols.find((c) => c.name === 'candidates');
    const multiple = cols.find((c) => c.name === 'multiple');
    // 候选项列：非空，默认空数组 JSON（PRAGMA 返回的默认值带引号字面量）
    expect(candidates).toBeTruthy();
    expect(candidates?.notnull).toBe(1);
    expect(candidates?.dflt_value).toBe("'[]'");
    // 多选列：非空，默认 0（单选）
    expect(multiple).toBeTruthy();
    expect(multiple?.notnull).toBe(1);
    expect(Number(multiple?.dflt_value)).toBe(0);
  });

  it('重复执行迁移幂等', () => {
    runMigrations(sqlite); // 再次执行不应报错
    const cols = sqlite.prepare('PRAGMA table_info(workflow_params)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'candidates')).toBe(true);
    expect(cols.some((c) => c.name === 'multiple')).toBe(true);
  });
});
