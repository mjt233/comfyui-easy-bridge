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
