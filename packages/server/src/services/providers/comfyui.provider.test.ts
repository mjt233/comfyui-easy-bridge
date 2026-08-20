import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComfyUIProvider } from './comfyui.provider';

/**
 * 构造测试用 ComfyUIProvider 实例。
 * @param baseUrl ComfyUI 基础地址
 * @returns 测试实例
 */
function makeProvider(baseUrl = 'http://127.0.0.1:8188'): ComfyUIProvider {
  return new ComfyUIProvider('c1', 'Local', { baseUrl }, 1);
}

/**
 * 构造带本地输入目录配置的 ComfyUIProvider 实例（用于自动清理测试）。
 * @param inputDir 本地输入目录路径
 * @returns 测试实例
 */
function makeProviderWithInputDir(inputDir: string): ComfyUIProvider {
  return new ComfyUIProvider('c1', 'Local', { baseUrl: 'http://127.0.0.1:8188', autoCleanup: true, inputDir }, 1);
}

describe('ComfyUIProvider', () => {
  // 每个用例结束后清理全局 fetch stub，避免用例间相互污染
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns configured base url', () => {
    expect(makeProvider('http://127.0.0.1:8188').getBaseUrl()).toBe('http://127.0.0.1:8188');
  });

  it('uses websocket tracking mode', () => {
    expect(makeProvider().trackingMode).toBe('websocket');
  });

  it('returns a config copy via getConfig', () => {
    const provider = makeProvider('http://127.0.0.1:8188');
    expect(provider.getConfig()).toEqual({ baseUrl: 'http://127.0.0.1:8188' });
    // 返回副本：修改结果不得回写内部配置
    provider.getConfig().baseUrl = 'http://mutated';
    expect(provider.getBaseUrl()).toBe('http://127.0.0.1:8188');
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
  });

  it('throws when upload returns non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const provider = makeProvider('http://127.0.0.1:8188');
    await expect(provider.uploadMedia({ buffer: Buffer.from('x'), originalname: 'a.png', mimetype: 'image/png' }, 'image'))
      .rejects.toThrow('ComfyUI upload failed (500)');
  });
});

describe('ComfyUIProvider.cleanupUploadedFiles', () => {
  // 每个用例结束后清理全局 fetch stub，避免用例间相互污染
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('deletes uploaded files from configured inputDir', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'comfy-cleanup-'));
    try {
      const a = path.join(dir, 'a.png');
      const b = path.join(dir, 'b.mp4');
      writeFileSync(a, 'x');
      writeFileSync(b, 'y');
      const provider = makeProviderWithInputDir(dir);
      await provider.cleanupUploadedFiles(['a.png', 'b.mp4']);
      expect(existsSync(a)).toBe(false);
      expect(existsSync(b)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores missing files (ENOENT)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'comfy-cleanup-'));
    try {
      const provider = makeProviderWithInputDir(dir);
      // 不存在的文件不应抛出异常
      await expect(provider.cleanupUploadedFiles(['ghost.png'])).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when inputDir is empty', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const provider = makeProvider(); // 无 inputDir 配置
      await expect(provider.cleanupUploadedFiles(['a.png'])).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('only deletes basename, blocking path traversal outside inputDir', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'comfy-cleanup-'));
    const dir = path.join(base, 'input');
    // 构造 input 子目录（模拟 ComfyUI 输入目录）与位于其外部的同名文件
    mkdirSync(dir, { recursive: true });
    const outsideFile = path.join(base, 'evil.png');
    writeFileSync(outsideFile, 'outside');
    try {
      const provider = makeProviderWithInputDir(dir);
      // 传目录穿越文件名：basename 后指向 input/evil.png（不存在），外部文件应保留
      await provider.cleanupUploadedFiles(['../evil.png']);
      expect(existsSync(outsideFile)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('deletes files with nested separators only at inputDir root (basename)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'comfy-cleanup-'));
    try {
      // 上传文件总是存于 inputDir 根目录；嵌套路径输入应被归一化为根目录文件名
      const rootFile = path.join(dir, 'sub.png');
      writeFileSync(rootFile, 'x');
      const provider = makeProviderWithInputDir(dir);
      await provider.cleanupUploadedFiles(['sub/sub.png']);
      // 根目录下的 sub.png 被删除（basename 归一化）
      expect(existsSync(rootFile)).toBe(false);
      // 不应创建/删除 input/sub/ 子目录下的文件
      expect(existsSync(path.join(dir, 'sub', 'sub.png'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
