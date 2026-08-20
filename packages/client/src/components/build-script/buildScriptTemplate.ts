/**
 * 编辑器"默认导出模板"片段。
 * 与服务端 build-script-api.ts 中的 DEFAULT_BUILD_SCRIPT_TEMPLATE 保持一致。
 */
export const DEFAULT_BUILD_SCRIPT_TEMPLATE = `export default async function build(ctx: BuildContext): Promise<BuildResult> {
  const { workflow, params, files, baseParams, request, provider } = ctx;
  // 在这里根据 params / files / request / provider 动态调整工作流与参数配置。
  // 示例：按提供商类型分支
  // if (provider.type === 'runninghub') { /* RunningHub 专用节点 */ }
  // 示例：按上传文件数量动态建节点
  // const count = (files.ref_images ?? []).length;
  // for (let i = 0; i < count; i++) {
  //   const nodeId = 'load_' + i;
  //   ctx.addNode(nodeId, 'LoadImage', { image: '' });
  //   baseParams.push({ nodeId, fieldName: 'image', alias: 'ref_images', label: null, paramType: 'image', defaultValue: null, fileIndex: i });
  // }
  return { workflow, params: baseParams };
}
`;
