import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunningHubProvider } from './runninghub.provider';

/**
 * 构造测试用 RunningHubProvider 实例。
 * @param apiKey API Key
 * @param gpuSize GPU 规格
 * @returns 测试实例
 */
function makeProvider(apiKey = 'sk-test-1234', gpuSize: '24G' | '48G' = '24G'): RunningHubProvider {
  return new RunningHubProvider('p1', 'RH', { apiKey, gpuSize }, 1);
}

describe('RunningHubProvider', () => {
  // 每个用例结束后清理全局 fetch stub，避免用例间相互污染
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives 24G proxy base url', () => {
    expect(makeProvider('abc', '24G').getBaseUrl()).toBe('https://www.runninghub.cn/proxy/abc');
  });

  it('derives 48G proxy-plus base url', () => {
    expect(makeProvider('abc', '48G').getBaseUrl()).toBe('https://www.runninghub.cn/proxy-plus/abc');
  });

  it('getDisplayBaseUrl masks the apiKey', () => {
    // 对外展示地址必须打码 apiKey，且不得包含完整 Key
    const url = makeProvider('sk-test-1234', '24G').getDisplayBaseUrl();
    expect(url).toBe('https://www.runninghub.cn/proxy/sk-t****');
    expect(url).not.toContain('sk-test-1234');
    // 48G 走 proxy-plus 前缀，同样打码
    expect(makeProvider('sk-test-1234', '48G').getDisplayBaseUrl()).toBe('https://www.runninghub.cn/proxy-plus/sk-t****');
  });

  it('uses polling tracking mode', () => {
    expect(makeProvider().trackingMode).toBe('polling');
  });

  it('returns a config copy via getConfig including plaintext apiKey', () => {
    const provider = makeProvider('sk-secret', '48G');
    expect(provider.getConfig()).toEqual({ apiKey: 'sk-secret', gpuSize: '48G' });
    // 返回副本：修改结果不得回写内部配置
    provider.getConfig().apiKey = 'mutated';
    expect(provider.getBaseUrl()).toContain('sk-secret');
  });

  it('uploads via /openapi/v2/media/upload/binary with bearer auth and returns fileName', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 0, message: 'success', data: { fileName: 'openapi/xyz.png', type: 'image', download_url: 'https://cdn/x', size: '1' } }),
      { status: 200 },
    )));
    const provider = makeProvider('sk-abc', '24G');
    const name = await provider.uploadMedia({ buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }, 'image');
    expect(name).toBe('openapi/xyz.png');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.runninghub.cn/openapi/v2/media/upload/binary');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-abc');
  });

  it('throws when upload api returns non-zero code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 401, message: 'bad key', data: null }),
      { status: 200 },
    )));
    const provider = makeProvider('bad', '24G');
    await expect(provider.uploadMedia({ buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }, 'image'))
      .rejects.toThrow('bad key');
  });

  it('throws when upload api returns non-2xx status', async () => {
    // 模拟 HTTP 500：ok=false、status=500，text() 返回错误详情
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));
    const provider = makeProvider('sk-abc', '24G');
    await expect(provider.uploadMedia({ buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }, 'image'))
      .rejects.toThrow('500');
  });

  it('throws when upload response body misses fileName', async () => {
    // 模拟业务成功但缺少 fileName 字段：应抛出 missing fileName 错误
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 0, message: 'success', data: {} }),
      { status: 200 },
    )));
    const provider = makeProvider('sk-abc', '24G');
    await expect(provider.uploadMedia({ buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }, 'image'))
      .rejects.toThrow('fileName');
  });
});

/**
 * RunningHub 结果查询 V2（queryTaskState）单元测试：
 * 覆盖请求构造、状态映射、产出解析与异常响应。
 */
