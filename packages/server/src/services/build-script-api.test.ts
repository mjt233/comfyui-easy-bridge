import { describe, it, expect } from 'vitest';
import {
  BUILD_SCRIPT_API_DTS,
  BUILD_SCRIPT_DTS_HEADER,
  BUILD_RESULT_DTS,
  RUNTIME_PARAM_DTS,
  buildBuildContextDts,
  DEFAULT_BUILD_SCRIPT_TEMPLATE,
} from './build-script-api';

describe('build-script-api', () => {
  it('exports a d.ts containing all helper declarations', () => {
    for (const decl of [
      'declare interface ComfyNode',
      'declare type ComfyWorkflow',
      'declare interface BuildContext',
      'addNode(nodeId: string, classType: string',
      'removeNode(nodeId: string)',
      'connect(sourceNodeId: string',
      'disconnect(targetNodeId: string',
      'setInput(nodeId: string',
      'getInput(nodeId: string',
      'findNodesByClass(classType: string)',
      'getNode(nodeId: string)',
      'setTitle(nodeId: string',
    ]) {
      expect(BUILD_SCRIPT_API_DTS).toContain(decl);
    }
  });

  it('default template references BuildContext and BuildResult', () => {
    expect(DEFAULT_BUILD_SCRIPT_TEMPLATE).toContain('BuildContext');
    expect(DEFAULT_BUILD_SCRIPT_TEMPLATE).toContain('BuildResult');
    expect(DEFAULT_BUILD_SCRIPT_TEMPLATE).toContain('export default async function build');
  });

  it('static dts output is composed from header and static signatures', () => {
    expect(BUILD_SCRIPT_API_DTS).toContain('declare interface ComfyNode');
    expect(BUILD_SCRIPT_API_DTS).toContain('declare interface BuildContext');
    expect(BUILD_SCRIPT_API_DTS).toContain('addNode(nodeId: string, classType: string, inputs?: Record<string, unknown>): void;');
    expect(BUILD_SCRIPT_API_DTS).toContain('findNodesByClass(classType: string): string[];');
    expect(BUILD_SCRIPT_API_DTS).not.toContain('ComfyClassType');
    // 头部独立导出且被静态版复用
    expect(BUILD_SCRIPT_API_DTS).toContain(BUILD_SCRIPT_DTS_HEADER.trim());
    // 精确锁定拼装结构（唯一允许的差异是头部前导换行被去除）
    expect(BUILD_SCRIPT_API_DTS).toBe(
      `${BUILD_SCRIPT_DTS_HEADER}\n${RUNTIME_PARAM_DTS}\n${BUILD_RESULT_DTS}\n${buildBuildContextDts(
        'addNode(nodeId: string, classType: string, inputs?: Record<string, unknown>): void;',
        'findNodesByClass(classType: string): string[];',
      )}`,
    );
  });

  it('includes RuntimeParam/FileMeta/BuildResult declarations and files/baseParams in BuildContext', () => {
    expect(BUILD_SCRIPT_API_DTS).toContain('declare interface RuntimeParam');
    expect(BUILD_SCRIPT_API_DTS).toContain('declare interface FileMeta');
    expect(BUILD_SCRIPT_API_DTS).toContain('declare interface BuildResult');
    expect(BUILD_SCRIPT_API_DTS).toContain('files: Record<string, FileMeta[]>;');
    expect(BUILD_SCRIPT_API_DTS).toContain('baseParams: RuntimeParam[];');
  });

  it('buildBuildContextDts injects custom signatures', () => {
    const dts = buildBuildContextDts(
      'addNode<K extends ComfyClassType>(nodeId: string, classType: K, inputs?: Partial<ComfyNodeInputs[K]>): void;',
      'findNodesByClass(classType: ComfyClassType): string[];',
    );
    expect(dts).toContain('addNode<K extends ComfyClassType>');
    expect(dts).toContain('findNodesByClass(classType: ComfyClassType)');
    expect(dts).toContain('removeNode(nodeId: string): void;');
  });
});
