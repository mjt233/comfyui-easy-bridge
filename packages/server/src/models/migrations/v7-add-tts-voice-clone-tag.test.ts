import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './runner';

describe('迁移 v7 TTS音色克隆标签', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    runMigrations(sqlite);
  });

  it('种子 tts-voice-clone 预设标签', () => {
    const row = sqlite
      .prepare("SELECT id, name, parent_id, is_preset FROM tags WHERE id='tts-voice-clone'")
      .get() as { id: string; name: string; parent_id: string | null; is_preset: number };
    expect(row?.name).toBe('TTS音色克隆');
    expect(row?.parent_id).toBeNull();
    expect(row?.is_preset).toBe(1);
  });

  it('重复执行迁移幂等', () => {
    runMigrations(sqlite); // 再次执行不应报错
    const count = sqlite
      .prepare("SELECT COUNT(*) AS c FROM tags WHERE id='tts-voice-clone'")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });
});
