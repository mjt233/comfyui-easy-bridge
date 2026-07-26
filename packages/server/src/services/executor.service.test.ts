import { describe, it, expect } from 'vitest';
import { applyAliases, executeWorkflow } from './executor.service';

describe('executor.service', () => {
  const sampleJson = JSON.stringify({
    "29": {
      "inputs": { "filename_prefix": "test", "images": ["30:8", 0] },
      "class_type": "SaveImage",
      "_meta": { "title": "保存图像" }
    },
    "30:19": {
      "inputs": { "value": "original prompt" },
      "class_type": "PrimitiveStringMultiline",
      "_meta": { "title": "Text String" }
    }
  });

  it('applyAliases replaces primitive values', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null }
    ];
    const result = applyAliases(sampleJson, params, { img_desc: 'a cute cat' });
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('a cute cat');
  });

  it('applyAliases does not modify node connections (arrays)', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '29', fieldName: 'images', alias: 'img_alias', label: null }
    ];
    const result = applyAliases(sampleJson, params, { img_alias: 'something' });
    const parsed = JSON.parse(result);
    // images is an array (connection), should NOT be replaced
    expect(Array.isArray(parsed['29'].inputs.images)).toBe(true);
  });

  it('applyAliases throws on missing alias value', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null }
    ];
    expect(() => applyAliases(sampleJson, params, {})).toThrow('Missing required parameter: img_desc');
  });

  it('applyAliases ignores params for non-existent nodes', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: 'nonexistent', fieldName: 'value', alias: 'x', label: null }
    ];
    const result = applyAliases(sampleJson, params, { x: 'val' });
    expect(result).toBe(sampleJson);
  });
});
