import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyAliases, processMediaParams } from './executor.service';

describe('executor.service', () => {
  const sampleJson = JSON.stringify({
    '29': {
      'inputs': { 'filename_prefix': 'test', 'images': ['30:8', 0] },
      'class_type': 'SaveImage',
      '_meta': { 'title': '保存图像' },
    },
    '30:19': {
      'inputs': { 'value': 'original prompt' },
      'class_type': 'PrimitiveStringMultiline',
      '_meta': { 'title': 'Text String' },
    },
  });

  it('applyAliases replaces primitive values', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null, paramType: 'text', defaultValue: null },
    ];
    const result = applyAliases(sampleJson, params, { img_desc: 'a cute cat' });
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('a cute cat');
  });

  it('applyAliases does not modify node connections (arrays)', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '29', fieldName: 'images', alias: 'img_alias', label: null, paramType: 'text', defaultValue: null },
    ];
    const result = applyAliases(sampleJson, params, { img_alias: 'something' });
    const parsed = JSON.parse(result);
    // images is an array (connection), should NOT be replaced
    expect(Array.isArray(parsed['29'].inputs.images)).toBe(true);
  });

  it('applyAliases skips missing alias value and keeps original', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null, paramType: 'text', defaultValue: null },
    ];
    const result = applyAliases(sampleJson, params, {});
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('original prompt');
  });

  it('applyAliases ignores params for non-existent nodes', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: 'nonexistent', fieldName: 'value', alias: 'x', label: null, paramType: 'text', defaultValue: null },
    ];
    const result = applyAliases(sampleJson, params, { x: 'val' });
    expect(result).toBe(sampleJson);
  });

  it('applyAliases uses defaultValue when alias missing from request', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null, paramType: 'text', defaultValue: 'from-default' },
    ];
    const result = applyAliases(sampleJson, params, {});
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('from-default');
  });

  it('applyAliases prefers request value over defaultValue', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null, paramType: 'text', defaultValue: 'from-default' },
    ];
    const result = applyAliases(sampleJson, params, { img_desc: 'from-request' });
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('from-request');
  });

  it('applyAliases applies defaultValue without alias', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: null, label: null, paramType: 'text', defaultValue: 'only-default' },
    ];
    const result = applyAliases(sampleJson, params, {});
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('only-default');
  });

  it('applyAliases keeps rawJson when defaultValue is null and no request value', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null, paramType: 'text', defaultValue: null },
    ];
    const result = applyAliases(sampleJson, params, {});
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('original prompt');
  });
});

describe('processMediaParams', () => {
  const mockFetch = vi.fn();
  globalThis.fetch = mockFetch;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('uploads file for image params and overrides alias value', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'uploaded.png' }),
    });

    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: 'img', label: null, paramType: 'image', defaultValue: null },
    ];
    const files = {
      img: [{ buffer: Buffer.from('data'), originalname: 'photo.png', mimetype: 'image/png' }],
    };

    const result = await processMediaParams(params, { img: 'old.png' }, files, 'http://localhost:8188');
    expect(result.img).toBe('uploaded.png');
  });

  it('keeps alias value if no file uploaded for media param', async () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: 'img', label: null, paramType: 'image', defaultValue: null },
    ];

    const result = await processMediaParams(params, { img: 'existing.png' }, {}, 'http://localhost:8188');
    expect(result.img).toBe('existing.png');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips text params', async () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'value', alias: 'txt', label: null, paramType: 'text', defaultValue: null },
    ];

    const result = await processMediaParams(params, { txt: 'hello' }, {}, 'http://localhost:8188');
    expect(result.txt).toBe('hello');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps duplicate originalnames to distinct ComfyUI filenames', async () => {
    // 模拟 ComfyUI 原样返回上传时使用的文件名
    mockFetch.mockImplementation(async (_url: string, options: { body: FormData }) => {
      const formData = options.body;
      const file = formData.get('image') as File;
      return {
        ok: true,
        json: async () => ({ name: file.name }),
      };
    });

    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: 'img1', label: null, paramType: 'image', defaultValue: null },
      { id: 2, workflowId: 'test', nodeId: '2', fieldName: 'image', alias: 'img2', label: null, paramType: 'image', defaultValue: null },
    ];
    const files = {
      img1: [{ buffer: Buffer.from('data1'), originalname: 'photo.png', mimetype: 'image/png' }],
      img2: [{ buffer: Buffer.from('data2'), originalname: 'photo.png', mimetype: 'image/png' }],
    };

    const result = await processMediaParams(params, {}, files, 'http://localhost:8188');

    // 两个参数最终引用的文件名必须不同，否则节点会加载到同一份被覆盖的资源
    expect(result.img1).toBeDefined();
    expect(result.img2).toBeDefined();
    expect(result.img1).not.toBe(result.img2);
    expect(result.img1).toMatch(/\.png$/i);
    expect(result.img2).toMatch(/\.png$/i);
  });

  it('skips media params without alias', async () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: null, label: null, paramType: 'image', defaultValue: null },
    ];
    const files = {
      img: [{ buffer: Buffer.from('data'), originalname: 'photo.png', mimetype: 'image/png' }],
    };
    const result = await processMediaParams(params, {}, files, 'http://localhost:8188');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});
