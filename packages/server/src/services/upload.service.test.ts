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
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8188/upload/video',
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
});
