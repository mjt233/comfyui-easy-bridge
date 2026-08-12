import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/** 预设标签种子数据（父在前） */
const PRESET_TAGS: ReadonlyArray<{ id: string; name: string; parentId: string | null; metadataDef: string }> = [
  { id: 'tts-voice-clone', name: 'TTS音色克隆', parentId: null, metadataDef: '[]' },
];

/**
 * 迁移 7：补充种子预设标签 TTS音色克隆。
 * 兼容已应用 v5 的旧库（v5 种子不含该标签），幂等（已存在同 id 则跳过）。
 */
export const v7: Migration = {
  version: 7,
  name: 'add tts voice clone tag',
  up: (sqlite: Database) => {
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      'INSERT OR IGNORE INTO tags (id, name, parent_id, is_preset, metadata_def, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    );
    for (const t of PRESET_TAGS) {
      insert.run(t.id, t.name, t.parentId, t.metadataDef, now, now);
    }
  },
};
