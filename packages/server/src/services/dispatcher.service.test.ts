import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderService } from './providers/provider.service';
import { HealthService, healthCheckConfig } from './providers/health.service';
import { DispatcherService, isPermanentSubmitError, rewriteUploadedFilenames } from './dispatcher.service';
import { TaskService } from './task.service';
import { buildTestDb } from './providers/test-db.helper';
import { stageUploads, type StagedFileMeta } from './task-staging.service';

/**
 * 打桩全局 fetch：
 * - /system_stats → 由 probeStatus 决定状态码（默认 200）
 * - /prompt → 200 并返回 prompt_id
 * 同时记录 /prompt 的调用次数，便于断言"只提交一次"。
 * @param options probeStatus 探测返回的状态码；probeFailFor 该主机名探测失败
 * @returns 提交调用记录
 */
function stubFetch(options?: { probeStatus?: number; promptStatus?: number; probeFailFor?: string }): { promptCalls: string[] } {
  const promptCalls: string[] = [];
  const probeStatus = options?.probeStatus ?? 200;
  const promptStatus = options?.promptStatus ?? 200;
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/system_stats')) {
      // 指定主机探测失败，用于验证"挑到不可用成员后换下一个"
      const fail = options?.probeFailFor ? url.includes(options.probeFailFor) : false;
      return new Response('{}', { status: fail ? 503 : probeStatus });
    }
    if (url.endsWith('/prompt')) {
      promptCalls.push(url);
      if (promptStatus !== 200) return new Response('bad request', { status: promptStatus });
      return new Response(JSON.stringify({ prompt_id: `pid-${promptCalls.length}` }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch);
  return { promptCalls };
}

describe('DispatcherService 统一队列调度', () => {
  let db: ReturnType<typeof buildTestDb>['db'];
  let providerService: ProviderService;
  let taskService: TaskService;
  let healthService: HealthService;
  let dispatcher: DispatcherService;

  beforeEach(() => {
    db = buildTestDb().db;
    providerService = new ProviderService(db);
    taskService = new TaskService(db);
    healthService = new HealthService(db);
    dispatcher = new DispatcherService(db, healthService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 建一个 comfyui 成员实例。
   * @param name 展示名（同时作为 baseUrl 主机名）
   * @param concurrency 并发上限
   * @returns 实例行
   */
  function createMember(name: string, concurrency = 1) {
    return providerService.create({
      name,
      type: 'comfyui',
      config: { baseUrl: `http://${name}:8188` },
      concurrency,
    });
  }

  /**
   * 建一个分组实例。
   * @param members 成员与权重
   * @param dispatchPolicy 调度策略
   * @returns 分组实例行
   */
  function createGroup(
    members: Array<{ providerId: string; weight: number }>,
    dispatchPolicy: 'priority' | 'random' = 'priority',
  ) {
    return providerService.create({
      name: 'G',
      type: 'group',
      config: { dispatchPolicy, members },
    });
  }

  /**
   * 插入一条排队中的分组任务（providerId 指向分组，actual 为空）。
   * @param groupId 分组实例 ID
   * @param originalForm 原始表单 JSON（含 stagedFiles 时触发媒体上传）
   * @returns 任务行
   */
  function createQueuedTask(groupId: string, originalForm: string | null = null) {
    const task = taskService.create({
      workflowId: 'wf-1',
      workflowName: 'wf',
      aliasValues: '{}',
      originalForm,
      comfyuiUrl: 'http://group/prompt',
      comfyuiRequestBody: '{"prompt":{"1":{"inputs":{}}}}',
      comfyuiResponse: null,
      promptId: null,
      providerId: groupId,
      providerName: 'G',
    });
    taskService.updateStatus(task.id, { status: 'queued' });
    return taskService.getById(task.id)!;
  }

  /**
   * 插入一条排队中的「指定实例」任务（actual 锁定为目标实例）。
   * @param providerId 目标实例 ID
   * @returns 任务行
   */
  function createQueuedTaskForProvider(providerId: string) {
    const task = taskService.create({
      workflowId: 'wf-1',
      workflowName: 'wf',
      aliasValues: '{}',
      comfyuiUrl: `http://${providerId}:8188/prompt`,
      comfyuiRequestBody: '{"prompt":{"1":{"inputs":{}}}}',
      comfyuiResponse: null,
      promptId: null,
      providerId,
      providerName: providerId,
    });
    taskService.updateStatus(task.id, { status: 'queued' });
    taskService.setActualProvider(task.id, {
      actualProviderId: providerId,
      actualProviderName: providerId,
      promptId: '',
    });
    return taskService.getById(task.id)!;
  }

  it('priority policy picks the member with the highest weight', async () => {
    stubFetch();
    const low = createMember('low');
    const high = createMember('high');
    const group = createGroup([{ providerId: low.id, weight: 1 }, { providerId: high.id, weight: 5 }]);
    const task = createQueuedTask(group.id);

    await dispatcher.drainGroup(group.id);

    const after = taskService.getById(task.id)!;
    expect(after.status).toBe('pending');
    expect(after.actualProviderId).toBe(high.id);
    // providerId 保持为分组，便于溯源用户的选择
    expect(after.providerId).toBe(group.id);
  });

  it('priority policy breaks ties by member configuration order', async () => {
    stubFetch();
    const first = createMember('first');
    const second = createMember('second');
    const group = createGroup([{ providerId: first.id, weight: 3 }, { providerId: second.id, weight: 3 }]);
    const task = createQueuedTask(group.id);

    await dispatcher.drainGroup(group.id);

    expect(taskService.getById(task.id)?.actualProviderId).toBe(first.id);
  });

  it('priority policy skips the highest-weight member when its slots are full', async () => {
    stubFetch();
    const high = createMember('high', 1);
    const low = createMember('low', 1);
    const group = createGroup([{ providerId: high.id, weight: 10 }, { providerId: low.id, weight: 1 }]);
    // 最高权重成员的唯一槽位已被别的任务占用
    const occupying = createQueuedTask(group.id);
    taskService.updateActualProvider(occupying.id, {
      actualProviderId: high.id,
      actualProviderName: 'high',
      promptId: 'pid-occupied',
    });

    const task = createQueuedTask(group.id);
    await dispatcher.drainGroup(group.id);

    // 权重更高者已满 → 分配给次高权重且有空闲槽位的成员
    expect(taskService.getById(task.id)?.actualProviderId).toBe(low.id);
  });

  it('leaves the task queued when every member has no free slot', async () => {
    const { promptCalls } = stubFetch();
    const only = createMember('only', 1);
    const group = createGroup([{ providerId: only.id, weight: 1 }]);
    const occupying = createQueuedTask(group.id);
    taskService.updateActualProvider(occupying.id, {
      actualProviderId: only.id,
      actualProviderName: 'only',
      promptId: 'pid-occupied',
    });

    const task = createQueuedTask(group.id);
    await dispatcher.drainGroup(group.id);

    // 无空闲槽位：本轮不分配，任务保留在队列等待（不失败、不丢失）
    expect(taskService.getById(task.id)?.status).toBe('queued');
    expect(promptCalls).toHaveLength(0);
  });

  it('skips a member that fails the pre-submit probe and uses the next candidate', async () => {
    stubFetch({ probeFailFor: 'bad' });
    const bad = createMember('bad');
    const good = createMember('good');
    // bad 权重更高，但探测失败 → 应换到 good
    const group = createGroup([{ providerId: bad.id, weight: 99 }, { providerId: good.id, weight: 1 }]);
    const task = createQueuedTask(group.id);

    await dispatcher.drainGroup(group.id);

    const after = taskService.getById(task.id)!;
    expect(after.actualProviderId).toBe(good.id);
    // 探测失败的成员进入冷却，后续挑选直接跳过
    expect(healthService.isHealthy(bad.id)).toBe(false);
    expect(healthService.isHealthy(good.id)).toBe(true);
  });

  it('keeps the task queued when all members fail the pre-submit probe', async () => {
    const { promptCalls } = stubFetch({ probeStatus: 503 });
    const a = createMember('a');
    const b = createMember('b');
    const group = createGroup([{ providerId: a.id, weight: 2 }, { providerId: b.id, weight: 1 }]);
    const task = createQueuedTask(group.id);

    await dispatcher.drainGroup(group.id);

    // 成员均不可用：任务留在队列，等待冷却结束或成员恢复
    expect(taskService.getById(task.id)?.status).toBe('queued');
    expect(promptCalls).toHaveLength(0);
  });

  it('does not select a member that is in health cooldown', async () => {
    const { promptCalls } = stubFetch();
    const cooling = createMember('cooling');
    const healthy = createMember('healthy');
    const group = createGroup([{ providerId: cooling.id, weight: 100 }, { providerId: healthy.id, weight: 1 }]);
    // 高权重成员已进入冷却
    healthService.markFailedNow(cooling.id, 'probe failed');
    const task = createQueuedTask(group.id);

    await dispatcher.drainGroup(group.id);

    expect(taskService.getById(task.id)?.actualProviderId).toBe(healthy.id);
    expect(promptCalls).toHaveLength(1);
  });

  it('random policy picks a member with free slots', async () => {
    stubFetch();
    const a = createMember('a');
    const b = createMember('b');
    const group = createGroup([{ providerId: a.id, weight: 1 }, { providerId: b.id, weight: 1 }], 'random');
    const task = createQueuedTask(group.id);

    await dispatcher.drainGroup(group.id);

    const after = taskService.getById(task.id)!;
    expect([a.id, b.id]).toContain(after.actualProviderId);
    expect(after.status).toBe('pending');
  });

  it('drains multiple queued tasks up to the available slots in one round', async () => {
    const { promptCalls } = stubFetch();
    const member = createMember('m', 2);
    const group = createGroup([{ providerId: member.id, weight: 1 }]);
    const t1 = createQueuedTask(group.id);
    const t2 = createQueuedTask(group.id);
    const t3 = createQueuedTask(group.id);

    await dispatcher.drainGroup(group.id);

    // 并发上限 2：两个任务被提交，第三个仍排队
    expect(taskService.getById(t1.id)?.status).toBe('pending');
    expect(taskService.getById(t2.id)?.status).toBe('pending');
    expect(taskService.getById(t3.id)?.status).toBe('queued');
    expect(promptCalls).toHaveLength(2);
  });

  it('marks the task failed on a permanent (4xx) submit error instead of retrying other members', async () => {
    const { promptCalls } = stubFetch({ promptStatus: 400 });
    const a = createMember('a');
    const b = createMember('b');
    // a 权重更高，会先被选中并返回 4xx
    const group = createGroup([{ providerId: a.id, weight: 2 }, { providerId: b.id, weight: 1 }]);
    const task = createQueuedTask(group.id);

    await dispatcher.drainGroup(group.id);

    // 工作流本身有问题：直接失败，不消耗其他成员
    const after = taskService.getById(task.id)!;
    expect(after.status).toBe('failed');
    expect(after.errorMessage).toContain('400');
    expect(promptCalls).toHaveLength(1);
  });

  it('keeps the task queued on a transient (5xx) submit error and cools the member down', async () => {
    stubFetch({ promptStatus: 500 });
    const a = createMember('a');
    const group = createGroup([{ providerId: a.id, weight: 1 }]);
    const task = createQueuedTask(group.id);

    await dispatcher.drainGroup(group.id);

    const after = taskService.getById(task.id)!;
    // 瞬时故障：任务保留在队列等待改投，成员进入冷却
    expect(after.status).toBe('queued');
    expect(healthService.isHealthy(a.id)).toBe(false);
  });

  it('drains the instance queue of a locked target independently from group queues', async () => {
    const { promptCalls } = stubFetch();
    const instance = createMember('solo', 2);
    const member = createMember('member');
    const group = createGroup([{ providerId: member.id, weight: 1 }]);

    // 一条锁定到实例的排队任务 + 一条分组排队任务
    const locked = createQueuedTaskForProvider(instance.id);
    const grouped = createQueuedTask(group.id);

    // 只调度实例队列：分组任务不受影响
    await dispatcher.drainProvider(instance.id);
    expect(taskService.getById(locked.id)?.status).toBe('pending');
    expect(taskService.getById(locked.id)?.actualProviderId).toBe(instance.id);
    expect(taskService.getById(grouped.id)?.status).toBe('queued');
    expect(promptCalls).toHaveLength(1);

    // 再调度分组队列：分组任务被投递到成员
    await dispatcher.drainGroup(group.id);
    expect(taskService.getById(grouped.id)?.status).toBe('pending');
  });

  it('drainAll consumes both instance and group queues', async () => {
    stubFetch();
    const instance = createMember('solo');
    const member = createMember('member');
    const group = createGroup([{ providerId: member.id, weight: 1 }]);
    const locked = createQueuedTaskForProvider(instance.id);
    const grouped = createQueuedTask(group.id);

    await dispatcher.drainAll();

    expect(taskService.getById(locked.id)?.status).toBe('pending');
    expect(taskService.getById(grouped.id)?.status).toBe('pending');
  });

  it('leaves the instance queue untouched when the target instance has no free slot', async () => {
    const { promptCalls } = stubFetch();
    const instance = createMember('busy', 1);
    // 占满唯一槽位
    const occupying = createQueuedTaskForProvider(instance.id);
    await dispatcher.drainProvider(instance.id);
    expect(taskService.getById(occupying.id)?.status).toBe('pending');

    const queued = createQueuedTaskForProvider(instance.id);
    await dispatcher.drainProvider(instance.id);

    // 槽位已满：任务保留在队列
    expect(taskService.getById(queued.id)?.status).toBe('queued');
    expect(promptCalls).toHaveLength(1);
  });

  it('keeps the task queued when the locked target instance fails the probe', async () => {
    stubFetch({ probeStatus: 503 });
    const instance = createMember('dead');
    const task = createQueuedTaskForProvider(instance.id);

    await dispatcher.drainProvider(instance.id);

    // 目标实例不可达：任务保留在队列等待恢复（不置失败，用户可改选实例）
    expect(taskService.getById(task.id)?.status).toBe('queued');
    expect(healthService.isHealthy(instance.id)).toBe(false);
  });

  it('submitTaskNow bypasses the concurrency limit for a queue-jump submit', async () => {
    const { promptCalls } = stubFetch();
    const instance = createMember('jump', 1);
    // 占满唯一槽位
    const occupying = createQueuedTaskForProvider(instance.id);
    await dispatcher.drainProvider(instance.id);
    expect(taskService.getById(occupying.id)?.status).toBe('pending');

    // 再入队一条：并发已满，自动调度不会提交
    const queued = createQueuedTaskForProvider(instance.id);
    await dispatcher.drainProvider(instance.id);
    expect(taskService.getById(queued.id)?.status).toBe('queued');

    // 立即提交（插队）：无视并发上限直接提交
    const outcome = await dispatcher.submitTaskNow(queued.id, providerService.getEnabledProviderById(instance.id)!);
    expect(outcome).toBe('submitted');
    expect(taskService.getById(queued.id)?.status).toBe('pending');
    expect(promptCalls).toHaveLength(2);
  });

  it('submitTaskNow reports unavailable (task stays queued) when the probe fails', async () => {
    stubFetch({ probeStatus: 503 });
    const instance = createMember('dead');
    const task = createQueuedTaskForProvider(instance.id);

    const outcome = await dispatcher.submitTaskNow(task.id, providerService.getEnabledProviderById(instance.id)!);

    expect(outcome).toBe('unavailable');
    // 保持 queued：用户可改选其他实例重试
    expect(taskService.getById(task.id)?.status).toBe('queued');
  });

  it('submitTaskNow fails a task whose request body is missing', async () => {
    stubFetch();
    const instance = createMember('inst');
    const task = taskService.create({
      workflowId: 'wf-1',
      workflowName: 'wf',
      aliasValues: '{}',
      comfyuiUrl: 'http://inst:8188/prompt',
      comfyuiRequestBody: null,
      comfyuiResponse: null,
      promptId: null,
      providerId: instance.id,
      providerName: 'inst',
    });
    taskService.updateStatus(task.id, { status: 'queued' });

    const outcome = await dispatcher.submitTaskNow(task.id, providerService.getEnabledProviderById(instance.id)!);

    expect(outcome).toBe('failed');
    expect(taskService.getById(task.id)?.status).toBe('failed');
  });

  it('does not submit the same task twice when drain is triggered concurrently', async () => {
    const { promptCalls } = stubFetch();
    const member = createMember('m', 1);
    const group = createGroup([{ providerId: member.id, weight: 1 }]);
    const task = createQueuedTask(group.id);

    await Promise.all([dispatcher.drainGroup(group.id), dispatcher.drainGroup(group.id), dispatcher.drainAll()]);

    expect(promptCalls).toHaveLength(1);
    expect(taskService.getById(task.id)?.status).toBe('pending');
  });

  it('fails a queued task whose request body is missing', async () => {
    stubFetch();
    const member = createMember('m');
    const group = createGroup([{ providerId: member.id, weight: 1 }]);
    const task = taskService.create({
      workflowId: 'wf-1',
      workflowName: 'wf',
      aliasValues: '{}',
      comfyuiUrl: 'http://group/prompt',
      comfyuiRequestBody: null,
      comfyuiResponse: null,
      promptId: null,
      providerId: group.id,
      providerName: 'G',
    });
    taskService.updateStatus(task.id, { status: 'queued' });

    await dispatcher.drainGroup(group.id);

    const after = taskService.getById(task.id)!;
    expect(after.status).toBe('failed');
    expect(after.errorMessage).toContain('Missing request body');
  });

  it('ignores queued tasks of a disabled group', async () => {
    const { promptCalls } = stubFetch();
    const member = createMember('m');
    const group = createGroup([{ providerId: member.id, weight: 1 }]);
    const task = createQueuedTask(group.id);
    providerService.update(group.id, { enabled: false });

    await dispatcher.drainAll();

    expect(taskService.getById(task.id)?.status).toBe('queued');
    expect(promptCalls).toHaveLength(0);
  });

  it('ignores the instance queue of a disabled instance', async () => {
    const { promptCalls } = stubFetch();
    const instance = createMember('inst');
    const task = createQueuedTaskForProvider(instance.id);
    providerService.update(instance.id, { enabled: false });

    await dispatcher.drainAll();

    expect(taskService.getById(task.id)?.status).toBe('queued');
    expect(promptCalls).toHaveLength(0);
  });
});

describe('rewriteUploadedFilenames', () => {
  it('replaces staged names with the member-side filenames across nested nodes', () => {
    const body = JSON.stringify({
      prompt: {
        '1': { inputs: { image: 'demo_aaa111.png' }, class_type: 'LoadImage' },
        '2': { inputs: { images: ['demo_aaa111.png', 'other.png'] } },
        '3': { inputs: { seed: 12, flag: true, none: null } },
      },
    });
    const rewritten = JSON.parse(rewriteUploadedFilenames(body, new Map([['demo_aaa111.png', 'openapi/xyz.png']]))) as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    // 单值与数组元素同时替换，未命中的值与类型保持不变
    expect(rewritten.prompt['1'].inputs.image).toBe('openapi/xyz.png');
    expect(rewritten.prompt['2'].inputs.images).toEqual(['openapi/xyz.png', 'other.png']);
    expect(rewritten.prompt['3'].inputs).toEqual({ seed: 12, flag: true, none: null });
  });

  it('returns the original body when there is nothing to rewrite', () => {
    const body = '{"prompt":{"1":{"inputs":{"image":"a.png"}}}}';
    expect(rewriteUploadedFilenames(body, new Map())).toBe(body);
    // 映射存在但请求体中无匹配项时内容等价（不抛错）
    expect(JSON.parse(rewriteUploadedFilenames(body, new Map([['x.png', 'y.png']])))).toEqual(JSON.parse(body));
  });

  it('returns the original body when it is not valid JSON', () => {
    const broken = 'not-json';
    expect(rewriteUploadedFilenames(broken, new Map([['a', 'b']]))).toBe(broken);
  });
});

describe('DispatcherService 分组媒体上传', () => {
  let db: ReturnType<typeof buildTestDb>['db'];
  let providerService: ProviderService;
  let taskService: TaskService;
  let healthService: HealthService;
  let dispatcher: DispatcherService;
  /** 临时 DATA_DIR（暂存文件隔离用），用例结束后恢复 */
  let previousDataDir: string | undefined;
  let tempDataDir = '';

  beforeEach(() => {
    db = buildTestDb().db;
    providerService = new ProviderService(db);
    taskService = new TaskService(db);
    healthService = new HealthService(db);
    dispatcher = new DispatcherService(db, healthService);
    // 暂存目录按 DATA_DIR 解析，指向临时目录避免污染仓库 data 目录
    previousDataDir = process.env.DATA_DIR;
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-media-test-'));
    process.env.DATA_DIR = tempDataDir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  });

  /**
   * 建一个分组任务：原始表单携带暂存元数据，暂存文件已落盘。
   * @param groupId 分组实例 ID
   * @param stagedName 本地暂存名（提交前请求体中引用的占位名）
   * @param originalname 用户上传的原始文件名
   * @returns 排队中的任务行
   */
  async function createQueuedTaskWithStagedMedia(groupId: string, stagedName: string, originalname: string) {
    return createQueuedTaskWithMedia(groupId, stagedName, originalname, false);
  }

  /**
   * 建一个带暂存媒体的排队任务（分组或指定实例目标）。
   * @param targetId 目标实例 ID（分组或具体实例）
   * @param stagedName 本地暂存名（提交前请求体中引用的占位名）
   * @param originalname 用户上传的原始文件名
   * @param lockActual 是否锁定实际执行实例（具体实例目标为 true，分组目标为 false）
   * @returns 排队中的任务行
   */
  async function createQueuedTaskWithMedia(
    targetId: string,
    stagedName: string,
    originalname: string,
    lockActual: boolean,
  ) {
    const meta: StagedFileMeta = {
      alias: 'image',
      fieldName: 'image',
      stagedName,
      originalname,
      mimetype: 'image/png',
      size: 3,
      paramType: 'image',
    };
    const task = taskService.create({
      workflowId: 'wf-1',
      workflowName: 'wf',
      aliasValues: JSON.stringify({ image: stagedName }),
      originalForm: JSON.stringify({ params: {}, files: [], stagedFiles: [meta] }),
      comfyuiUrl: `http://${targetId}/prompt`,
      // 请求体引用的是暂存名（提交阶段写入的占位文件名）
      comfyuiRequestBody: JSON.stringify({ prompt: { '1': { inputs: { image: stagedName } } } }),
      comfyuiResponse: null,
      promptId: null,
      providerId: targetId,
      providerName: targetId,
      uploadedFiles: JSON.stringify([stagedName]),
    });
    taskService.updateStatus(task.id, { status: 'queued' });
    if (lockActual) {
      taskService.setActualProvider(task.id, {
        actualProviderId: targetId,
        actualProviderName: targetId,
        promptId: '',
      });
    }
    await stageUploads(task.id, [{ meta, buffer: Buffer.from('png') }]);
    return taskService.getById(task.id)!;
  }

  it('submits the member-side filename returned by the upload instead of the staged name', async () => {
    const promptBodies: string[] = [];
    const uploadFilenames: string[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/system_stats')) return new Response('{}', { status: 200 });
      if (url.endsWith('/upload/image')) {
        // 记录 multipart 中实际发送的文件名（保留原始主体名 + 唯一后缀）
        const form = init?.body as FormData;
        uploadFilenames.push((form.get('image') as unknown as { name: string }).name);
        // 执行端返回自己生成的文件名（与本地暂存名不同）
        return new Response(JSON.stringify({ name: 'member-side_zzz999.png' }), { status: 200 });
      }
      if (url.endsWith('/prompt')) {
        promptBodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({ prompt_id: 'pid-1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);

    const member = providerService.create({ name: 'm', type: 'comfyui', config: { baseUrl: 'http://m:8188' } });
    const group = providerService.create({
      name: 'G',
      type: 'group',
      config: { dispatchPolicy: 'priority', members: [{ providerId: member.id, weight: 1 }] },
    });
    const task = await createQueuedTaskWithStagedMedia(group.id, 'demo_aaa111.png', 'demo.png');

    await dispatcher.drainGroup(group.id);

    // 上传的是暂存文件内容，文件名由执行提供商按原始名重新生成
    expect(uploadFilenames).toHaveLength(1);
    expect(uploadFilenames[0]).toMatch(/^demo_[0-9a-f]{6}\.png$/);
    // 提交的请求体必须引用执行端返回的文件名，否则执行端会报文件不存在
    expect(promptBodies).toHaveLength(1);
    const submitted = JSON.parse(promptBodies[0]) as { prompt: Record<string, { inputs: { image: string } }> };
    expect(submitted.prompt['1'].inputs.image).toBe('member-side_zzz999.png');
    // 任务记录保留暂存名形态的请求体（便于改投其他成员时重新回写）
    const after = taskService.getById(task.id)!;
    expect(after.status).toBe('pending');
    expect(after.actualProviderId).toBe(member.id);
    expect(JSON.parse(after.comfyuiRequestBody ?? '{}').prompt['1'].inputs.image).toBe('demo_aaa111.png');
    // 实例侧真实文件名追加进 uploaded_files，供终态后的资产自动清理
    expect(JSON.parse(after.uploadedFiles)).toEqual(['demo_aaa111.png', 'member-side_zzz999.png']);
  });

  it('cools down a member whose upload fails and submits to the next candidate', async () => {
    const promptBodies: string[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/system_stats')) return new Response('{}', { status: 200 });
      if (url.endsWith('/upload/image')) {
        // 高权重成员的媒体上传失败（实例级故障）
        if (url.includes('bad:8188')) return new Response('upload exploded', { status: 500 });
        return new Response(JSON.stringify({ name: 'good-side.png' }), { status: 200 });
      }
      if (url.endsWith('/prompt')) {
        promptBodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({ prompt_id: 'pid-1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);

    const bad = providerService.create({ name: 'bad', type: 'comfyui', config: { baseUrl: 'http://bad:8188' } });
    const good = providerService.create({ name: 'good', type: 'comfyui', config: { baseUrl: 'http://good:8188' } });
    const group = providerService.create({
      name: 'G',
      type: 'group',
      // bad 权重更高 → 优先选中，其上传失败后应冷却并改投 good
      config: { dispatchPolicy: 'priority', members: [{ providerId: bad.id, weight: 5 }, { providerId: good.id, weight: 1 }] },
    });
    const task = await createQueuedTaskWithStagedMedia(group.id, 'demo_aaa111.png', 'demo.png');

    await dispatcher.drainGroup(group.id);

    // 失败成员进入冷却，任务改投下一个候选并改用该成员返回的文件名
    expect(healthService.getSnapshot(bad.id).inCooldown).toBe(true);
    expect(promptBodies).toHaveLength(1);
    expect(JSON.parse(promptBodies[0]).prompt['1'].inputs.image).toBe('good-side.png');
    const after = taskService.getById(task.id)!;
    expect(after.status).toBe('pending');
    expect(after.actualProviderId).toBe(good.id);
  });

  it('uploads staged media to the locked instance target and rewrites the request body', async () => {
    const promptBodies: string[] = [];
    const uploadFilenames: string[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/system_stats')) return new Response('{}', { status: 200 });
      if (url.endsWith('/upload/image')) {
        const form = init?.body as FormData;
        uploadFilenames.push((form.get('image') as unknown as { name: string }).name);
        return new Response(JSON.stringify({ name: 'instance-side_zzz999.png' }), { status: 200 });
      }
      if (url.endsWith('/prompt')) {
        promptBodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({ prompt_id: 'pid-1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);

    // 指定实例目标（非分组）：媒体不再在入队时上传，而是调度提交前统一上传
    const instance = providerService.create({ name: 'solo', type: 'comfyui', config: { baseUrl: 'http://solo:8188' } });
    const task = await createQueuedTaskWithMedia(instance.id, 'demo_bbb222.png', 'demo.png', true);

    await dispatcher.drainProvider(instance.id);

    // 入队期间媒体只在本地暂存（此时才上传到目标实例）
    expect(uploadFilenames).toHaveLength(1);
    expect(uploadFilenames[0]).toMatch(/^demo_[0-9a-f]{6}\.png$/);
    // 提交的请求体引用实例侧返回的真实文件名
    expect(promptBodies).toHaveLength(1);
    const submitted = JSON.parse(promptBodies[0]) as { prompt: Record<string, { inputs: { image: string } }> };
    expect(submitted.prompt['1'].inputs.image).toBe('instance-side_zzz999.png');
    // 任务记录保留暂存名形态的请求体，并把实例侧真实文件名追加进清理名单
    const after = taskService.getById(task.id)!;
    expect(after.status).toBe('pending');
    expect(after.actualProviderId).toBe(instance.id);
    expect(JSON.parse(after.comfyuiRequestBody ?? '{}').prompt['1'].inputs.image).toBe('demo_bbb222.png');
    expect(JSON.parse(after.uploadedFiles)).toEqual(['demo_bbb222.png', 'instance-side_zzz999.png']);
  });

  it('keeps the task queued with its staged media intact when the instance is unreachable', async () => {
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/system_stats')) return new Response('{}', { status: 503 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);

    const instance = providerService.create({ name: 'dead', type: 'comfyui', config: { baseUrl: 'http://dead:8188' } });
    const task = await createQueuedTaskWithMedia(instance.id, 'demo_ccc333.png', 'demo.png', true);

    await dispatcher.drainProvider(instance.id);

    // 实例不可达：任务保持排队且暂存文件仍可用（改选实例后可继续投递）
    expect(taskService.getById(task.id)?.status).toBe('queued');
    await expect(fs.promises.access(path.join(tempDataDir, 'task-staging', task.id, 'demo_ccc333.png')))
      .resolves.toBeUndefined();
  });
});

describe('isPermanentSubmitError', () => {
  it('treats 4xx responses as permanent and everything else as transient', () => {
    expect(isPermanentSubmitError('Executor returned status 400: bad prompt')).toBe(true);
    expect(isPermanentSubmitError('Executor returned status 404: not found')).toBe(true);
    expect(isPermanentSubmitError('Executor returned status 500: oops')).toBe(false);
    expect(isPermanentSubmitError('fetch failed')).toBe(false);
    expect(isPermanentSubmitError(null)).toBe(false);
  });
});

describe('分组任务并发统计口径', () => {
  it('counts slots by actual_provider_id so group tasks occupy member slots', () => {
    const { db } = buildTestDb();
    const providerService = new ProviderService(db);
    const taskService = new TaskService(db);
    const member = providerService.create({ name: 'm', type: 'comfyui', config: { baseUrl: 'http://m:8188' } });
    const group = providerService.create({ name: 'G', type: 'group', config: { dispatchPolicy: 'priority', members: [{ providerId: member.id, weight: 1 }] } });

    // 分组任务：providerId 为分组，actualProviderId 为成员
    const task = taskService.create({
      workflowId: 'wf', workflowName: 'wf', aliasValues: '{}',
      comfyuiUrl: 'u', comfyuiRequestBody: '{}', comfyuiResponse: null, promptId: 'pid',
      providerId: group.id, providerName: 'G',
    });
    taskService.updateActualProvider(task.id, {
      actualProviderId: member.id,
      actualProviderName: 'm',
      promptId: 'pid',
    });

    // 按成员实例统计能看到该任务；按分组统计看不到（分组不执行任务）
    expect(taskService.countPendingByActualProvider(member.id)).toBe(1);
    expect(taskService.countPendingByActualProvider(group.id)).toBe(0);
    expect(taskService.listPendingByActualProvider(member.id).map((t) => t.id)).toEqual([task.id]);
    expect(providerService.countPending(member.id)).toBe(1);
  });

  it('listQueuedByTarget routes tasks by locked instance or group ownership', () => {
    const { db } = buildTestDb();
    const providerService = new ProviderService(db);
    const taskService = new TaskService(db);
    const g1 = providerService.create({ name: 'G1', type: 'group', config: { dispatchPolicy: 'priority', members: [] } });
    const other = providerService.create({ name: 'other', type: 'comfyui', config: { baseUrl: 'http://o:8188' } });

    /**
     * 插入一条排队任务。
     * @param providerId 归属实例 ID
     * @param lockActual 是否锁定实际执行实例（具体实例目标为 true，分组目标为 false）
     * @returns 任务行
     */
    function queued(providerId: string, lockActual: boolean) {
      const t = taskService.create({
        workflowId: 'wf', workflowName: 'wf', aliasValues: '{}',
        comfyuiUrl: 'u', comfyuiRequestBody: '{}', comfyuiResponse: null, promptId: null,
        providerId, providerName: providerId,
      });
      taskService.updateStatus(t.id, { status: 'queued' });
      if (lockActual) {
        taskService.setActualProvider(t.id, { actualProviderId: providerId, actualProviderName: providerId, promptId: '' });
      }
      return taskService.getById(t.id)!;
    }

    // 分组任务（actual 为空，按 providerId 归属）+ 实例任务（actual 锁定）
    const grouped = queued(g1.id, false);
    const locked = queued(other.id, true);

    expect(taskService.listQueuedByTarget(g1.id).map((t) => t.id)).toEqual([grouped.id]);
    expect(taskService.listQueuedByTarget(other.id).map((t) => t.id)).toEqual([locked.id]);
    // 无排队任务的目标返回空列表
    expect(taskService.listQueuedByTarget('nothing')).toEqual([]);
  });
});

describe('HealthService 健康状态', () => {
  let db: ReturnType<typeof buildTestDb>['db'];
  let providerService: ProviderService;
  let healthService: HealthService;

  beforeEach(() => {
    db = buildTestDb().db;
    providerService = new ProviderService(db);
    healthService = new HealthService(db);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    healthService.stop();
  });

  it('stays healthy after the first failure and enters cooldown at the threshold', () => {
    const id = 'p1';
    healthService.markUnhealthy(id, 'boom');
    // 失败次数未达阈值：容忍偶发网络抖动
    expect(healthService.isHealthy(id)).toBe(true);

    healthService.markUnhealthy(id, 'boom');
    expect(healthService.isHealthy(id)).toBe(false);
    const snapshot = healthService.getSnapshot(id);
    expect(snapshot.inCooldown).toBe(true);
    expect(snapshot.lastError).toBe('boom');
    expect(snapshot.cooldownUntil).not.toBeNull();
  });

  it('markFailedNow enters cooldown immediately (pre-submit probe failure)', () => {
    const id = 'p2';
    healthService.markFailedNow(id, 'probe failed');
    expect(healthService.isHealthy(id)).toBe(false);
    expect(healthService.getSnapshot(id).inCooldown).toBe(true);
  });

  it('markHealthy clears failures and cooldown', () => {
    const id = 'p3';
    healthService.markFailedNow(id, 'x');
    expect(healthService.isHealthy(id)).toBe(false);

    healthService.markHealthy(id);
    expect(healthService.isHealthy(id)).toBe(true);
    expect(healthService.getSnapshot(id).inCooldown).toBe(false);
  });

  it('treats an instance that was never probed as healthy', () => {
    expect(healthService.isHealthy('never-probed')).toBe(true);
    expect(healthService.getSnapshot('never-probed')).toMatchObject({ healthy: true, lastCheckedAt: null });
  });

  it('recovers automatically once the cooldown window has passed', () => {
    const id = 'p4';
    healthService.markFailedNow(id, 'x');
    expect(healthService.isHealthy(id)).toBe(false);
    // 把冷却截止时间拨到过去，模拟冷却结束
    const snapshot = healthService.getSnapshot(id);
    expect(snapshot.cooldownUntil).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(snapshot.cooldownUntil as string) + 1);
    expect(healthService.isHealthy(id)).toBe(true);
    vi.restoreAllMocks();
  });

  it('sweep probes only members of enabled groups and drops stale records', async () => {
    const member = providerService.create({ name: 'm', type: 'comfyui', config: { baseUrl: 'http://m:8188' } });
    const orphan = providerService.create({ name: 'orphan', type: 'comfyui', config: { baseUrl: 'http://orphan:8188' } });
    providerService.create({ name: 'G', type: 'group', config: { dispatchPolicy: 'priority', members: [{ providerId: member.id, weight: 1 }] } });

    const probes: string[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      probes.push(String(input));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);

    // 先给 orphan 造一条历史健康记录（随后应从表中清除）
    healthService.markHealthy(orphan.id);
    await healthService.sweep();

    expect(probes.some((u) => u.includes('m:8188'))).toBe(true);
    // 非分组成员的实例不参与巡检
    expect(probes.some((u) => u.includes('orphan:8188'))).toBe(false);
    expect(healthService.getSnapshot(member.id).lastCheckedAt).not.toBeNull();
  });

  it('sweep excludes disabled members from probing', async () => {
    const disabled = providerService.create({ name: 'disabled', type: 'comfyui', config: { baseUrl: 'http://disabled:8188' } });
    providerService.create({ name: 'G', type: 'group', config: { dispatchPolicy: 'priority', members: [{ providerId: disabled.id, weight: 1 }] } });
    providerService.update(disabled.id, { enabled: false });

    const probes: string[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      probes.push(String(input));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);

    await healthService.sweep();
    expect(probes).toHaveLength(0);
  });

  it('exposes the configured cooldown duration to failure threshold behavior', () => {
    // 阈值配置为 2：1 次失败仍可用，2 次进入冷却
    expect(healthCheckConfig.failureThreshold).toBe(2);
  });
});
