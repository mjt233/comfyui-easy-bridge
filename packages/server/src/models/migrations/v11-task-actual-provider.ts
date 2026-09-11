import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/**
 * 迁移 11：task_logs 增加 actual_provider_id / actual_provider_name 两列。
 * 分组（group）类型的提供商不直接执行任务，任务由分组内某个成员实例实际执行；
 * 这两列记录实际执行该任务的成员实例，使中断、输出回源与资产清理能定位到正确实例。
 * provider_id / provider_name 语义不变，仍记录用户选择的实例（分组任务即为分组本身）。
 *
 * 回填：升级前已在执行的 pending 任务没有 actual_* 记录，而并发统计已改为按
 * actual_provider_id 计数（分组任务与普通任务的统计口径统一），若不回填，
 * 这些任务将不再占用并发槽位。因此把非分组实例的 pending 任务回填为原实例。
 */
export const v11: Migration = {
  version: 11,
  name: 'task actual provider',
  up: (sqlite: Database) => {
    // 幂等补齐：旧库重复执行时列已存在则跳过
    const cols = sqlite.prepare('PRAGMA table_info(task_logs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'actual_provider_id')) {
      sqlite.exec('ALTER TABLE task_logs ADD COLUMN actual_provider_id TEXT');
    }
    if (!cols.some((c) => c.name === 'actual_provider_name')) {
      sqlite.exec('ALTER TABLE task_logs ADD COLUMN actual_provider_name TEXT');
    }
    // 回填在执行的普通任务：provider_id 指向的即为实际执行实例
    sqlite.exec(`
      UPDATE task_logs
         SET actual_provider_id = provider_id,
             actual_provider_name = provider_name
       WHERE status = 'pending'
         AND actual_provider_id IS NULL
         AND provider_id IS NOT NULL
    `);
  },
};
