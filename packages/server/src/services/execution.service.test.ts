import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { parseHistoryOutputs, resolveHistoryOutcome, startExecutionService } from './execution.service';
import { TaskService } from './task.service';
import { ProviderService } from './providers/provider.service';

/**
 * 构建 :memory: 数据库（providers / settings / task_logs / workflows 四表最小结构）。
 * @returns drizzle 数据库实例
 */
function createInMemoryDb() {
  const sqlite = new Database(':memory:');
  // 建表：providers / settings / task_logs / workflows（最小结构）
  sqlite.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, completed_at TEXT, provider_id TEXT);
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, build_script TEXT NOT NULL DEFAULT '', build_script_enabled INTEGER NOT NULL DEFAULT 0, declared_params TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, provider_id TEXT);
  `);
  return drizzle(sqlite, { schema });
}

/**
 * 直接插入一条启用状态的 comfyui 提供商记录。
 * @param db 数据库实例
 * @param id 提供商 ID
 * @param baseUrl 基础地址
 * @param concurrency 并发上限（默认 1）
 */
function insertProvider(db: ReturnType<typeof createInMemoryDb>, id: string, baseUrl: string, concurrency = 1): void {
  const now = new Date().toISOString();
  db.insert(schema.providers).values({
    id,
    name: id,
    type: 'comfyui',
    config: JSON.stringify({ baseUrl }),
    concurrency,
    enabled: 1,
    createdAt: now,
    updatedAt: now,
  }).run();
}

/**
 * 直接插入一条 queued 状态的任务记录。
 * @param db 数据库实例
 * @param id 任务 ID
 * @param providerId 归属提供商 ID
 */
function insertQueuedTask(db: ReturnType<typeof createInMemoryDb>, id: string, providerId: string): void {
  const now = new Date().toISOString();
  db.insert(schema.taskLogs).values({
    id,
    workflowId: 'wf-1',
    workflowName: 'wf',
    providerId,
    promptId: null,
    aliasValues: '{}',
    originalForm: null,
    comfyuiUrl: 'http://x',
    comfyuiRequestBody: '{"prompt":{}}',
    comfyuiResponse: null,
    outputFiles: null,
    status: 'queued',
    errorMessage: null,
    progress: null,
    createdAt: now,
    completedAt: null,
  }).run();
}

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
    const db = createInMemoryDb();
    const svc = startExecutionService(db);
    expect(svc.stop).toBeTypeOf('function');
    svc.stop();
  });
});

/**
 * 跟踪器行为测试：
 * 使用 :memory: 数据库 + 打桩 fetch，验证真实跟踪器的队列调度与重建逻辑。
 */
describe('createProviderTracker behavior', () => {
  afterEach(() => {
    // 清理全局打桩，避免影响其他测试
    vi.unstubAllGlobals();
  });

  it('drainQueue 只提交自身提供商的 queued 任务', async () => {
    const db = createInMemoryDb();
    // 两个启用的 comfyui 提供商，并发均为 1
    insertProvider(db, 'p1', 'http://x');
    insertProvider(db, 'p2', 'http://x');
    // 仅 p1 下有一条 queued 任务
    insertQueuedTask(db, 't1', 'p1');

    // 打桩 fetch：/prompt 返回固定 prompt_id
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ prompt_id: 'pid-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const svc = startExecutionService(db);
    try {
      const taskService = new TaskService(db);
      // 启动后的初始 drain 应将 t1 提交为 pending 并带上 promptId
      await vi.waitFor(() => {
        const t = taskService.getById('t1');
        expect(t?.status).toBe('pending');
        expect(t?.promptId).toBe('pid-1');
      });
      // 仅 p1 的跟踪器提交了任务（p2 无 queued 任务，不触发提交）
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      svc.stop();
    }
  });

  it('rebuilds trackers on provider change notified from another ProviderService instance', async () => {
    const db = createInMemoryDb();
    insertProvider(db, 'p1', 'http://a');
    const taskService = new TaskService(db);

    // 打桩 fetch：/prompt 返回固定 prompt_id，其余端点返回空对象
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/prompt')) {
        return new Response(JSON.stringify({ prompt_id: 'pid-new' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const svc = startExecutionService(db);
    try {
      // 通过另一个 ProviderService 实例插入新提供商与任务，再触发变更通知
      const other = new ProviderService(db);
      const p2 = other.create({ name: 'P2', type: 'comfyui', config: { baseUrl: 'http://b' }, concurrency: 1 });
      insertQueuedTask(db, 't2', p2.id);
      other.notifyChange(); // 必须能触发执行服务的重建

      // 重建后新实例的跟踪器应启动并排空新任务
      await vi.waitFor(() => {
        const t = taskService.getById('t2');
        expect(t?.status).toBe('pending');
      });
      const t = taskService.getById('t2');
      expect(t?.promptId).toBe('pid-new');
    } finally {
      svc.stop();
    }
  });
});
