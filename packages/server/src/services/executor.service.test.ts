import { describe, it, expect } from 'vitest';
import {
  applyAliases,
  processMediaParams,
  resolveSubmittedAliasValues,
} from './executor.service';
import type { RuntimeParam } from './param.types';
import type {
  ExecutionProvider,
  ExecutionResult,
  MediaType,
  OutputFileRef,
  UploadFileInput,
} from './providers/types';

/**
 * 构造测试用 provider 桩：记录上传调用。
 * @param uploadResults 依次返回的上传文件名（缺省时返回 uploaded-{序号}）
 * @returns provider 桩实例与上传调用记录
 */
function makeProviderStub(uploadResults: string[]): {
  provider: ExecutionProvider;
  uploadCalls: Array<{ file: UploadFileInput; mediaType: MediaType }>;
} {
  const uploadCalls: Array<{ file: UploadFileInput; mediaType: MediaType }> = [];
  let idx = 0;
  const provider: ExecutionProvider = {
    id: 'p1',
    name: 'stub',
    type: 'comfyui',
    concurrency: 1,
    trackingMode: 'polling',
    getBaseUrl: () => 'http://comfy:8188',
    getDisplayBaseUrl: () => 'http://comfy:8188',
    submitPrompt: async (_body: string): Promise<ExecutionResult> => ({
      success: true, comfyuiResponse: null, promptId: 'pid', errorMessage: null,
    }),
    uploadMedia: async (file: UploadFileInput, mediaType: MediaType): Promise<string> => {
      uploadCalls.push({ file, mediaType });
      const name = uploadResults[idx] ?? `uploaded-${idx}`;
      idx += 1;
      return name;
    },
    fetchHistory: async () => ({}),
    interrupt: async () => true,
    isPromptRunning: async () => false,
    buildOutputViewUrl: (f: OutputFileRef) => `http://comfy:8188/view?filename=${f.filename}`,
  };
  return { provider, uploadCalls };
}

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

  it('applyAliases skips injection when fileIndex is out of range for array value', () => {
    // 数组别名值 + 越界 fileIndex → 跳过注入，保持节点原值，不写入空字符串
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'imgs', label: null, paramType: 'text', defaultValue: null, fileIndex: 5 },
    ];
    const result = applyAliases(sampleJson, params, { imgs: ['a.png', 'b.png'] });
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
  it('uploads file for image params and overrides alias value', async () => {
    const { provider, uploadCalls } = makeProviderStub(['uploaded.png']);

    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: 'img', label: null, paramType: 'image', defaultValue: null },
    ];
    const files = {
      img: [{ buffer: Buffer.from('data'), originalname: 'photo.png', mimetype: 'image/png' }],
    };

    const result = await processMediaParams(params, { img: 'old.png' }, files, provider);
    expect(result.img).toBe('uploaded.png');
    // 上传调用被记录：文件与媒体类型正确
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].mediaType).toBe('image');
    expect(uploadCalls[0].file).toBe(files.img[0]);
  });

  it('keeps alias value if no file uploaded for media param', async () => {
    const { provider, uploadCalls } = makeProviderStub([]);

    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: 'img', label: null, paramType: 'image', defaultValue: null },
    ];

    const result = await processMediaParams(params, { img: 'existing.png' }, {}, provider);
    expect(result.img).toBe('existing.png');
    expect(uploadCalls).toHaveLength(0);
  });

  it('skips text params', async () => {
    const { provider, uploadCalls } = makeProviderStub([]);

    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'value', alias: 'txt', label: null, paramType: 'text', defaultValue: null },
    ];

    const result = await processMediaParams(params, { txt: 'hello' }, {}, provider);
    expect(result.txt).toBe('hello');
    expect(uploadCalls).toHaveLength(0);
  });

  it('maps each alias to its distinct uploaded filename', async () => {
    // 同名原文件去重的职责已下沉到 provider 实现（见 comfyui.provider.test.ts）；
    // 此处验证 processMediaParams 正确透传每个别名的上传结果
    const { provider, uploadCalls } = makeProviderStub(['photo_a1b2c3.png', 'photo_d4e5f6.png']);

    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: 'img1', label: null, paramType: 'image', defaultValue: null },
      { id: 2, workflowId: 'test', nodeId: '2', fieldName: 'image', alias: 'img2', label: null, paramType: 'image', defaultValue: null },
    ];
    const files = {
      img1: [{ buffer: Buffer.from('data1'), originalname: 'photo.png', mimetype: 'image/png' }],
      img2: [{ buffer: Buffer.from('data2'), originalname: 'photo.png', mimetype: 'image/png' }],
    };

    const result = await processMediaParams(params, {}, files, provider);

    // 两个参数最终引用的文件名必须不同，否则节点会加载到同一份被覆盖的资源
    expect(result.img1).toBe('photo_a1b2c3.png');
    expect(result.img2).toBe('photo_d4e5f6.png');
    expect(result.img1).not.toBe(result.img2);
    expect(result.img1).toMatch(/\.png$/i);
    expect(result.img2).toMatch(/\.png$/i);
    // 两个别名各触发一次上传，媒体类型被记录
    expect(uploadCalls).toHaveLength(2);
    expect(uploadCalls[0].mediaType).toBe('image');
    expect(uploadCalls[1].mediaType).toBe('image');
  });

  it('skips media params without alias', async () => {
    const { provider, uploadCalls } = makeProviderStub([]);

    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: null, label: null, paramType: 'image', defaultValue: null },
    ];
    const files = {
      img: [{ buffer: Buffer.from('data'), originalname: 'photo.png', mimetype: 'image/png' }],
    };
    const result = await processMediaParams(params, {}, files, provider);
    expect(uploadCalls).toHaveLength(0);
    expect(result).toEqual({});
  });

  it('processMediaParams returns array for multi-file alias and applyAliases injects per fileIndex', async () => {
    // 两个参数同 alias 'ref_images'（fileIndex 0/1）→ 同别名多文件，processMediaParams 返回数组
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

    // 同别名多参数 → 上传全部文件，result[alias] 为按上传顺序的数组
    const { provider, uploadCalls } = makeProviderStub([]);
    const uploaded = await processMediaParams(params, {}, files, provider);
    expect(Array.isArray(uploaded.ref_images)).toBe(true);
    const arr = uploaded.ref_images as string[];
    expect(arr).toHaveLength(2);

    // 同别名只上传一次（2 参数 × 2 文件 → 2 次上传，而非 4 次）
    expect(uploadCalls).toHaveLength(2);

    // applyAliases 按 fileIndex 注入不同文件名到对应节点（同别名多文件核心：两个节点不再共用同一文件）
    const rawJson = JSON.stringify({
      'load1': { inputs: { image: '' }, class_type: 'LoadImage' },
      'load2': { inputs: { image: '' }, class_type: 'LoadImage' },
    });
    const injected = applyAliases(rawJson, params, uploaded);
    const parsed = JSON.parse(injected) as Record<string, { inputs: { image: string } }>;
    expect(parsed['load1'].inputs.image).toBe(arr[0]);
    expect(parsed['load2'].inputs.image).toBe(arr[1]);
  });

  it('processMediaParams keeps string for single-file alias (backward compatible)', async () => {
    // 单参数 + 单文件 → 保持 string，兼容既有行为
    const params: RuntimeParam[] = [
      { nodeId: 'load1', fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: 0 },
    ];
    const files = { ref_images: [{ buffer: Buffer.from('a'), originalname: 'a.png', mimetype: 'image/png' }] };
    const { provider } = makeProviderStub([]);
    const uploaded = await processMediaParams(params, {}, files, provider);
    expect(typeof uploaded.ref_images).toBe('string');
  });
});
