import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import {
  parseHistoryOutputs,
  resolveHistoryOutcome,
  startExecutionService,
  drainProviderQueue,
  executionServiceConfig,
} from './execution.service';
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
    CREATE TABLE task_logs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, prompt_id TEXT, alias_values TEXT NOT NULL, original_form TEXT, comfyui_url TEXT NOT NULL, comfyui_request_body TEXT, comfyui_response TEXT, output_files TEXT, uploaded_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, progress INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, provider_id TEXT, provider_name TEXT, actual_provider_id TEXT, actual_provider_name TEXT);
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
 * actual_provider_id 与 provider_id 一致：普通实例任务的执行实例即其 providerId，
 * 跟踪器的并发统计与队列消费统一按实际执行实例口径。
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
    providerName: providerId,
    actualProviderId: providerId,
    actualProviderName: providerId,
    promptId: null,
    aliasValues: '{}',
    originalForm: null,
    comfyuiUrl: 'http://x',
    comfyuiRequestBody: '{"prompt":{}}',
    comfyuiResponse: null,
    outputFiles: null,
    uploadedFiles: '[]',
    status: 'queued',
    errorMessage: null,
    progress: null,
    createdAt: now,
    startedAt: null,
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

/**
 * 队列调度触发点测试：
 * 覆盖外部显式触发（drainProviderQueue）、一次触发填满并发槽位、以及周期性兜底扫描的自愈能力。
 */
describe('queue drain triggers', () => {
  /** 用例前的兜底轮询间隔，用例结束后恢复 */
  const defaultFallbackIntervalMs = executionServiceConfig.fallbackIntervalMs;

  afterEach(() => {
    vi.unstubAllGlobals();
    executionServiceConfig.fallbackIntervalMs = defaultFallbackIntervalMs;
  });

  it('drainProviderQueue submits queued tasks of the given provider only', async () => {
    const db = createInMemoryDb();
    insertProvider(db, 'p1', 'http://a');
    insertProvider(db, 'p2', 'http://b');
    const taskService = new TaskService(db);

    // 打桩 fetch：/prompt 返回固定 prompt_id，其余端点返回空对象
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/prompt')) {
        return new Response(JSON.stringify({ prompt_id: 'pid-1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

    const svc = startExecutionService(db);
    try {
      // 服务启动后再插入排队任务：init drain 已执行完毕，不会被自动提交
      insertQueuedTask(db, 't1', 'p1');
      insertQueuedTask(db, 't2', 'p2');

      // 显式触发 p1 的调度
      await drainProviderQueue('p1');
      const submitted = taskService.getById('t1');
      expect(submitted?.status).toBe('pending');
      expect(submitted?.promptId).toBe('pid-1');
      // 其他实例的排队任务不受影响
      expect(taskService.getById('t2')?.status).toBe('queued');
      // 未注册的实例静默返回，不抛异常
      await expect(drainProviderQueue('missing')).resolves.toBeUndefined();
    } finally {
      svc.stop();
    }
  });

  it('drainQueue fills all free concurrency slots in one trigger', async () => {
    const db = createInMemoryDb();
    // 并发上限 2，队列中有 3 条任务
    insertProvider(db, 'p1', 'http://a', 2);
    insertQueuedTask(db, 't1', 'p1');
    insertQueuedTask(db, 't2', 'p1');
    insertQueuedTask(db, 't3', 'p1');
    const taskService = new TaskService(db);

    // 每次提交返回递增的 prompt_id，便于区分提交顺序
    let submittedCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/prompt')) {
        submittedCount += 1;
        return new Response(JSON.stringify({ prompt_id: `pid-${submittedCount}` }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

    const svc = startExecutionService(db);
    try {
      // init drain 应一次填满 2 个槽位
      await vi.waitFor(() => {
        expect(taskService.getById('t1')?.status).toBe('pending');
        expect(taskService.getById('t2')?.status).toBe('pending');
      });
      // 槽位已满，第三条继续排队
      expect(taskService.getById('t3')?.status).toBe('queued');
      expect(submittedCount).toBe(2);
    } finally {
      svc.stop();
    }
  });

  it('periodic sweep submits queued tasks after the slot is freed externally', async () => {
    const db = createInMemoryDb();
    insertProvider(db, 'p1', 'http://a');
    const taskService = new TaskService(db);

    // 占用唯一槽位的 pending 任务（模拟正在执行）
    const running = taskService.create({
      workflowId: 'wf-1',
      workflowName: 'wf',
      aliasValues: '{}',
      comfyuiUrl: 'http://a',
      comfyuiRequestBody: '{"prompt":{}}',
      comfyuiResponse: null,
      promptId: 'pid-running',
      providerId: 'p1',
      providerName: 'p1',
    });
    insertQueuedTask(db, 't-queued', 'p1');

    // 缩短兜底轮询间隔，避免用例真实等待 10s
    executionServiceConfig.fallbackIntervalMs = 20;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/prompt')) {
        return new Response(JSON.stringify({ prompt_id: 'pid-queued' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

    const svc = startExecutionService(db);
    try {
      // 槽位已被 running 占满：init drain 不应提交排队任务
      expect(taskService.getById('t-queued')?.status).toBe('queued');

      // 模拟外部置终态（例如手动中断）：直接把执行中任务改为 failed，不经过跟踪器
      taskService.updateStatus(running.id, { status: 'failed', errorMessage: 'Cancelled by user' });

      // 周期性兜底扫描应发现空闲槽位并提交排队任务
      await vi.waitFor(() => {
        const queued = taskService.getById('t-queued');
        expect(queued?.status).toBe('pending');
        expect(queued?.promptId).toBe('pid-queued');
      });
    } finally {
      svc.stop();
    }
  });
});
