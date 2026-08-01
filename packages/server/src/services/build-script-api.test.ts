import { describe, it, expect } from 'vitest';
import { BUILD_SCRIPT_API_DTS, DEFAULT_BUILD_SCRIPT_TEMPLATE } from './build-script-api';

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

  it('default template references BuildContext and ComfyWorkflow', () => {
    expect(DEFAULT_BUILD_SCRIPT_TEMPLATE).toContain('BuildContext');
    expect(DEFAULT_BUILD_SCRIPT_TEMPLATE).toContain('ComfyWorkflow');
    expect(DEFAULT_BUILD_SCRIPT_TEMPLATE).toContain('export default async function build');
  });
});
