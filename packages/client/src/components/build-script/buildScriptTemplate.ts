/**
 * 编辑器"默认导出模板"片段。
 * 与服务端 build-script-api.ts 中的 DEFAULT_BUILD_SCRIPT_TEMPLATE 保持一致。
 */
export const DEFAULT_BUILD_SCRIPT_TEMPLATE = `export default async function build(ctx: BuildContext): Promise<ComfyWorkflow> {
  const { workflow, params } = ctx;
  // 在这里根据 params 动态调整工作流。
  // 示例：
  // if (params.mode === 'upscale') {
  //   ctx.addNode('9', 'UpscaleModelLoader', { model_name: '4x-UltraSharp.pth' });
  //   ctx.connect('9', 0, '4', 'model');
  // }
  return workflow;
}
`;
