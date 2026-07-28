import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadFileToComfyUI } from './upload.service';

describe('upload.service', () => {
  const mockFetch = vi.fn();
  globalThis.fetch = mockFetch;

  const mockFile = {
    buffer: Buffer.from('fake-image-data'),
    originalname: 'test.png',
    mimetype: 'image/png',
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('uploads image to ComfyUI and returns filename', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'test.png' }),
    });
    const result = await uploadFileToComfyUI(mockFile, 'image', 'http://localhost:8188');
    expect(result).toBe('test.png');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8188/upload/image',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uploads video to ComfyUI', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'video.mp4' }),
    });
    const result = await uploadFileToComfyUI(
      { buffer: Buffer.from('fake-video'), originalname: 'video.mp4', mimetype: 'video/mp4' },
      'video',
      'http://localhost:8188',
    );
    expect(result).toBe('video.mp4');
    // ComfyUI 统一走 /upload/image，与 mediaType 无关
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8188/upload/image',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws on upload failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Invalid file',
    });
    await expect(
      uploadFileToComfyUI(mockFile, 'image', 'http://localhost:8188'),
    ).rejects.toThrow('ComfyUI upload failed (400): Invalid file');
  });

  it('uploads with a unique filename derived from the original name', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'unique.png' }),
    });

    await uploadFileToComfyUI(mockFile, 'image', 'http://localhost:8188');

    const formData = mockFetch.mock.calls[0][1].body as FormData;
    const uploaded = formData.get('image') as File;
    // 不能直接使用原始文件名，否则同名文件会互相覆盖
    expect(uploaded.name).not.toBe('test.png');
    // 保留扩展名，便于 ComfyUI 识别类型
    expect(uploaded.name).toMatch(/\.png$/i);
    // 仍包含原始文件名主体，便于排查
    expect(uploaded.name).toContain('test');
  });

  it('generates different filenames for two uploads with the same originalname', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'ignored.png' }),
    });

    await uploadFileToComfyUI(mockFile, 'image', 'http://localhost:8188');
    await uploadFileToComfyUI(mockFile, 'image', 'http://localhost:8188');

    const first = (mockFetch.mock.calls[0][1].body as FormData).get('image') as File;
    const second = (mockFetch.mock.calls[1][1].body as FormData).get('image') as File;
    expect(first.name).not.toBe(second.name);
  });
});
