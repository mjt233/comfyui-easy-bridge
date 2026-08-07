import { describe, it, expect, vi } from 'vitest';
import { submitPromptRequest, isPromptRunningRequest } from './shared';

describe('shared provider http', () => {
  it('submitPromptRequest injects client_id and returns prompt_id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ prompt_id: 'p1' }), { status: 200 })));
    const result = await submitPromptRequest('http://comfy:8188', JSON.stringify({ prompt: {} }));
    expect(result.success).toBe(true);
    expect(result.promptId).toBe('p1');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://comfy:8188/prompt');
    const body = JSON.parse(String(init.body)) as { client_id: string };
    expect(typeof body.client_id).toBe('string');
    vi.unstubAllGlobals();
  });

  it('submitPromptRequest returns error result on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await submitPromptRequest('http://comfy:8188', '{}');
    expect(result.success).toBe(false);
    expect(result.promptId).toBeNull();
    expect(result.errorMessage).toContain('500');
    vi.unstubAllGlobals();
  });

  it('isPromptRunningRequest checks queue_running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ queue_running: [['p1', {}, {}], ['p2', {}, {}]] }), { status: 200 })));
    expect(await isPromptRunningRequest('http://comfy:8188', 'p1')).toBe(true);
    expect(await isPromptRunningRequest('http://comfy:8188', 'p9')).toBe(false);
    vi.unstubAllGlobals();
  });
});
