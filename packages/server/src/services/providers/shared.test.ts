import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  submitPromptRequest,
  isPromptRunningRequest,
  interruptRequest,
  fetchHistoryRequest,
  buildViewUrl,
} from './shared';
import { COMFYUI_CLIENT_ID } from './types';

describe('shared provider http', () => {
  // 每个用例结束后统一清理全局 fetch stub，避免相互污染
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submitPromptRequest injects client_id and returns prompt_id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ prompt_id: 'p1' }), { status: 200 })));
    const result = await submitPromptRequest('http://comfy:8188', JSON.stringify({ prompt: {} }));
    expect(result.success).toBe(true);
    expect(result.promptId).toBe('p1');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://comfy:8188/prompt');
    const body = JSON.parse(String(init.body)) as { client_id: string };
    expect(typeof body.client_id).toBe('string');
  });

  it('submitPromptRequest returns error result on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await submitPromptRequest('http://comfy:8188', '{}');
    expect(result.success).toBe(false);
    expect(result.promptId).toBeNull();
    expect(result.errorMessage).toContain('500');
  });

  it('isPromptRunningRequest checks queue_running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ queue_running: [['p1', {}, {}], ['p2', {}, {}]] }), { status: 200 })));
    expect(await isPromptRunningRequest('http://comfy:8188', 'p1')).toBe(true);
    expect(await isPromptRunningRequest('http://comfy:8188', 'p9')).toBe(false);
  });

  it('interruptRequest confirms stop when queue no longer reports running', async () => {
    // 按 URL 分发：/interrupt 成功，/queue 报告目标 prompt 已不在执行队列
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/interrupt')) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/queue')) {
        return new Response(JSON.stringify({ queue_running: [] }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const stopped = await interruptRequest('http://comfy:8188', 'p1', { pollIntervalMs: 1, maxAttempts: 3 });
    expect(stopped).toBe(true);
    // 首次中断成功后第一次轮询即确认停止：只应有 1 次 /interrupt 与 1 次 /queue
    const interruptCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/interrupt'));
    const queueCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/queue'));
    expect(interruptCalls).toHaveLength(1);
    expect(queueCalls).toHaveLength(1);
  });

  it('interruptRequest returns false when prompt keeps running until timeout', async () => {
    // /interrupt 成功，但 /queue 始终报告仍在运行，轮询耗尽 maxAttempts
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/interrupt')) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/queue')) {
        return new Response(JSON.stringify({ queue_running: [['p1', {}, {}]] }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const stopped = await interruptRequest('http://comfy:8188', 'p1', { pollIntervalMs: 1, maxAttempts: 3 });
    expect(stopped).toBe(false);
  });

  it('interruptRequest without promptId sends one interrupt and never polls queue', async () => {
    // 未提供 promptId：只发一次中断请求，不进入轮询，/queue 不应被调用
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/interrupt')) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const stopped = await interruptRequest('http://comfy:8188', undefined, { pollIntervalMs: 1, maxAttempts: 3 });
    expect(stopped).toBe(true);
    const queueCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/queue'));
    expect(queueCalls).toHaveLength(0);
  });

  it('interruptRequest returns false when the first interrupt request fails', async () => {
    // 首次 /interrupt 返回非 2xx：直接返回失败，且不进入轮询
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/interrupt')) {
        return new Response('boom', { status: 500 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const stopped = await interruptRequest('http://comfy:8188', 'p1', { pollIntervalMs: 1, maxAttempts: 3 });
    expect(stopped).toBe(false);
    const queueCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/queue'));
    expect(queueCalls).toHaveLength(0);
  });

  it('interruptRequest re-sends interrupt while queue keeps reporting running', async () => {
    let queueCount = 0;
    // 前两次 /queue 查询报告仍在运行，第三次起已停止
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/interrupt')) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/queue')) {
        queueCount += 1;
        if (queueCount <= 2) {
          return new Response(JSON.stringify({ queue_running: [['p1', {}, {}]] }), { status: 200 });
        }
        return new Response(JSON.stringify({ queue_running: [] }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const stopped = await interruptRequest('http://comfy:8188', 'p1', { pollIntervalMs: 1, maxAttempts: 5 });
    expect(stopped).toBe(true);
    // 初始 1 次 + 轮询期间重发 ≥ 2 次，共至少 3 次 /interrupt
    const interruptCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/interrupt'));
    expect(interruptCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('fetchHistoryRequest returns parsed history on 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outputs: {} }), { status: 200 })));
    const history = await fetchHistoryRequest('http://comfy:8188', 'p1');
    expect(history).toEqual({ outputs: {} });
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('http://comfy:8188/history/p1');
  });

  it('fetchHistoryRequest throws on non-2xx response', async () => {
    // 返回极简响应对象（仅含 ok/status），验证函数按契约抛错
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 } as unknown as Response)));
    await expect(fetchHistoryRequest('http://comfy:8188', 'p1')).rejects.toThrow('404');
  });

  it('buildViewUrl encodes special characters in query params', () => {
    const url = buildViewUrl('http://x', { filename: 'a b&c.png', subfolder: 'sub/fold', type: 'output' });
    // URLSearchParams.toString()：空格 → +，& → %26，/ → %2F
    expect(url).toBe('http://x/view?filename=a+b%26c.png&subfolder=sub%2Ffold&type=output');
  });

  it('isPromptRunningRequest returns true on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    expect(await isPromptRunningRequest('http://comfy:8188', 'p1')).toBe(true);
  });

  it('isPromptRunningRequest returns true on malformed body', async () => {
    // queue_running 不是数组，无法判断执行状态 → 保守返回 true
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ queue_running: 'not-array' }), { status: 200 })));
    expect(await isPromptRunningRequest('http://comfy:8188', 'p1')).toBe(true);
  });

  it('isPromptRunningRequest returns true when fetch throws', async () => {
    // 网络异常无法确认 → 保守返回 true
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await isPromptRunningRequest('http://comfy:8188', 'p1')).toBe(true);
  });

  it('submitPromptRequest preserves an existing client_id in the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ prompt_id: 'p1' }), { status: 200 })));
    // 请求体已携带非空 client_id，应原样保留而不是被模块默认值覆盖
    const body = JSON.stringify({ prompt: {}, client_id: 'existing-id' });
    const result = await submitPromptRequest('http://comfy:8188', body);
    expect(result.success).toBe(true);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://comfy:8188/prompt');
    const sentBody = JSON.parse(String(init.body)) as { client_id: string };
    expect(sentBody.client_id).toBe('existing-id');
    expect(sentBody.client_id).not.toBe(COMFYUI_CLIENT_ID);
  });
});
