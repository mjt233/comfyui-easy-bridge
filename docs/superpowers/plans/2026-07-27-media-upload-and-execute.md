# Media Upload and Execute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to upload media files (image/video/audio) in the same API call that executes a ComfyUI workflow, by extending the execute endpoint to accept multipart/form-data.

**Architecture:** Add `param_type` to `workflow_params` DB schema. New `upload.service.ts` handles file upload to ComfyUI. `executor.service.ts` extended with `processMediaParams()` to upload files before alias substitution. Execute controller detects multipart requests and separates files from alias JSON. Frontend shows file inputs for media params and sends FormData.

**Tech Stack:** multer (backend multipart parsing), fetch/FormData (ComfyUI upload), Vue 3 + Vuetify (frontend file inputs)

---

### Task 1: Add multer dependency and update DB schema

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/models/schema.ts`
- Modify: `packages/server/src/models/db.ts`
- Test: `packages/server/src/services/executor.service.test.ts`

- [ ] **Step 1: Install multer**

Run: `pnpm --filter server add multer && pnpm --filter server add -D @types/multer`

Expected: packages/server/package.json updated with `multer` and `@types/multer`.

- [ ] **Step 2: Update Drizzle schema to add param_type**

In `packages/server/src/models/schema.ts`, add `paramType` field to `workflowParams`:

```typescript
export const workflowParams = sqliteTable('workflow_params', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  fieldName: text('field_name').notNull(),
  alias: text('alias').notNull().unique(),
  label: text('label'),
  paramType: text('param_type').notNull().default('text'),
});
```

- [ ] **Step 3: Update DB CREATE TABLE to add column**

In `packages/server/src/models/db.ts`, update the `workflow_params` DDL to include `param_type`:

```typescript
db.run(`
  CREATE TABLE IF NOT EXISTS workflow_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    alias TEXT NOT NULL UNIQUE,
    label TEXT,
    param_type TEXT NOT NULL DEFAULT 'text'
  )
`);
```

- [ ] **Step 4: Update WorkflowParam interface in executor.service.ts**

In `packages/server/src/services/executor.service.ts`, add `paramType` to the interface:

```typescript
export interface WorkflowParam {
  id: number;
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label: string | null;
  paramType: string;
}
```

- [ ] **Step 5: Update existing test for applyAliases to include paramType**

In `packages/server/src/services/executor.service.test.ts`, update the `params` in test fixtures to include `paramType: 'text'`.

- [ ] **Step 6: Verify existing tests still pass**

Run: `pnpm --filter server test`

Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server/package.json packages/server/pnpm-lock.yaml packages/server/src/models/schema.ts packages/server/src/models/db.ts packages/server/src/services/executor.service.ts packages/server/src/services/executor.service.test.ts
git commit -m "feat: add param_type to workflow_params schema"
```

---

### Task 2: Create upload.service.ts

**Files:**
- Create: `packages/server/src/services/upload.service.ts`
- Create: `packages/server/src/services/upload.service.test.ts`

- [ ] **Step 1: Write the upload service**

Create `packages/server/src/services/upload.service.ts`:

```typescript
/** 将文件上传到 ComfyUI，返回 ComfyUI 存储的文件名 */
export async function uploadFileToComfyUI(
  file: { buffer: Buffer; originalname: string; mimetype: string },
  mediaType: 'image' | 'video' | 'audio',
  comfyuiBaseUrl: string,
): Promise<string> {
  const endpoint = mediaType === 'image' ? '/upload/image' : `/upload/${mediaType}`;
  const formData = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype });
  formData.append('image', blob, file.originalname);
  formData.append('type', 'input');
  formData.append('overwrite', 'true');

  const response = await fetch(`${comfyuiBaseUrl}${endpoint}`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ComfyUI upload failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as { name: string };
  return result.name;
}
```

- [ ] **Step 2: Write tests for upload service**

