import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { parseHistoryOutputs, resolveHistoryOutcome, startExecutionService } from './execution.service';

/**
 * resolveHistoryOutcome 单元测试：
 * 覆盖 ComfyUI /history 成功、失败、中断与仍在执行等结果解析。
 */
describe('resolveHistoryOutcome', () => {
  /** 测试用 prompt_id */
  const promptId = 'prompt-1';

  it('returns running when history has no entry', () => {
    expect(resolveHistoryOutcome({}, promptId)).toEqual({ kind: 'running' });
  });

  it('returns running when historyData is null', () => {
    expect(resolveHistoryOutcome(null, promptId)).toEqual({ kind: 'running' });
  });

  it('returns completed for success status', () => {
    const history = {
      [promptId]: {
        status: { status_str: 'success', completed: true, messages: [] },
        outputs: {},
      },
    };
    expect(resolveHistoryOutcome(history, promptId)).toEqual({ kind: 'completed' });
  });

  it('returns completed when completed is true even without status_str', () => {
    const history = {
      [promptId]: {
        status: { completed: true, messages: [] },
        outputs: {},
      },
    };
    expect(resolveHistoryOutcome(history, promptId)).toEqual({ kind: 'completed' });
  });

  it('returns failed for error status with exception_message', () => {
    const history = {
      [promptId]: {
        status: {
          status_str: 'error',
          completed: false,
          messages: [
            ['execution_error', { exception_message: 'CUDA OOM' }],
          ],
        },
        outputs: {},
      },
    };
    expect(resolveHistoryOutcome(history, promptId)).toEqual({
      kind: 'failed',
      errorMessage: 'CUDA OOM',
    });
  });

  it('returns failed with default message when error has no exception_message', () => {
    const history = {
      [promptId]: {
        status: {
          status_str: 'error',
          completed: false,
          messages: [],
        },
        outputs: {},
      },
    };
    expect(resolveHistoryOutcome(history, promptId)).toEqual({
      kind: 'failed',
      errorMessage: 'Execution error',
    });
  });

  it('returns failed for execution_interrupted messages', () => {
    const history = {
      [promptId]: {
        status: {
          status_str: 'error',
          completed: false,
          messages: [['execution_interrupted', { node_id: '1' }]],
        },
        outputs: {},
      },
    };
    const result = resolveHistoryOutcome(history, promptId);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.errorMessage.toLowerCase()).toContain('interrupt');
    }
  });
});

/**
 * parseHistoryOutputs 单元测试：
 * 覆盖 history 中 images/videos/audio 输出解析与空结果场景。
 */
describe('parseHistoryOutputs', () => {
  /** 测试用 prompt_id */
  const promptId = 'prompt-1';

  it('returns empty array when history has no prompt entry', () => {
    expect(parseHistoryOutputs({}, promptId)).toEqual([]);
  });

  it('returns empty array when historyData is null', () => {
    expect(parseHistoryOutputs(null, promptId)).toEqual([]);
  });

  it('returns empty array when outputs is missing', () => {
    const history = {
      [promptId]: {
        status: { status_str: 'success', completed: true },
      },
    };
    expect(parseHistoryOutputs(history, promptId)).toEqual([]);
  });

  it('parses image outputs from a single node', () => {
    const history = {
      [promptId]: {
        status: { status_str: 'success', completed: true },
        outputs: {
          '9': {
            images: [
              { filename: 'out.png', subfolder: '', type: 'output' },
            ],
          },
        },
      },
    };
    expect(parseHistoryOutputs(history, promptId)).toEqual([
      {
        filename: 'out.png',
        subfolder: '',
        type: 'output',
        nodeId: '9',
        fileType: 'image',
      },
    ]);
  });

  it('parses multi-node multi-file outputs including video and audio', () => {
    const history = {
      [promptId]: {
        status: { status_str: 'success', completed: true },
        outputs: {
          '9': {
            images: [
              { filename: 'a.png', subfolder: 'sub', type: 'output' },
              { filename: 'b.png', subfolder: '', type: 'output' },
            ],
          },
          '12': {
            videos: [
              { filename: 'clip.mp4', subfolder: 'v', type: 'output' },
            ],
            audio: [
              { filename: 'sound.wav', subfolder: '', type: 'output' },
            ],
          },
        },
      },
    };
    expect(parseHistoryOutputs(history, promptId)).toEqual([
      {
        filename: 'a.png',
        subfolder: 'sub',
        type: 'output',
        nodeId: '9',
        fileType: 'image',
      },
      {
        filename: 'b.png',
        subfolder: '',
        type: 'output',
        nodeId: '9',
        fileType: 'image',
      },
      {
        filename: 'clip.mp4',
        subfolder: 'v',
        type: 'output',
        nodeId: '12',
        fileType: 'video',
      },
      {
        filename: 'sound.wav',
        subfolder: '',
        type: 'output',
        nodeId: '12',
        fileType: 'audio',
      },
    ]);
  });
});

/**
 * startExecutionService 冒烟测试：
 * 在 :memory: 数据库中启动/停止执行服务，验证不抛异常。
 */
describe('startExecutionService', () => {
  it('starts and stops without throwing', () => {
    const sqlite = new Database(':memory:');
    // 建表：providers / settings / task_logs / workflows（最小结构）
    sqlite.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT, provider_id TEXT);
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, provider_id TEXT);
    `);
    const db = drizzle(sqlite, { schema });
    const svc = startExecutionService(db);
    expect(svc.stop).toBeTypeOf('function');
    svc.stop();
  });
});
