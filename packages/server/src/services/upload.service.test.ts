import { describe, it, expect } from 'vitest';
import { buildUniqueUploadFilename } from './upload.service';

describe('upload.service', () => {
  it('buildUniqueUploadFilename keeps the original extension', () => {
    const name = buildUniqueUploadFilename('photo.png');
    expect(name).toMatch(/\.png$/i);
  });

  it('buildUniqueUploadFilename keeps the original base name for traceability', () => {
    const name = buildUniqueUploadFilename('photo.png');
    expect(name).toContain('photo');
  });

  it('buildUniqueUploadFilename generates different names for the same input', () => {
    // 同一请求中多个同名文件必须得到不同文件名，避免相互覆盖
    const first = buildUniqueUploadFilename('photo.png');
    const second = buildUniqueUploadFilename('photo.png');
    expect(first).not.toBe(second);
  });

  it('buildUniqueUploadFilename sanitizes unsafe characters', () => {
    // 路径分隔符/控制字符会被清理为下划线，避免路径注入
    const name = buildUniqueUploadFilename('a/b\\c?.png');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('?');
    expect(name).toMatch(/\.png$/i);
  });

  it('buildUniqueUploadFilename falls back to "file" for an empty base name', () => {
    // 空文件名主体 → 回退为 file 前缀
    const name = buildUniqueUploadFilename('');
    expect(name).toMatch(/^file_/);
  });
});
