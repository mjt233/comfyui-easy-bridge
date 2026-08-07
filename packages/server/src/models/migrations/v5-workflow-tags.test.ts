import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './runner';

describe('迁移 v5 工作流标签', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    runMigrations(sqlite);
  });

  it('创建 tags / workflow_tags 表并种子预设标签', () => {
    const rows = sqlite.prepare('SELECT id, name, parent_id, is_preset FROM tags ORDER BY created_at').all() as Array<{
      id: string; name: string; parent_id: string | null; is_preset: number;
    }>;
    expect(rows.length).toBe(11);
    const imageToVideo = rows.find((r) => r.id === 'image-to-video');
    expect(imageToVideo?.name).toBe('图生视频');
    expect(imageToVideo?.is_preset).toBe(1);
    const reference = rows.find((r) => r.id === 'reference');
    expect(reference?.parent_id).toBe('image-to-video');
    const def = JSON.parse(
      (sqlite.prepare("SELECT metadata_def FROM tags WHERE id='reference'").get() as { metadata_def: string }).metadata_def,
    ) as Array<{ key: string; defaultValue: number }>;
    expect(def.find((d) => d.key === 'maxImageCount')?.defaultValue).toBe(9);
  });

  it('重复执行迁移幂等', () => {
    runMigrations(sqlite); // 再次执行不应报错
    const count = sqlite.prepare('SELECT COUNT(*) AS c FROM tags').get() as { c: number };
    expect(count.c).toBe(11);
  });
});