describe('RunningHubProvider.queryTaskState', () => {
  // 每个用例结束后清理全局 fetch stub，避免用例间相互污染
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 打桩全局 fetch，使后端返回指定响应体。
   * @param body 响应体（对象自动 JSON 序列化）
   * @param status HTTP 状态码
   * @returns fetch mock（可断言调用参数）
   */
  function stubQuery(body: unknown, status = 200) {
    const mock = vi.fn(async () => new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status },
    ));
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('posts to /openapi/v2/query with bearer auth and taskId body', async () => {
    const mock = stubQuery({
      taskId: 't-1', status: 'SUCCESS', errorCode: '', errorMessage: '',
      results: [{ url: 'https://cdn.example.com/output/a.png', outputType: 'png' }],
    });
    await makeProvider('sk-abc', '24G').queryTaskState('t-1');

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.runninghub.cn/openapi/v2/query');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-abc');
    expect(JSON.parse(String(init.body))).toEqual({ taskId: 't-1' });
  });

  it('maps SUCCESS results into platform output files', async () => {
    stubQuery({
      taskId: 't-1', status: 'SUCCESS', errorCode: '', errorMessage: '',
      results: [
        { url: 'https://cdn.example.com/output/final_00001.png', outputType: 'png' },
        { url: 'https://cdn.example.com/output/clip.mp4', outputType: 'mp4' },
      ],
    });
    const state = await makeProvider().queryTaskState('t-1');

    expect(state.kind).toBe('completed');
    if (state.kind !== 'completed') return;
    expect(state.files).toEqual([
      { filename: 'final_00001.png', fileType: 'image', url: 'https://cdn.example.com/output/final_00001.png' },
      { filename: 'clip.mp4', fileType: 'video', url: 'https://cdn.example.com/output/clip.mp4' },
    ]);
    // 原始响应体保留，供写入任务 comfyui_response 排查
    expect(state.raw).toMatchObject({ status: 'SUCCESS' });
  });

  it('derives file type from URL when outputType is image/video keyword', async () => {
    stubQuery({
      status: 'SUCCESS',
      results: [
        { url: 'https://cdn.example.com/output/a.jpg', outputType: 'image' },
        { url: 'https://cdn.example.com/output/b.wav', outputType: 'audio' },
      ],
    });
    const state = await makeProvider().queryTaskState('t-1');
    expect(state.kind).toBe('completed');
    if (state.kind !== 'completed') return;
    expect(state.files.map(f => f.fileType)).toEqual(['image', 'audio']);
  });

  it('accepts outputUrl as an alias of url', async () => {
    stubQuery({
      status: 'SUCCESS',
      results: [{ outputUrl: 'https://cdn.example.com/output/alias.png', outputType: 'png' }],
    });
    const state = await makeProvider().queryTaskState('t-1');
    expect(state.kind).toBe('completed');
    if (state.kind !== 'completed') return;
    expect(state.files).toEqual([
      { filename: 'alias.png', fileType: 'image', url: 'https://cdn.example.com/output/alias.png' },
    ]);
  });

  it('treats SUCCESS with empty results as a failure', async () => {
    stubQuery({ status: 'SUCCESS', errorCode: '', errorMessage: '', results: null });
    const state = await makeProvider().queryTaskState('t-1');
    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') return;
    expect(state.errorMessage).toContain('未返回输出文件');
  });

  it('returns failed with errorCode for FAILED status', async () => {
    stubQuery({
      status: 'FAILED', errorCode: '1000', errorMessage: 'unknown error',
      results: null, failedReason: { exception_message: 'node blew up', node_name: 'KSampler' },
    });
    const state = await makeProvider().queryTaskState('t-1');
    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') return;
    // 优先展示 failedReason 的异常信息，并带上错误码
    expect(state.errorMessage).toBe('node blew up (errorCode=1000)');
  });

  it('returns failed for CANCEL status', async () => {
    stubQuery({ status: 'CANCEL', errorCode: '', errorMessage: 'cancelled', results: null });
    const state = await makeProvider().queryTaskState('t-1');
    expect(state.kind).toBe('failed');
  });

  it('returns running for non-terminal statuses', async () => {
    for (const status of ['CREATE', 'QUEUED', 'RUNNING']) {
      stubQuery({ status, errorCode: '', errorMessage: '', results: null });
      await expect(makeProvider().queryTaskState('t-1')).resolves.toEqual({ kind: 'running' });
    }
  });

  it('treats an unrecognized status carrying errorCode as a failure', async () => {
    // 实测：API Key 失效时 status 为空串、errorCode=806；按失败处理避免任务永久 pending
    stubQuery({ taskId: 't-1', status: '', errorCode: '806', errorMessage: 'APIKEY_USER_NOT_FOUND', results: null });
    const state = await makeProvider().queryTaskState('t-1');
    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') return;
    expect(state.errorMessage).toBe('APIKEY_USER_NOT_FOUND (errorCode=806)');
  });

  it('treats an unrecognized status without errorCode as still running', async () => {
    stubQuery({ status: 'WEIRD_STATE', errorCode: '', errorMessage: '', results: null });
    await expect(makeProvider().queryTaskState('t-1')).resolves.toEqual({ kind: 'running' });
  });

  it('throws on non-2xx response', async () => {
    stubQuery('boom', 500);
    await expect(makeProvider().queryTaskState('t-1')).rejects.toThrow('500');
  });

  it('throws when the response body misses status', async () => {
    // 响应结构被破坏：抛错交由连续失败计数兜底，而不是无限轮询
    stubQuery({ code: 0, msg: 'success', data: {} });
    await expect(makeProvider().queryTaskState('t-1')).rejects.toThrow('missing status');
  });
});
