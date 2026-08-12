import { describe, it, expect, vi } from 'vitest';
import { cleanupTaskUploads, parseUploadedFiles } from './cleanup.service';
import type { ExecutionProvider } from './providers/types';

/**
 * 构造实现了 cleanupUploadedFiles 的 provider 桩。
 * @returns provider 桩与清理调用记录
 */
function makeProviderWithCleanup(): {
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
    const { provider, cleanupCalls } = makeProviderWithCleanup();
    cleanupTaskUploads(provider, '["a.png","b.mp4"]');
    expect(cleanupCalls).toEqual([['a.png', 'b.mp4']]);
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
      submitPrompt: async () => ({ success: true, comfyuiResponse: null, promptId: 'pid', errorMessage: null }),
      uploadMedia: async () => 'a.png',
      fetchHistory: async () => ({}),
      interrupt: async () => true,
      isPromptRunning: async () => false,
      buildOutputViewUrl: () => 'https://rh.example.com/view',
    };
    expect(() => cleanupTaskUploads(provider, '["a.png"]')).not.toThrow();
  });

  it('skips when there are no uploaded files', () => {
    const { provider, cleanupCalls } = makeProviderWithCleanup();
    cleanupTaskUploads(provider, null);
    cleanupTaskUploads(provider, '[]');
    expect(cleanupCalls).toHaveLength(0);
  });

  it('swallows provider cleanup errors (logs only, does not throw)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { provider } = makeProviderWithCleanup();
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