Create `packages/server/src/services/upload.service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadFileToComfyUI } from './upload.service';

describe('upload.service', () => {
  const mockFetch = vi.fn();
  globalThis.fetch = mockFetch;

  const mockFile = {
    buffer: Buffer.from('fake-image-data'),
    originalname: 'test.png',
    mimetype: 'image/png',
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('uploads image to ComfyUI and returns filename', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'test.png' }),
    });
    const result = await uploadFileToComfyUI(mockFile, 'image', 'http://localhost:8188');
    expect(result).toBe('test.png');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8188/upload/image',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws on upload failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Invalid file',
    });
    await expect(
      uploadFileToComfyUI(mockFile, 'image', 'http://localhost:8188'),
    ).rejects.toThrow('ComfyUI upload failed (400): Invalid file');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter server test`

Expected: Tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/upload.service.ts packages/server/src/services/upload.service.test.ts
git commit -m "feat: add upload service for ComfyUI file upload"
```

---

### Task 3: Add processMediaParams to executor.service.ts

**Files:**
- Modify: `packages/server/src/services/executor.service.ts`
- Modify: `packages/server/src/services/executor.service.test.ts`

- [ ] **Step 1: Add processMediaParams function**

In `packages/server/src/services/executor.service.ts`, add the import and the new function:

```typescript
import { uploadFileToComfyUI } from './upload.service';

// ... existing code ...

/** 处理媒体参数：将上传的文件发送到 ComfyUI，返回最终 aliasValues */
export async function processMediaParams(
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
  files: Record<string, { buffer: Buffer; originalname: string; mimetype: string }[]>,
  comfyuiBaseUrl: string,
): Promise<Record<string, string>> {
  const result = { ...aliasValues };
  for (const param of params) {
    if (param.paramType === 'text') continue;
    const fileList = files[param.alias];
    const file = fileList?.[0];
    if (file) {
      const filename = await uploadFileToComfyUI(
        file,
        param.paramType as 'image' | 'video' | 'audio',
        comfyuiBaseUrl,
      );
      result[param.alias] = filename;
    }
  }
  return result;
}
```

- [ ] **Step 2: Write tests for processMediaParams**

In `packages/server/src/services/executor.service.test.ts`, add:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyAliases, processMediaParams } from './executor.service';

describe('processMediaParams', () => {
  const mockFetch = vi.fn();
  globalThis.fetch = mockFetch;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('uploads file for image params and overrides alias value', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'uploaded.png' }),
    });

    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: 'img', label: null, paramType: 'image' },
    ];
    const files = {
      img: [{ buffer: Buffer.from('data'), originalname: 'photo.png', mimetype: 'image/png' }],
    };

    const result = await processMediaParams(params, { img: 'old.png' }, files, 'http://localhost:8188');
    expect(result.img).toBe('uploaded.png');
  });

  it('keeps alias value if no file uploaded for media param', async () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: 'img', label: null, paramType: 'image' },
    ];

    const result = await processMediaParams(params, { img: 'existing.png' }, {}, 'http://localhost:8188');
    expect(result.img).toBe('existing.png');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips text params', async () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'value', alias: 'txt', label: null, paramType: 'text' },
    ];

    const result = await processMediaParams(params, { txt: 'hello' }, {}, 'http://localhost:8188');
    expect(result.txt).toBe('hello');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter server test`

Expected: Tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/services/executor.service.ts packages/server/src/services/executor.service.test.ts
git commit -m "feat: add processMediaParams for auto-upload in executor"
```

---

### Task 4: Add param_type support to workflow service

**Files:**
- Modify: `packages/server/src/services/workflow.service.ts`

- [ ] **Step 1: Add param_type to addParam interface and method**

In `packages/server/src/services/workflow.service.ts`:

```typescript
interface AddParamInput {
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label?: string;
  paramType?: string;
}

interface UpdateParamInput {
  alias?: string;
  label?: string | null;
  paramType?: string;
}

