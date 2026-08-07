import type { Database } from 'better-sqlite3';
import type { Migration } from './runner';

/** 预设标签元数据字段定义（全能参考） */
const REFERENCE_METADATA_DEF = JSON.stringify([
  { key: 'maxImageCount', label: '图片数量', type: 'number', defaultValue: 9 },
  { key: 'maxAudioCount', label: '音频数量', type: 'number', defaultValue: 3 },
  { key: 'maxVideoCount', label: '视频数量', type: 'number', defaultValue: 3 },
  { key: 'maxTotalCount', label: '参考总数量', type: 'number', defaultValue: 12 },
]);

/** 预设标签种子数据（父在前） */
const PRESET_TAGS: ReadonlyArray<{ id: string; name: string; parentId: string | null; metadataDef: string }> = [
  { id: 'text-to-image', name: '文生图', parentId: null, metadataDef: '[]' },
  { id: 'image-edit', name: '图片编辑', parentId: null, metadataDef: '[]' },
  { id: 'text-to-video', name: '文生视频', parentId: null, metadataDef: '[]' },
  { id: 'image-to-video', name: '图生视频', parentId: null, metadataDef: '[]' },
  { id: 'reference', name: '全能参考', parentId: 'image-to-video', metadataDef: REFERENCE_METADATA_DEF },
  { id: 'first-frame', name: '首帧', parentId: 'image-to-video', metadataDef: '[]' },
  { id: 'first-last-frame', name: '首尾帧', parentId: 'image-to-video', metadataDef: '[]' },
  { id: 'director', name: '导演台', parentId: 'image-to-video', metadataDef: '[]' },
  { id: 'audio-input', name: '音频输入', parentId: 'image-to-video', metadataDef: '[]' },
  { id: 'audio-output', name: '音频输出', parentId: 'image-to-video', metadataDef: '[]' },
  { id: 'tts-voice-design', name: 'TTS音色设计', parentId: null, metadataDef: '[]' },
];

/**
 * 迁移 5：工作流标签系统。
 * 新建 tags / workflow_tags 表，并种子预设标签（幂等）。
 */
export const v5: Migration = {
  version: 5,
  name: 'workflow tags',
  up: (sqlite: Database) => {
    // ① tags 表（幂等）
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        is_preset INTEGER NOT NULL DEFAULT 0,
        metadata_def TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // ② workflow_tags 表（幂等）
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS workflow_tags (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        metadata_values TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (workflow_id, tag_id)
      )
    `);
    // ③ 种子预设标签（已存在同 id 则跳过）
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      'INSERT OR IGNORE INTO tags (id, name, parent_id, is_preset, metadata_def, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    );
    for (const t of PRESET_TAGS) {
      insert.run(t.id, t.name, t.parentId, t.metadataDef, now, now);
    }
  },
};
