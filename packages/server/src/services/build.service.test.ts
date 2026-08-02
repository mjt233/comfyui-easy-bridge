import { describe, it, expect } from 'vitest';
import { runBuildScript } from './build.service';
import type { ComfyWorkflow } from './build-script-api';
import type { RuntimeParam, FileMeta } from './param.types';

/** 基础工作流：KSampler(4) 的 model 输入连到 CheckpointLoader(1) */
const baseWorkflow: ComfyWorkflow = {
  '1': { inputs: { ckpt_name: 'model.safetensors' }, class_type: 'CheckpointLoaderSimple', _meta: { title: '模型' } },
  '4': { inputs: { seed: 0, model: ['1', 0] }, class_type: 'KSampler', _meta: { title: '采样器' } },
};

describe('runBuildScript', () => {
  it('builds a workflow with addNode/connect/setInput', async () => {
    const script = `
      export default function build(ctx: any) {
        ctx.setInput('4', 'seed', 123);
        ctx.addNode('9', 'UpscaleModelLoader', { model_name: '4x.pth' });
        ctx.connect('9', 0, '4', 'model');
        return { workflow: ctx.workflow, params: ctx.baseParams };
      }
    `;
    const result = await runBuildScript(script, {}, baseWorkflow, [], {});
    expect(result.ok).toBe(true);
    expect(result.workflow?.['4'].inputs.seed).toBe(123);
    expect(result.workflow?.['4'].inputs.model).toEqual(['9', 0]);
    expect(result.workflow?.['9'].class_type).toBe('UpscaleModelLoader');
  });

  it('supports async default export and reads params', async () => {
    const script = `
      export default async function build(ctx: any) {
        await new Promise((r) => setTimeout(r, 10));
        ctx.removeNode('1');
        if (ctx.params.mode === 'short') {
          ctx.setInput('4', 'steps', 10);
        }
        return { workflow: ctx.workflow, params: ctx.baseParams };
      }
    `;
    const result = await runBuildScript(script, { mode: 'short' }, baseWorkflow, [], {});
    expect(result.ok).toBe(true);
    expect(result.workflow?.['1']).toBeUndefined();
    expect(result.workflow?.['4'].inputs.steps).toBe(10);
    // removeNode 清理了指向 1 的连线
    expect(result.workflow?.['4'].inputs.model).toBeNull();
  });

  it('does not mutate the input workflow (deep copy)', async () => {
    const script = 'export default function build(ctx: any) { ctx.setInput(\'4\', \'seed\', 999); return { workflow: ctx.workflow, params: [] }; }';
    const result = await runBuildScript(script, {}, baseWorkflow, [], {});
    expect(result.ok).toBe(true);
    expect(baseWorkflow['4'].inputs.seed).toBe(0);
  });

  it('supports disconnect/getInput/findNodesByClass/getNode/setTitle', async () => {
    const script = `
      export default function build(ctx: any) {
        const nodes = ctx.findNodesByClass('KSampler');
        ctx.setTitle('4', '自定义采样器');
        ctx.disconnect('4', 'model', 'fallback');
        const input = ctx.getInput('4', 'model');
        const node = ctx.getNode('1');
        return { workflow: { ...ctx.workflow, _info: { nodes, input, nodeClass: node.class_type } }, params: [] };
      }
    `;
    const result = await runBuildScript(script, {}, baseWorkflow, [], {});
    expect(result.ok).toBe(true);
    expect(result.workflow?.['4']._meta?.title).toBe('自定义采样器');
    expect(result.workflow?.['4'].inputs.model).toBe('fallback');
    expect(result.workflow?._info).toEqual({
      nodes: ['4'],
      input: 'fallback',
      nodeClass: 'CheckpointLoaderSimple',
    });
  });

  it('rejects results larger than 2MB', async () => {
    const script = `
      export default function build(ctx: any) {
        ctx.setInput('4', 'big', 'x'.repeat(3 * 1024 * 1024));
        return { workflow: ctx.workflow, params: [] };
      }
    `;
    const result = await runBuildScript(script, {}, baseWorkflow, [], {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_error');
    expect(result.error).toContain('too large');
  });

  it('reports syntax errors with real diagnostic', async () => {
    const result = await runBuildScript('export default function build( {', {}, baseWorkflow, [], {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_error');
    expect(result.error).toContain('Transpile error');
  });

  it('reports runtime errors with message', async () => {
    const script = 'export default function build(ctx: any) { ctx.addNode(\'4\', \'X\'); return ctx.workflow; }';
    const result = await runBuildScript(script, {}, baseWorkflow, [], {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_error');
    expect(result.error).toContain('already exists');
  });

  it('kills infinite loops via timeout', async () => {
    const script = 'export default function build() { while (true) {} }';
    const result = await runBuildScript(script, {}, baseWorkflow, [], {}, 1000);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_timeout');
  });

  it('allows open Node capabilities (require fs)', async () => {
    const script = `
      const fs = require('fs');
      export default function build(ctx: any) {
        ctx.setInput('4', 'seed', fs.readFileSync(require('path').join('x', 'y'), 'utf8').length);
        return { workflow: ctx.workflow, params: [] };
      }
    `;
    // 文件不存在会抛错 → 说明 require('fs') 可用（错误来自文件不存在而非 require 失败）
    const result = await runBuildScript(script, {}, baseWorkflow, [], {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('rejects non-object returns', async () => {
    for (const bad of ['null', '{ workflow: \'str\' }', '{ workflow: [], params: \'x\' }']) {
      const script = `export default function build() { return ${bad}; }`;
      const result = await runBuildScript(script, {}, baseWorkflow, [], {});
      expect(result.ok).toBe(false);
      expect(result.code).toBe('build_script_error');
    }
  });

  it('connect to missing node throws', async () => {
    const script = 'export default function build(ctx: any) { ctx.connect(\'nope\', 0, \'4\', \'model\'); return ctx.workflow; }';
    const result = await runBuildScript(script, {}, baseWorkflow, [], {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('connect with non-number slot throws', async () => {
    const script = 'export default function build(ctx: any) { ctx.connect(\'1\', \'x\', \'4\', \'model\'); return ctx.workflow; }';
    const result = await runBuildScript(script, {}, baseWorkflow, [], {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('source slot must be a number');
  });

  it('supports declarative return with params and reads ctx.files/baseParams', async () => {
    const baseParams: RuntimeParam[] = [
      { nodeId: '4', fieldName: 'seed', alias: 'seed', label: null, paramType: 'number', defaultValue: null, fileIndex: 0 },
    ];
    const filesMeta: Record<string, FileMeta[]> = {
      ref_images: [
        { originalname: 'a.png', mimetype: 'image/png', size: 10 },
        { originalname: 'b.png', mimetype: 'image/png', size: 20 },
      ],
    };
    const script = `
      export default function build(ctx: any) {
        const count = (ctx.files.ref_images ?? []).length;
        const params = [...ctx.baseParams];
        for (let i = 0; i < count; i++) {
          const nodeId = 'load_' + i;
          ctx.addNode(nodeId, 'LoadImage', { image: '' });
          params.push({ nodeId, fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: i });
        }
        return { workflow: ctx.workflow, params };
      }
    `;
    const result = await runBuildScript(script, {}, baseWorkflow, baseParams, filesMeta);
    expect(result.ok).toBe(true);
    expect(result.workflow?.['load_0']).toBeTruthy();
    expect(result.workflow?.['load_1']).toBeTruthy();
    expect(result.params).toHaveLength(3);
    expect(result.params?.[1]).toMatchObject({ nodeId: 'load_0', alias: 'ref_images', paramType: 'image', fileIndex: 0 });
    expect(result.params?.[2]).toMatchObject({ nodeId: 'load_1', alias: 'ref_images', paramType: 'image', fileIndex: 1 });
  });

  it('rejects legacy return ctx.workflow (declarative required)', async () => {
    const script = 'export default function build(ctx: any) { return ctx.workflow; }';
    const result = await runBuildScript(script, {}, baseWorkflow, [], {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_error');
    expect(result.error).toContain('{ workflow, params }');
  });
});
