import { describe, it, expect, vi } from 'vitest';
import { cleanupTaskUploads, parseUploadedFiles } from './cleanup.service';
import type { ExecutionProvider } from './providers/types';

/**
 * 桩工厂的默认参数哨兵：区分「未传参 = 开关开启」与「显式传 undefined = 未实现能力查询」。
 * 直接用 undefined 作默认值会被默认参数吞掉，无法表达后一种情况。
 */
const KEEP_DEFAULT_AUTO_CLEANUP = Symbol('defaultAutoCleanup');

/**
 * 构造实现了 cleanupUploadedFiles 的 provider 桩。
 * @param autoCleanup 桩的自动清理开关值；传 null 表示未实现 getAutoCleanup 能力查询
 * @returns provider 桩与清理调用记录
 */
function makeProviderWithCleanup(
  autoCleanup: boolean | null | typeof KEEP_DEFAULT_AUTO_CLEANUP = KEEP_DEFAULT_AUTO_CLEANUP,
): {
  provider: ExecutionProvider;
  cleanupCalls: string[][];
} {
  const cleanupCalls: string[][] = [];
  const provider: ExecutionProvider = {
    id: 'p1',
    name: 'stub',
    type: 'comfyui',
    concurrency: 1,
    trackingMode: 'polling',
    getBaseUrl: () => 'http://x:8188',
    getDisplayBaseUrl: () => 'http://x:8188',
    getConfig: () => ({ baseUrl: 'http://x:8188' }),
    testConnection: async () => ({ ok: true, message: 'ok' }),
    submitPrompt: async () => ({ success: true, comfyuiResponse: null, promptId: 'pid', errorMessage: null }),
    uploadMedia: async () => 'a.png',
    fetchHistory: async () => ({}),
    interrupt: async () => true,
    isPromptRunning: async () => false,
    buildOutputViewUrl: () => 'http://x:8188/view',
    cleanupUploadedFiles: async (filenames: string[]) => {
      cleanupCalls.push(filenames);
    },
  };
  // 未实现能力查询的桩（传 null）：不挂载 getAutoCleanup
  if (autoCleanup !== null) {
    const enabled = autoCleanup === KEEP_DEFAULT_AUTO_CLEANUP ? true : autoCleanup;
    provider.getAutoCleanup = () => enabled;
  }
  return { provider, cleanupCalls };
}

describe('parseUploadedFiles', () => {
  it('parses valid JSON array of strings', () => {
    expect(parseUploadedFiles('["a.png","b.mp4"]')).toEqual(['a.png', 'b.mp4']);
  });

  it('returns empty for null/undefined/empty string', () => {
    expect(parseUploadedFiles(null)).toEqual([]);
    expect(parseUploadedFiles(undefined)).toEqual([]);
    expect(parseUploadedFiles('')).toEqual([]);
  });

  it('filters out non-string entries', () => {
    expect(parseUploadedFiles('["a.png",42,null]')).toEqual(['a.png']);
  });

  it('returns empty for invalid JSON or non-array', () => {
    expect(parseUploadedFiles('{not-json')).toEqual([]);
    expect(parseUploadedFiles('{"a":1}')).toEqual([]);
  });
});

describe('cleanupTaskUploads', () => {
  it('calls provider cleanup with parsed filenames', () => {
    const { provider, cleanupCalls } = makeProviderWithCleanup(true);
    cleanupTaskUploads(provider, '["a.png","b.mp4"]', 'terminal');
    expect(cleanupCalls).toEqual([['a.png', 'b.mp4']]);
  });

  it('skips when provider autoCleanup is disabled', () => {
    // 回归锁定「开关不生效」缺陷：关闭时任何路径都不应触发删除
    const { provider, cleanupCalls } = makeProviderWithCleanup(false);
    cleanupTaskUploads(provider, '["a.png"]', 'terminal');
    expect(cleanupCalls).toHaveLength(0);
  });

  it('treats providers without getAutoCleanup as disabled', () => {
    // 未实现能力查询的 provider：执行路径视为关闭
    const { provider, cleanupCalls } = makeProviderWithCleanup(null);
    cleanupTaskUploads(provider, '["a.png"]', 'terminal');
    expect(cleanupCalls).toHaveLength(0);
  });

  it('cleans preview uploads regardless of autoCleanup', () => {
    // 预览产物必然无人引用：开关关闭时也需清理
    const { provider, cleanupCalls } = makeProviderWithCleanup(false);
    cleanupTaskUploads(provider, '["a.png"]', 'preview');
    expect(cleanupCalls).toEqual([['a.png']]);
  });

  it('skips when provider does not implement cleanupUploadedFiles', () => {
    // 未实现清理能力的 provider（如 RunningHub）：直接跳过
    const provider: ExecutionProvider = {
      id: 'p2',
      name: 'rh',
      type: 'runninghub',
      concurrency: 1,
      trackingMode: 'polling',
      getBaseUrl: () => 'https://rh.example.com',
      getDisplayBaseUrl: () => 'https://rh.example.com',
      getConfig: () => ({ apiKey: 'k', gpuSize: '24G' as const }),
      testConnection: async () => ({ ok: true, message: 'ok' }),
      submitPrompt: async () => ({ success: true, comfyuiResponse: null, promptId: 'pid', errorMessage: null }),
      uploadMedia: async () => 'a.png',
      fetchHistory: async () => ({}),
      interrupt: async () => true,
      isPromptRunning: async () => false,
      buildOutputViewUrl: () => 'https://rh.example.com/view',
      getAutoCleanup: () => true,
    };
    expect(() => cleanupTaskUploads(provider, '["a.png"]', 'preview')).not.toThrow();
  });

  it('skips when there are no uploaded files', () => {
    const { provider, cleanupCalls } = makeProviderWithCleanup(true);
    cleanupTaskUploads(provider, null);
    cleanupTaskUploads(provider, '[]');
    expect(cleanupCalls).toHaveLength(0);
  });

  it('swallows provider cleanup errors (logs only, does not throw)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { provider } = makeProviderWithCleanup(true);
      // 覆盖为失败实现：清理抛错不应影响调用方
      provider.cleanupUploadedFiles = async () => {
        throw new Error('disk full');
      };
      expect(() => cleanupTaskUploads(provider, '["a.png"]')).not.toThrow();
      // fire-and-forget 的 catch 回调在微任务中执行：等待其完成后再断言日志
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
