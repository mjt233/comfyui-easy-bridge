import { describe, it, expect } from 'vitest';
import { resolveHistoryOutcome } from './comfyui.service';

/**
 * resolveHistoryOutcome 单元测试：
 * 覆盖 ComfyUI /history 成功、失败、中断与仍在执行等结果解析。
 */
describe('resolveHistoryOutcome', () => {
  /** 测试用 prompt_id */
  const promptId = 'prompt-1';

  it('returns running when history has no entry', () => {
    expect(resolveHistoryOutcome({}, promptId)).toEqual({ kind: 'running' });
  });

  it('returns running when historyData is null', () => {
    expect(resolveHistoryOutcome(null, promptId)).toEqual({ kind: 'running' });
  });

  it('returns completed for success status', () => {
    const history = {
      [promptId]: {
        status: { status_str: 'success', completed: true, messages: [] },
        outputs: {},
      },
    };
    expect(resolveHistoryOutcome(history, promptId)).toEqual({ kind: 'completed' });
  });

  it('returns completed when completed is true even without status_str', () => {
    const history = {
      [promptId]: {
        status: { completed: true, messages: [] },
        outputs: {},
      },
    };
    expect(resolveHistoryOutcome(history, promptId)).toEqual({ kind: 'completed' });
  });

  it('returns failed for error status with exception_message', () => {
    const history = {
      [promptId]: {
        status: {
          status_str: 'error',
          completed: false,
          messages: [
            ['execution_error', { exception_message: 'CUDA OOM' }],
          ],
        },
        outputs: {},
      },
    };
    expect(resolveHistoryOutcome(history, promptId)).toEqual({
      kind: 'failed',
      errorMessage: 'CUDA OOM',
    });
  });

  it('returns failed with default message when error has no exception_message', () => {
    const history = {
      [promptId]: {
        status: {
          status_str: 'error',
          completed: false,
          messages: [],
        },
        outputs: {},
      },
    };
    expect(resolveHistoryOutcome(history, promptId)).toEqual({
      kind: 'failed',
      errorMessage: 'Execution error',
    });
  });

  it('returns failed for execution_interrupted messages', () => {
    const history = {
      [promptId]: {
        status: {
          status_str: 'error',
          completed: false,
          messages: [['execution_interrupted', { node_id: '1' }]],
        },
        outputs: {},
      },
    };
    const result = resolveHistoryOutcome(history, promptId);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.errorMessage.toLowerCase()).toContain('interrupt');
    }
  });
});
