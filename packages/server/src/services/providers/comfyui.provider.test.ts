import { describe, it, expect, vi } from 'vitest';
import { ComfyUIProvider } from './comfyui.provider';

/**
 * 构造测试用 ComfyUIProvider 实例。
 * @param baseUrl ComfyUI 基础地址
 * @returns 测试实例
 */
function makeProvider(baseUrl = 'http://127.0.0.1:8188'): ComfyUIProvider {
  return new ComfyUIProvider('c1', 'Local', { baseUrl }, 1);
}

describe('ComfyUIProvider', () => {
  it('returns configured base url', () => {
    expect(makeProvider('http://127.0.0.1:8188').getBaseUrl()).toBe('http://127.0.0.1:8188');
  });

  it('uses websocket tracking mode', () => {
    expect(makeProvider().trackingMode).toBe('websocket');
  });

  it('uploads to /upload/image and returns stored name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ name: 'unique_123456.png', subfolder: '', type: 'input' }),
      { status: 200 },
    )));
    const provider = makeProvider('http://127.0.0.1:8188');
    const name = await provider.uploadMedia({ buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }, 'image');
    expect(name).toBe('unique_123456.png');
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8188/upload/image');
    expect(init.method).toBe('POST');
    vi.unstubAllGlobals();
  });

  it('throws when upload returns non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const provider = makeProvider('http://127.0.0.1:8188');
    await expect(provider.uploadMedia({ buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }, 'image'))
      .rejects.toThrow('ComfyUI upload failed (500)');
    vi.unstubAllGlobals();
  });
});