// In addParam method:
addParam(input: AddParamInput) {
  this.db.insert(schema.workflowParams).values({
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    fieldName: input.fieldName,
    alias: input.alias,
    label: input.label ?? null,
    paramType: input.paramType ?? 'text',
  }).run();
  // ... rest unchanged
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/services/workflow.service.ts
git commit -m "feat: add param_type support to workflow service"
```

---

### Task 5: Update execute controller with multipart handling

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`

- [ ] **Step 1: Update execute method**

In `packages/server/src/controllers/workflow.controller.ts`, modify `execute`:

```typescript
import { processMediaParams } from '../services/executor.service';

// In execute method:
async execute(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;
  const wf = workflowService.getById(id);
  if (!wf) {
    res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
    return;
  }
  const params = workflowService.getParams(id);
  const baseUrl = settingsService.get('comfyui_base_url');
  if (!baseUrl) {
    res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
    return;
  }

  // 解析 multipart 或 JSON 请求
  const isMultipart = req.is('multipart/form-data');
  let aliasValues: Record<string, string>;
  let uploadedFiles: Record<string, { buffer: Buffer; originalname: string; mimetype: string }[]>;

  if (isMultipart) {
    aliasValues = JSON.parse(req.body.params || '{}');
    const multerFiles = (req.files as Express.Multer.File[]) || [];
    uploadedFiles = {};
    for (const f of multerFiles) {
      if (!uploadedFiles[f.fieldname]) uploadedFiles[f.fieldname] = [];
      uploadedFiles[f.fieldname].push({
        buffer: f.buffer,
        originalname: f.originalname,
        mimetype: f.mimetype,
      });
    }
  } else {
    aliasValues = req.body as Record<string, string>;
    uploadedFiles = {};
  }

  // 处理媒体文件上传
  const finalAliasValues = await processMediaParams(params, aliasValues, uploadedFiles, baseUrl);

  // 验证参数
  const modifiedJson = applyAliases(wf.rawJson, params, finalAliasValues);

  // 并发控制...
  // 后续保持不变，但使用 finalAliasValues 替代 aliasValues
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/controllers/workflow.controller.ts
git commit -m "feat: add multipart handling to execute controller"
```

---

### Task 6: Add multer middleware to route

**Files:**
- Modify: `packages/server/src/routes/workflow.routes.ts`

- [ ] **Step 1: Add multer to the execute route**

```typescript
import multer from 'multer';

export function createWorkflowRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createWorkflowController(db);
  const auth = createAuthMiddleware(db);
  const upload = multer({ storage: multer.memoryStorage() });

  router.post('/:id/execute', upload.any(), controller.execute);

  // ... rest unchanged
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/routes/workflow.routes.ts
git commit -m "feat: add multer middleware to execute route"
```

---

### Task 7: Update frontend types and API

**Files:**
- Modify: `packages/client/src/types/index.ts`
- Modify: `packages/client/src/api/workflows.ts`

- [ ] **Step 1: Add paramType to WorkflowParam type**

In `packages/client/src/types/index.ts`:

```typescript
export interface WorkflowParam {
  id: number;
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label: string | null;
  paramType: string;
}
```

- [ ] **Step 2: Update executeWorkflow API to support FormData**

In `packages/client/src/api/workflows.ts`:

```typescript
export async function executeWorkflow(
  workflowId: string,
  aliasValues: Record<string, string>,
  files?: Record<string, File>,
): Promise<ExecuteResult> {
  if (!files || Object.keys(files).length === 0) {
    const res = await client.post<ExecuteResult>(`/workflows/${workflowId}/execute`, aliasValues);
    return res.data;
  }
  const formData = new FormData();
  formData.append('params', JSON.stringify(aliasValues));
  for (const [alias, file] of Object.entries(files)) {
    formData.append(alias, file);
  }
  const res = await client.post<ExecuteResult>(`/workflows/${workflowId}/execute`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/types/index.ts packages/client/src/api/workflows.ts
git commit -m "feat: update frontend types and API for media upload"
```

---

### Task 8: Update frontend execute dialog for file inputs

**Files:**
- Modify: `packages/client/src/pages/WorkflowListPage.vue`

- [ ] **Step 1: Update template to show file inputs for media params**

Replace the existing `<v-textarea>` loop with a conditional:

```vue
<template v-for="field in executeFields" :key="field.alias">
  <v-textarea
    v-if="field.paramType === 'text'"
    v-model="executeForm[field.alias]"
    :label="field.label || field.alias"
    :hint="`节点: ${field.nodeTitle} · ${field.fieldName}`"
    persistent-hint
    variant="outlined"
    density="compact"
    class="mb-2"
    :rows="1"
    max-rows="6"
    auto-grow
  />
  <v-file-input
    v-else
    :label="field.label || field.alias"
    :hint="`节点: ${field.nodeTitle} · ${field.fieldName}`"
    persistent-hint
    variant="outlined"
    density="compact"
    class="mb-2"
    :accept="acceptType(field.paramType)"
    @update:model-value="(v: File | File[] | null) => {
      if (v) {
        executeFiles[field.alias] = Array.isArray(v) ? v[0] : v;
      } else {
        delete executeFiles[field.alias];
      }
    }"
  />
</template>
```

- [ ] **Step 2: Add reactive executeFiles and acceptType method**

In the `<script>` section:

```typescript
const executeFiles = reactive<Record<string, File>>({});

function acceptType(paramType: string): string {
  switch (paramType) {
    case 'image': return 'image/*';
    case 'video': return 'video/*';
    case 'audio': return 'audio/*';
    default: return '*/*';
  }
}
```

- [ ] **Step 3: Update confirmExecute to include files**

```typescript
async function confirmExecute() {
  if (!executeTarget.value) return;
  submitting.value = true;
  try {
    const aliasValues: Record<string, string> = {};
    for (const field of executeFields.value) {
      aliasValues[field.alias] = executeForm[field.alias];
    }
    const files = Object.keys(executeFiles).length > 0 ? { ...executeFiles } : undefined;
    const result = await executeWorkflow(executeTarget.value, aliasValues, files);
    snackbar.value = { show: true, text: `任务已提交 (${result.task_id.slice(0, 8)}...)`, color: 'success' };
    executeDialog.value = false;
  } catch {
    snackbar.value = { show: true, text: '执行失败', color: 'error' };
  } finally {
    submitting.value = false;
  }
}
```

- [ ] **Step 4: Update ExecuteField interface**

```typescript
interface ExecuteField {
  alias: string;
  label: string;
  fieldName: string;
  nodeTitle: string;
  paramType: string;
}
```

- [ ] **Step 5: Update handleExecute to populate paramType**

In `handleExecute`, add paramType to the field object:

```typescript
fields.push({
  alias: param.alias,
  label: param.label || param.alias,
  fieldName: param.fieldName,
  nodeTitle,
  paramType: param.paramType || 'text',
});
```

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/pages/WorkflowListPage.vue
git commit -m "feat: show file inputs for media params in execute dialog"
```

---

### Task 9: Update frontend param editing pages

**Files:**
- Modify: `packages/client/src/pages/WorkflowDetailPage.vue`
- Modify: `packages/client/src/pages/WorkflowEditPage.vue`

- [ ] **Step 1: Show paramType in WorkflowDetailPage**

In `packages/client/src/pages/WorkflowDetailPage.vue`, in the params list, add a column or chip for paramType:

```vue
<v-chip size="small" color="primary" variant="tonal">
  {{ param.paramType || 'text' }}
</v-chip>
```

- [ ] **Step 2: Update WorkflowEditPage's addParam to include param_type**

If WorkflowEditPage has parameter editing, update it. After reviewing the code, it appears WorkflowEditPage handles JSON import and param editing is in WorkflowDetailPage. So just update WorkflowDetailPage.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/pages/WorkflowDetailPage.vue
git commit -m "feat: show param type in workflow detail page"
```

---

### Task 10: TypeScript verification and final testing

**Files:** All modified files.

- [ ] **Step 1: Run backend typecheck**

Run: `pnpm --filter server exec tsc --noEmit`

Expected: No type errors.

- [ ] **Step 2: Run frontend typecheck**

Run: `pnpm --filter client exec tsc --noEmit`

Expected: No type errors.

- [ ] **Step 3: Run all backend tests**

Run: `pnpm --filter server test`

Expected: All tests pass.

- [ ] **Step 4: Final commit**

```bash
git commit -m "chore: finalize media upload and execute feature"
```

---

### Spec Coverage Check

| Spec requirement | Task |
|---|---|
| `param_type` column in `workflow_params` | Task 1 |
| Upload service for ComfyUI | Task 2 |
| `processMediaParams()` in executor | Task 3 |
| Multipart handling in execute controller | Task 5 |
| Multer middleware on execute route | Task 6 |
| Frontend `WorkflowParam` type update | Task 7 |
| Frontend FormData API | Task 7 |
| Frontend file inputs in execute dialog | Task 8 |
| Frontend param type display | Task 9 |
| Backward compatibility (JSON body) | Task 5 (falls through to existing path) |
