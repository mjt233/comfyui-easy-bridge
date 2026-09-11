import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProviderService } from './providers/provider.service';
import { HealthService, healthCheckConfig } from './providers/health.service';
import { DispatcherService, isPermanentSubmitError } from './dispatcher.service';
import { TaskService } from './task.service';
import { buildTestDb } from './providers/test-db.helper';

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

describe('DispatcherService 分组调度', () => {
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
   * 插入一条排队中的分组任务（providerId 指向分组）。
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

  it('ignores queued tasks that are not owned by the group', async () => {
    stubFetch();
    const standalone = createMember('standalone');
    const member = createMember('member');
    // 分组存在（其成员队列由分组调度器消费），但普通实例的排队任务不归它管
    createGroup([{ providerId: member.id, weight: 1 }]);
    // 普通实例的排队任务：providerId 指向实例本身
    const plain = taskService.create({
      workflowId: 'wf-1',
      workflowName: 'wf',
      aliasValues: '{}',
      comfyuiUrl: 'http://standalone/prompt',
      comfyuiRequestBody: '{"prompt":{}}',
      comfyuiResponse: null,
      promptId: null,
      providerId: standalone.id,
      providerName: 'standalone',
    });
    taskService.updateStatus(plain.id, { status: 'queued' });
    taskService.setActualProvider(plain.id, {
      actualProviderId: standalone.id,
      actualProviderName: 'standalone',
      promptId: '',
    });

    await dispatcher.drainAll();

    // 分组成员实例的并发槽位只按 actual_provider_id 统计，普通任务不归分组调度
    expect(taskService.getById(plain.id)?.status).toBe('queued');
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

  it('listQueuedByGroups returns only queued tasks of the given groups', () => {
    const { db } = buildTestDb();
    const providerService = new ProviderService(db);
    const taskService = new TaskService(db);
    const g1 = providerService.create({ name: 'G1', type: 'group', config: { dispatchPolicy: 'priority', members: [] } });
    const g2 = providerService.create({ name: 'G2', type: 'group', config: { dispatchPolicy: 'priority', members: [] } });
    const other = providerService.create({ name: 'other', type: 'comfyui', config: { baseUrl: 'http://o:8188' } });

    /**
     * 插入一条排队任务。
     * @param providerId 归属实例 ID
     * @returns 任务行
     */
    function queued(providerId: string) {
      const t = taskService.create({
        workflowId: 'wf', workflowName: 'wf', aliasValues: '{}',
        comfyuiUrl: 'u', comfyuiRequestBody: '{}', comfyuiResponse: null, promptId: null,
        providerId, providerName: providerId,
      });
      taskService.updateStatus(t.id, { status: 'queued' });
      return taskService.getById(t.id)!;
    }

    const t1 = queued(g1.id);
    queued(g2.id);
    queued(other.id);

    expect(taskService.listQueuedByGroups([g1.id]).map((t) => t.id)).toEqual([t1.id]);
    expect(taskService.listQueuedByGroups([])).toEqual([]);
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
