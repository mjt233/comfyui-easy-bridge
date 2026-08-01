import { describe, it, expect } from 'vitest';
import { runBuildScript } from './build.service';
import type { ComfyWorkflow } from './build-script-api';

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
        return ctx.workflow;
      }
    `;
    const result = await runBuildScript(script, {}, baseWorkflow);
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
        return ctx.workflow;
      }
    `;
    const result = await runBuildScript(script, { mode: 'short' }, baseWorkflow);
    expect(result.ok).toBe(true);
    expect(result.workflow?.['1']).toBeUndefined();
    expect(result.workflow?.['4'].inputs.steps).toBe(10);
    // removeNode 清理了指向 1 的连线
    expect(result.workflow?.['4'].inputs.model).toBeNull();
  });

  it('does not mutate the input workflow (deep copy)', async () => {
    const script = `export default function build(ctx: any) { ctx.setInput('4', 'seed', 999); return ctx.workflow; }`;
    const result = await runBuildScript(script, {}, baseWorkflow);
    expect(result.ok).toBe(true);
    expect(baseWorkflow['4'].inputs.seed).toBe(0);
  });

  it('reports syntax errors', async () => {
    const result = await runBuildScript('export default function build( {', {}, baseWorkflow);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_error');
    expect(result.error).toBeTruthy();
  });

  it('reports runtime errors with message', async () => {
    const script = `export default function build(ctx: any) { ctx.addNode('4', 'X'); return ctx.workflow; }`;
    const result = await runBuildScript(script, {}, baseWorkflow);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_error');
    expect(result.error).toContain('already exists');
  });

  it('kills infinite loops via timeout', async () => {
    const script = `export default function build() { while (true) {} }`;
    const result = await runBuildScript(script, {}, baseWorkflow, 1000);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('build_script_timeout');
  });

  it('allows open Node capabilities (require fs)', async () => {
    const script = `
      const fs = require('fs');
      export default function build(ctx: any) {
        ctx.setInput('4', 'seed', fs.readFileSync(require('path').join('x', 'y'), 'utf8').length);
        return ctx.workflow;
      }
    `;
    // 文件不存在会抛错 → 说明 require('fs') 可用（错误来自文件不存在而非 require 失败）
    const result = await runBuildScript(script, {}, baseWorkflow);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('rejects non-object returns', async () => {
    for (const bad of ['null', '[]', '"str"']) {
      const script = `export default function build() { return ${bad}; }`;
      const result = await runBuildScript(script, {}, baseWorkflow);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('build_script_error');
    }
  });

  it('connect to missing node throws', async () => {
    const script = `export default function build(ctx: any) { ctx.connect('nope', 0, '4', 'model'); return ctx.workflow; }`;
    const result = await runBuildScript(script, {}, baseWorkflow);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});
