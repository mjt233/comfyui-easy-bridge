# Failed Task Status Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When ComfyUI execution fails, task logs must transition from `pending` to `failed` with an error message (via WebSocket and/or `/history` fallback).

**Architecture:** Export a pure `resolveHistoryOutcome` parser for ComfyUI history status; use it in fallback and completion polls. Bind a stable bridge `client_id` on WebSocket and inject it into every `/prompt` submit so `execution_error` is delivered. Stop treating `executing` with `node=null` as success.

**Tech Stack:** Node.js, TypeScript, Express, vitest, ComfyUI HTTP/WS API

---

### Task 1: History outcome parser (TDD)

**Files:**
- Create: `packages/server/src/services/comfyui.service.test.ts`
- Modify: `packages/server/src/services/comfyui.service.ts`

- [x] **Step 1: Write failing tests for `resolveHistoryOutcome`**

```typescript
import { describe, it, expect } from 'vitest';
import { resolveHistoryOutcome } from './comfyui.service';

describe('resolveHistoryOutcome', () => {
  const promptId = 'prompt-1';

  it('returns running when history has no entry', () => {
    expect(resolveHistoryOutcome({}, promptId)).toEqual({ kind: 'running' });
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
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec vitest run src/services/comfyui.service.test.ts`
Expected: FAIL (export missing)

- [x] **Step 3: Implement `resolveHistoryOutcome`**

Export from `comfyui.service.ts`:

```typescript
export type HistoryOutcome =
  | { kind: 'running' }
  | { kind: 'completed' }
  | { kind: 'failed'; errorMessage: string };

export function resolveHistoryOutcome(historyData: unknown, promptId: string): HistoryOutcome {
  // no entry => running
  // status_str success or completed true => completed
  // status_str error or error/interrupted messages => failed + message
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter server exec vitest run src/services/comfyui.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** (deferred; user did not request commit)

```bash
git add packages/server/src/services/comfyui.service.ts packages/server/src/services/comfyui.service.test.ts
git commit -m "fix: parse ComfyUI history failure outcomes"
```

---

### Task 2: Use history outcome in polls

**Files:**
- Modify: `packages/server/src/services/comfyui.service.ts`

- [x] **Step 1: Refactor `startFallback` and `startCompletionPoll`**

Shared apply logic:
- `running` → skip
- `completed` → update completed + extract outputs + drainQueue
- `failed` → update failed + errorMessage + drainQueue

- [x] **Step 2: Typecheck**

Run: `pnpm --filter server exec tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit** (deferred)

```bash
git add packages/server/src/services/comfyui.service.ts
git commit -m "fix: mark tasks failed from history fallback poll"
```

---

### Task 3: Inject client_id on prompt submit (TDD)

**Files:**
- Modify: `packages/server/src/services/executor.service.ts`
- Modify: `packages/server/src/services/executor.service.test.ts`
- Modify: `packages/server/src/services/comfyui.service.ts` (WS URL uses same client id)

- [x] **Step 1: Write failing test that submit body includes client_id**

Mock fetch; call `submitPrompt(JSON.stringify({ prompt: {} }), 'http://localhost:8188')`; assert parsed body has `client_id` string.

- [x] **Step 2: Run test to verify fail/pass cycle**

- [x] **Step 3: Implement**

- Export module-level `COMFYUI_CLIENT_ID = randomUUID()`
- In `submitPrompt`, parse body JSON object, set `client_id` if missing, re-stringify
- WS URL: `/ws?clientId=${COMFYUI_CLIENT_ID}`

- [ ] **Step 4: Commit** (deferred)

```bash
git commit -m "fix: bind ComfyUI client_id for WS error events"
```

---

### Task 4: Fix WebSocket event handling

**Files:**
- Modify: `packages/server/src/services/comfyui.service.ts`

- [x] **Step 1: Update message handler**

- Keep `execution_success` → completeTask
- Keep `execution_error` → failTask with safe string message
- Add `execution_interrupted` → failTask
- Remove `executing && node == null → completeTask`

- [x] **Step 2: Typecheck + tests**

Run:
- `pnpm --filter server exec tsc --noEmit`
- `pnpm --filter server test`

- [ ] **Step 3: Commit** (deferred)

```bash
git commit -m "fix: handle execution_interrupted and avoid false complete"
```

---

### Task 5: Final verification

- [x] **Step 1: Run full server checks**

```bash
pnpm --filter server exec tsc --noEmit
pnpm --filter server test
```

- [ ] **Step 2: Manual checklist**

- Failed ComfyUI run → task status `failed` + errorMessage
- Successful run → `completed` + outputs
- Cancel still works
