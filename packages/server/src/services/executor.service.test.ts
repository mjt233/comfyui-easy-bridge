import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyAliases,
  processMediaParams,
  resolveSubmittedAliasValues,
  submitPrompt,
  COMFYUI_CLIENT_ID,
} from './executor.service';
import type { RuntimeParam } from './param.types';

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

  it('applyAliases coerces string "false" to boolean false', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'flag', label: null, paramType: 'boolean', defaultValue: null },
    ];
    const result = applyAliases(sampleJson, params, { flag: 'false' });
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe(false);
  });

  it('applyAliases coerces string number to number', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'n', label: null, paramType: 'number', defaultValue: null },
    ];
    const result = applyAliases(sampleJson, params, { n: '3.14' });
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe(3.14);
  });

  it('applyAliases keeps invalid number as string', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'n', label: null, paramType: 'number', defaultValue: null },
    ];
    const result = applyAliases(sampleJson, params, { n: 'abc' });
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('abc');
  });

  it('applyAliases coerces defaultValue boolean without alias', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: null, label: null, paramType: 'boolean', defaultValue: 'true' },
    ];
    const result = applyAliases(sampleJson, params, {});
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe(true);
  });

  it('applyAliases keeps native boolean request value', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'flag', label: null, paramType: 'boolean', defaultValue: null },
    ];
    const result = applyAliases(sampleJson, params, { flag: false });
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe(false);
  });

  it('resolveSubmittedAliasValues coerces boolean and number for logs', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'a', alias: 'flag', label: null, paramType: 'boolean', defaultValue: null },
      { id: 2, workflowId: 'test', nodeId: '2', fieldName: 'b', alias: 'n', label: null, paramType: 'number', defaultValue: null },
      { id: 3, workflowId: 'test', nodeId: '3', fieldName: 'c', alias: 'txt', label: null, paramType: 'text', defaultValue: null },
    ];
    const result = resolveSubmittedAliasValues(params, {
      flag: 'false',
      n: '3.14',
      txt: 'hello',
    });
    expect(result).toEqual({
      flag: false,
      n: 3.14,
      txt: 'hello',
    });
  });

  it('resolveSubmittedAliasValues uses coerced defaultValue when request omits alias', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'a', alias: 'flag', label: null, paramType: 'boolean', defaultValue: 'true' },
    ];
    const result = resolveSubmittedAliasValues(params, {});
    expect(result).toEqual({ flag: true });
  });

  it('resolveSubmittedAliasValues skips params without alias', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'a', alias: null, label: null, paramType: 'boolean', defaultValue: 'true' },
    ];
    const result = resolveSubmittedAliasValues(params, {});
    expect(result).toEqual({});
  });
});

describe('processMediaParams', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    // 每个用例重新挂载本 suite 的 fetch mock，避免与其他 describe 互相覆盖
    globalThis.fetch = mockFetch;
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

  it('processMediaParams supports fileIndex for same-alias multiple files', async () => {
    // 模拟 ComfyUI 原样返回上传时使用的文件名
    mockFetch.mockImplementation(async (_url: string, options: { body: FormData }) => {
      const formData = options.body;
      const file = formData.get('image') as File;
      return {
        ok: true,
        json: async () => ({ name: file.name }),
      };
    });

    // 两个参数同 alias 'ref_images'，fileIndex 0/1 分别取第一个/第二个文件
    const params: RuntimeParam[] = [
      { nodeId: 'load1', fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: 0 },
      { nodeId: 'load2', fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: 1 },
    ];
    const files = {
      ref_images: [
        { buffer: Buffer.from('a'), originalname: 'a.png', mimetype: 'image/png' },
        { buffer: Buffer.from('b'), originalname: 'b.png', mimetype: 'image/png' },
      ],
    };

    // 后写者覆盖，最终 ref_images 应为第二个文件（b 开头）的唯一文件名
    const result = await processMediaParams(params, {}, files, 'http://comfy:8188');
    expect(result.ref_images).toBeTruthy();
    expect(result.ref_images).toMatch(/^b_/);
  });
});

/**
 * submitPrompt 应自动注入稳定 client_id，以便 ComfyUI 将 execution_error 推送到本服务 WebSocket。
 */
describe('submitPrompt client_id', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    // 每个用例重新挂载本 suite 的 fetch mock，避免与其他 describe 互相覆盖
    globalThis.fetch = mockFetch;
    mockFetch.mockReset();
  });

  it('injects COMFYUI_CLIENT_ID into prompt request body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ prompt_id: 'p1' }),
    });

    await submitPrompt(JSON.stringify({ prompt: { '1': {} } }), 'http://localhost:8188');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(options.body) as { prompt: unknown; client_id?: string };
    expect(body.client_id).toBe(COMFYUI_CLIENT_ID);
    expect(typeof body.client_id).toBe('string');
    expect(body.client_id!.length).toBeGreaterThan(0);
  });

  it('preserves existing client_id if already present', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ prompt_id: 'p1' }),
    });

    await submitPrompt(
      JSON.stringify({ prompt: { '1': {} }, client_id: 'custom-client' }),
      'http://localhost:8188',
    );

    const [, options] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(options.body) as { client_id?: string };
    expect(body.client_id).toBe('custom-client');
  });
});
