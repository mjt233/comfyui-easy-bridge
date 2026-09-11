import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schema from '../../models/schema';
import { ProviderService } from './provider.service';
import { GroupProvider } from './group.provider';
import { buildTestDb } from './test-db.helper';

describe('ProviderService 分组（group）支持', () => {
  let db: ReturnType<typeof buildTestDb>['db'];
  let service: ProviderService;

  beforeEach(() => {
    db = buildTestDb().db;
    service = new ProviderService(db);
  });

  // 每个用例结束后清理全局 fetch stub，避免用例间相互污染
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 建一个 comfyui 成员实例。
   * @param name 展示名
   * @param concurrency 并发上限
   * @returns 实例行
   */
  function createMember(name: string, concurrency = 1) {
    return service.create({
      name,
      type: 'comfyui',
      config: { baseUrl: `http://${name}:8188` },
      concurrency,
    });
  }

  /**
   * 插入一条工作流行（用于解析逻辑测试）。
   * @param id 工作流 ID
   * @param providerId 指定的提供商实例 ID（null 表示未指定）
   */
  function insertWorkflow(id: string, providerId: string | null) {
    const now = new Date().toISOString();
    db.insert(schema.workflows).values({
      id,
      name: id,
      rawJson: '{}',
      providerId,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  it('validateInput accepts group config with dispatch policy and members', () => {
    const a = createMember('a');
    const result = service.validateInput({
      name: ' G1 ',
      type: 'group',
      config: { dispatchPolicy: 'random', members: [{ providerId: a.id, weight: 5 }] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 名称 trim；分组自身并发固定为 1（分组不执行任务）
    expect(result.value.name).toBe('G1');
    expect(result.value.concurrency).toBe(1);
    expect(result.value.config).toEqual({
      dispatchPolicy: 'random',
      members: [{ providerId: a.id, weight: 5 }],
    });
  });

  it('validateInput defaults dispatch policy to priority and members to empty array', () => {
    const result = service.validateInput({ name: 'G', type: 'group', config: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toEqual({ dispatchPolicy: 'priority', members: [] });
  });

  it('validateInput rejects invalid dispatch policy and non-array members', () => {
    expect(service.validateInput({ name: 'G', type: 'group', config: { dispatchPolicy: 'weighted' } }).ok).toBe(false);
    expect(service.validateInput({ name: 'G', type: 'group', config: { members: 'x' } }).ok).toBe(false);
  });

  it('validateInput normalizes member weights: missing/zero/negative/NaN fall back to 1', () => {
    const a = createMember('a');
    const b = createMember('b');
    const c = createMember('c');
    const d = createMember('d');
    const result = service.validateInput({
      name: 'G',
      type: 'group',
      config: {
        members: [
          { providerId: a.id },
          { providerId: b.id, weight: 0 },
          { providerId: c.id, weight: -3 },
          { providerId: d.id, weight: 'abc' },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const members = (result.value.config as { members: Array<{ weight: number }> }).members;
    expect(members.map((m) => m.weight)).toEqual([1, 1, 1, 1]);
  });

  it('validateInput keeps positive decimal weights and drops duplicate member ids', () => {
    const a = createMember('a');
    const result = service.validateInput({
      name: 'G',
      type: 'group',
      config: { members: [{ providerId: a.id, weight: 2.5 }, { providerId: a.id, weight: 9 }] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.config as { members: unknown[] }).members).toEqual([{ providerId: a.id, weight: 2.5 }]);
  });

  it('resolveGroupMembers resolves enabled members and skips unknown / disabled / group members', () => {
    const a = createMember('a', 3);
    const disabled = createMember('disabled');
    service.update(disabled.id, { enabled: false });
    const nestedGroup = service.create({
      name: 'nested',
      type: 'group',
      config: { dispatchPolicy: 'priority', members: [{ providerId: a.id, weight: 1 }] },
    });
    const group = service.create({
      name: 'G',
      type: 'group',
      config: {
        dispatchPolicy: 'priority',
        members: [
          { providerId: a.id, weight: 4 },
          { providerId: disabled.id, weight: 1 },
          { providerId: nestedGroup.id, weight: 1 },
          { providerId: 'missing-id', weight: 1 },
        ],
      },
    });

    const members = service.resolveGroupMembers(group.id);
    expect(members).not.toBeNull();
    // 仅保留启用中的 comfyui 成员；停用/分组/不存在的一律跳过
    expect(members).toHaveLength(1);
    expect(members?.[0].providerId).toBe(a.id);
    expect(members?.[0].weight).toBe(4);
    expect(members?.[0].provider.concurrency).toBe(3);
  });

  it('instantiate returns GroupProvider exposing policy and members', () => {
    const a = createMember('a');
    const group = service.create({
      name: 'G',
      type: 'group',
      config: { dispatchPolicy: 'random', members: [{ providerId: a.id, weight: 2 }] },
    });
    const provider = service.instantiate(group);
    expect(provider).toBeInstanceOf(GroupProvider);
    const typed = provider as GroupProvider;
    expect(typed.getDispatchPolicy()).toBe('random');
    expect(typed.getBaseUrl()).toBe('');
    expect(typed.listMembers().map((m) => m.providerId)).toEqual([a.id]);
  });

  it('group cannot be used as a member of another group (no nesting)', () => {
    const inner = service.create({ name: 'inner', type: 'group', config: { dispatchPolicy: 'priority', members: [] } });
    const outer = service.create({
      name: 'outer',
      type: 'group',
      config: { dispatchPolicy: 'priority', members: [{ providerId: inner.id, weight: 1 }] },
    });
    expect(service.resolveGroupMembers(outer.id)).toEqual([]);
  });

  it('listAutoAllocatableMemberIds dedupes members across enabled groups only', () => {
    const a = createMember('a');
    const b = createMember('b');
    const disabledGroup = service.create({
      name: 'disabled-group',
      type: 'group',
      config: { dispatchPolicy: 'priority', members: [{ providerId: b.id, weight: 1 }] },
    });
    service.create({
      name: 'g1',
      type: 'group',
      config: { dispatchPolicy: 'priority', members: [{ providerId: a.id, weight: 1 }, { providerId: b.id, weight: 1 }] },
    });
    // 停用的分组不参与自动分配，其成员不应被巡检
    service.update(disabledGroup.id, { enabled: false });

    const ids = service.listAutoAllocatableMemberIds();
    expect([...ids].sort()).toEqual([a.id, b.id].sort());
  });

  it('toSummary reports member slots and resolves group members', () => {
    const a = createMember('a', 2);
    const group = service.create({
      name: 'G',
      type: 'group',
      config: { dispatchPolicy: 'priority', members: [{ providerId: a.id, weight: 3 }] },
    });
    const summary = service.toSummary(group);
    expect(summary.type).toBe('group');
    expect(summary.dispatchPolicy).toBe('priority');
    expect(summary.memberCount).toBe(1);
    // 无任务占用时空闲槽位等于成员并发上限
    expect(summary.availableSlots).toBe(2);
    expect(summary.members[0]).toMatchObject({ providerId: a.id, weight: 3, availableSlots: 2, healthy: true });
    // 分组自身健康为 null（其健康由成员体现）
    expect(summary.health).toBeNull();
  });

  it('testConnection for group reports first reachable member', async () => {
    const a = createMember('a');
    const group = service.create({
      name: 'G',
      type: 'group',
      config: { dispatchPolicy: 'priority', members: [{ providerId: a.id, weight: 1 }] },
    });
    // 打桩 fetch：/system_stats 返回 2xx 表示成员可达
    vi.stubGlobal('fetch', (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch);

    const provider = service.instantiate(group) as GroupProvider;
    const result = await provider.testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('a');
  });

  it('testConnection for group reports failure when all members are unreachable', async () => {
    const a = createMember('a');
    const group = service.create({
      name: 'G',
      type: 'group',
      config: { dispatchPolicy: 'priority', members: [{ providerId: a.id, weight: 1 }] },
    });
    vi.stubGlobal('fetch', (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch);

    const provider = service.instantiate(group) as GroupProvider;
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('a');
  });

  it('testConnection for group fails when it has no resolvable member', async () => {
    const group = service.create({ name: 'G', type: 'group', config: { dispatchPolicy: 'priority', members: [] } });
    const provider = service.instantiate(group) as GroupProvider;
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
  });

  it('resolveWorkflowProviderStrict rejects explicit disabled provider without falling back', () => {
    const fallback = createMember('fallback');
    service.setDefault(fallback.id);
    const explicit = createMember('explicit');
    insertWorkflow('wf-strict', explicit.id);
    // 工作流显式指定的实例被停用
    service.update(explicit.id, { enabled: false });

    const resolved = service.resolveWorkflowProviderStrict('wf-strict');
    expect(resolved.provider).toBeNull();
    expect(resolved.error).toBe('provider_not_configured');
    expect(resolved.message).toContain('停用');
  });

  it('resolveWorkflowProviderStrict rejects explicit missing provider', () => {
    const fallback = createMember('fallback');
    service.setDefault(fallback.id);
    insertWorkflow('wf-missing', 'no-such-id');

    const resolved = service.resolveWorkflowProviderStrict('wf-missing');
    expect(resolved.provider).toBeNull();
    expect(resolved.error).toBe('provider_not_configured');
  });

  it('resolveWorkflowProviderStrict falls back to default when workflow has no explicit provider', () => {
    const fallback = createMember('fallback');
    service.setDefault(fallback.id);
    insertWorkflow('wf-default', null);

    const resolved = service.resolveWorkflowProviderStrict('wf-default');
    expect(resolved.provider?.id).toBe(fallback.id);
  });

  it('resolveWorkflowProviderStrict reports not configured when default is disabled', () => {
    const fallback = createMember('fallback');
    service.setDefault(fallback.id);
    insertWorkflow('wf-default-off', null);
    service.update(fallback.id, { enabled: false });

    const resolved = service.resolveWorkflowProviderStrict('wf-default-off');
    expect(resolved.provider).toBeNull();
    expect(resolved.error).toBe('provider_not_configured');
  });
});
