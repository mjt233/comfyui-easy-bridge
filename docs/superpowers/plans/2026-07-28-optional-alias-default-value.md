# Optional Alias + Default Value Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow editing a workflow field's default value without configuring an alias, storing the override in `workflow_params.default_value` without modifying `rawJson`.

**Architecture:** Make `alias` nullable and add `default_value` on `workflow_params`. Execution (`applyAliases`) prefers request alias values, then `default_value`, then rawJson. Frontend detail dialog makes default value editable and alias optional; without alias, `paramType` is forced to `text`. Local SQLite is rebuilt manually (no code migration).

**Tech Stack:** Node.js + Express + Drizzle (SQLite), Vue 3 + Vuetify, vitest + supertest

**Spec:** `docs/superpowers/specs/2026-07-28-optional-alias-default-value-design.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `packages/server/src/models/schema.ts` | Drizzle: nullable alias + `defaultValue` |
| `packages/server/src/models/db.ts` | CREATE TABLE for new installs |
| `packages/server/data/bridge.db` | Local DB rebuild (manual SQL) |
| `packages/server/src/services/workflow.service.ts` | add/update param validation & persistence |
| `packages/server/src/services/executor.service.ts` | applyAliases priority + skip null alias media |
| `packages/server/src/controllers/workflow.controller.ts` | HTTP validation for optional alias |
| `packages/server/src/**/*.test.ts` | In-memory DDL + unit/integration tests |
| `packages/client/src/types/index.ts` | `WorkflowParam` types |
| `packages/client/src/api/workflows.ts` | add/update param payloads |
| `packages/client/src/pages/WorkflowDetailPage.vue` | editable default, optional alias UI |
| `packages/client/src/pages/WorkflowListPage.vue` | API snippets only for non-null aliases |

---

### Task 1: Schema + local DB + test DDL

**Files:**
- Modify: `packages/server/src/models/schema.ts`
- Modify: `packages/server/src/models/db.ts`
- Modify: `packages/server/src/models/schema.test.ts`
- Modify: `packages/server/src/services/workflow.service.test.ts`
- Modify: `packages/server/src/routes/workflow.routes.test.ts`
- Modify: `packages/server/data/bridge.db` (manual)

- [ ] **Step 1: Update Drizzle schema**

In `packages/server/src/models/schema.ts`, replace `workflowParams` with:

```typescript
export const workflowParams = sqliteTable('workflow_params', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  fieldName: text('field_name').notNull(),
  /** 对外参数别名；null 表示不暴露为可传参字段 */
  alias: text('alias'),
  label: text('label'),
  paramType: text('param_type').notNull().default('text'),
  /** 默认值覆盖；null 表示使用 rawJson 原值 */
  defaultValue: text('default_value'),
}, (table) => ({
  uniqueAliasPerWorkflow: uniqueIndex('idx_unique_alias_per_workflow').on(table.workflowId, table.alias),
}));
```

- [ ] **Step 2: Update CREATE TABLE in db.ts**

In `packages/server/src/models/db.ts`, replace the `workflow_params` DDL:

```typescript
db.run(`
  CREATE TABLE IF NOT EXISTS workflow_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    alias TEXT,
    label TEXT,
    param_type TEXT NOT NULL DEFAULT 'text',
    default_value TEXT,
    UNIQUE(workflow_id, alias)
  )
`);
```

- [ ] **Step 3: Update all in-memory test DDL**

Use this exact `workflow_params` DDL in:
- `packages/server/src/models/schema.test.ts`
- `packages/server/src/services/workflow.service.test.ts`
- `packages/server/src/routes/workflow.routes.test.ts`

```sql
CREATE TABLE workflow_params (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  alias TEXT,
  label TEXT,
  param_type TEXT NOT NULL DEFAULT 'text',
  default_value TEXT,
  UNIQUE(workflow_id, alias)
);
```

Also grep for any other `CREATE TABLE workflow_params` under `packages/server` and update them the same way.

- [ ] **Step 4: Rebuild local bridge.db (preserve data)**

DB path used by server: `packages/server/data/bridge.db` (when cwd is package server).

Run from repo (PowerShell), with server stopped:

```powershell
cd packages/server
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/bridge.db');
db.pragma('foreign_keys = OFF');
db.exec(\`
BEGIN;
CREATE TABLE workflow_params_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  alias TEXT,
  label TEXT,
  param_type TEXT NOT NULL DEFAULT 'text',
  default_value TEXT,
  UNIQUE(workflow_id, alias)
);
INSERT INTO workflow_params_new (id, workflow_id, node_id, field_name, alias, label, param_type, default_value)
SELECT id, workflow_id, node_id, field_name, alias, label, param_type, NULL FROM workflow_params;
DROP TABLE workflow_params;
ALTER TABLE workflow_params_new RENAME TO workflow_params;
COMMIT;
\`);
db.pragma('foreign_keys = ON');
const cols = db.prepare('PRAGMA table_info(workflow_params)').all();
console.log(cols.map(c => c.name).join(','));
db.close();
"
```

Expected console: column list includes `alias` and `default_value` (alias no longer NOT NULL).

- [ ] **Step 5: Add schema tests for nullable alias + default_value**

Append to `packages/server/src/models/schema.test.ts`:

```typescript
  it('allows null alias and stores default_value', () => {
    const db = drizzle(sqlite, { schema });
    db.insert(schema.workflows).values({
      id: 'wf1', name: 'WF1', rawJson: '{}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    db.insert(schema.workflowParams).values({
      workflowId: 'wf1', nodeId: '1', fieldName: 'v', alias: null, defaultValue: 'override',
    }).run();
    db.insert(schema.workflowParams).values({
      workflowId: 'wf1', nodeId: '2', fieldName: 'v', alias: null, defaultValue: 'other',
    }).run();
    const params = db.select().from(schema.workflowParams).all();
    expect(params).toHaveLength(2);
    expect(params[0].defaultValue).toBe('override');
    expect(params[0].alias).toBeNull();
  });
```

- [ ] **Step 6: Run schema tests**

Run: `pnpm --filter server exec vitest run src/models/schema.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/models/schema.ts packages/server/src/models/db.ts packages/server/src/models/schema.test.ts packages/server/src/services/workflow.service.test.ts packages/server/src/routes/workflow.routes.test.ts
git commit -m "feat: allow nullable alias and default_value on workflow_params"
```

Note: do not commit `bridge.db` if gitignored.

---

### Task 2: Executor applyAliases default-value priority (TDD)

**Files:**
- Modify: `packages/server/src/services/executor.service.ts`
- Modify: `packages/server/src/services/executor.service.test.ts`

- [ ] **Step 1: Update WorkflowParam interface**

In `packages/server/src/services/executor.service.ts`:

```typescript
/**
 * 工作流参数配置（别名映射 + 可选默认值覆盖）
 */
export interface WorkflowParam {
  /** 参数行 ID */
  id: number;
  /** 所属工作流 ID */
  workflowId: string;
  /** 节点 ID */
  nodeId: string;
  /** 节点 inputs 字段名 */
  fieldName: string;
  /** 对外别名；null 表示不暴露为可传参字段 */
  alias: string | null;
  /** 展示标签 */
  label: string | null;
  /** 参数类型 text/image/video/audio */
  paramType: string;
  /** 默认值覆盖；null 表示使用 rawJson 原值 */
  defaultValue: string | null;
}
```

- [ ] **Step 2: Write failing tests for defaultValue priority**

In `packages/server/src/services/executor.service.test.ts`, update every existing param fixture to include `defaultValue: null`.

Then add:

```typescript
  it('applyAliases uses defaultValue when alias missing from request', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null, paramType: 'text', defaultValue: 'from-default' },
    ];
    const result = applyAliases(sampleJson, params, {});
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('from-default');
  });

  it('applyAliases prefers request value over defaultValue', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null, paramType: 'text', defaultValue: 'from-default' },
    ];
    const result = applyAliases(sampleJson, params, { img_desc: 'from-request' });
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('from-request');
  });

  it('applyAliases applies defaultValue without alias', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: null, label: null, paramType: 'text', defaultValue: 'only-default' },
    ];
    const result = applyAliases(sampleJson, params, {});
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('only-default');
  });

  it('applyAliases keeps rawJson when defaultValue is null and no request value', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null, paramType: 'text', defaultValue: null },
    ];
    const result = applyAliases(sampleJson, params, {});
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('original prompt');
  });
```

Also update `processMediaParams` fixtures with `defaultValue: null`, and add:

```typescript
  it('skips media params without alias', async () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '1', fieldName: 'image', alias: null, label: null, paramType: 'image', defaultValue: null },
    ];
    const files = {
      img: [{ buffer: Buffer.from('data'), originalname: 'photo.png', mimetype: 'image/png' }],
    };
    const result = await processMediaParams(params, {}, files, 'http://localhost:8188');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter server exec vitest run src/services/executor.service.test.ts`

Expected: FAIL on new defaultValue cases (and possibly type/fixture mismatches until interface updated).

- [ ] **Step 4: Implement applyAliases priority**

Replace `applyAliases` body logic with:

```typescript
/**
 * 将别名请求值与默认值覆盖注入工作流 JSON。
 * 优先级：请求别名值 > defaultValue > rawJson 原值。
 * 不修改入参 rawJson 字符串本身以外的持久化数据；返回新的 JSON 字符串。
 * @param rawJson 原始工作流 API JSON 字符串
 * @param params 参数配置列表
 * @param aliasValues 请求传入的别名值
 * @returns 注入后的工作流 JSON 字符串
 */
export function applyAliases(
  rawJson: string,
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
): string {
  const workflow = JSON.parse(rawJson);

  for (const param of params) {
    // 定位节点
    const node = workflow[param.nodeId];
    if (!node) continue;

    // 跳过节点连接（数组）
    const currentValue = node.inputs?.[param.fieldName];
    if (Array.isArray(currentValue)) continue;

    // 1) 请求值优先（仅当 alias 非空且出现在请求中）
    if (param.alias != null && param.alias !== '' && Object.prototype.hasOwnProperty.call(aliasValues, param.alias)) {
      node.inputs[param.fieldName] = aliasValues[param.alias];
      continue;
    }

    // 2) 默认值覆盖
    if (param.defaultValue != null) {
      node.inputs[param.fieldName] = param.defaultValue;
      continue;
    }

    // 3) 保留 rawJson 原值
  }

  return JSON.stringify(workflow);
}
```

- [ ] **Step 5: Skip null alias in processMediaParams**

In the loop of `processMediaParams`, after `if (param.paramType === 'text') continue;`, add:

```typescript
    // 无别名的参数不参与对外媒体上传
    if (param.alias == null || param.alias === '') continue;
```

Use `files[param.alias]` as before.

- [ ] **Step 6: Run executor tests**

Run: `pnpm --filter server exec vitest run src/services/executor.service.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/executor.service.ts packages/server/src/services/executor.service.test.ts
git commit -m "feat: apply defaultValue override when alias value missing"
```

---

### Task 3: WorkflowService optional alias + defaultValue (TDD)

**Files:**
- Modify: `packages/server/src/services/workflow.service.ts`
- Modify: `packages/server/src/services/workflow.service.test.ts`

- [ ] **Step 1: Write failing service tests**

Append to `packages/server/src/services/workflow.service.test.ts`:

```typescript
  it('adds param with only defaultValue and null alias', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      defaultValue: 'hello',
    });
    expect(param.alias).toBeNull();
    expect(param.defaultValue).toBe('hello');
    expect(param.paramType).toBe('text');
  });

  it('allows multiple null aliases in same workflow', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'a', defaultValue: '1' });
    expect(() => service.addParam({ workflowId: 'wf', nodeId: '2', fieldName: 'b', defaultValue: '2' })).not.toThrow();
  });

  it('throws when both alias and defaultValue are empty', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    expect(() => service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
    })).toThrow(/alias|defaultValue|required/i);
  });

  it('forces paramType to text when alias is null', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      defaultValue: 'x',
      paramType: 'image',
    });
    expect(param.paramType).toBe('text');
  });

  it('clears defaultValue to null on update', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      alias: 'a',
      defaultValue: 'old',
    });
    const updated = service.updateParam(p.id, { defaultValue: null });
    expect(updated.defaultValue).toBeNull();
  });

  it('throws when update removes both alias and defaultValue', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({
      workflowId: 'wf',
      nodeId: '1',
      fieldName: 'v',
      alias: 'a',
      defaultValue: 'x',
    });
    expect(() => service.updateParam(p.id, { alias: null, defaultValue: null })).toThrow(/alias|defaultValue|required/i);
  });
```

Update existing `addParam` calls that only pass alias — they remain valid.

- [ ] **Step 2: Run tests to verify fail**

Run: `pnpm --filter server exec vitest run src/services/workflow.service.test.ts`

Expected: FAIL on new cases

- [ ] **Step 3: Implement service input types and helpers**

In `packages/server/src/services/workflow.service.ts`, replace param input interfaces and methods:

```typescript
interface AddParamInput {
  /** 工作流 ID */
  workflowId: string;
  /** 节点 ID */
  nodeId: string;
  /** 字段名 */
  fieldName: string;
  /** 可选别名 */
  alias?: string | null;
  /** 可选标签 */
  label?: string;
  /** 参数类型；无 alias 时强制 text */
  paramType?: string;
  /** 默认值覆盖 */
  defaultValue?: string | null;
}

interface UpdateParamInput {
  /** 别名；可清空为 null */
  alias?: string | null;
  /** 标签 */
  label?: string | null;
  /** 参数类型 */
  paramType?: string;
  /** 默认值覆盖；可清空为 null */
  defaultValue?: string | null;
}

/**
 * 规范化别名：空字符串视为 null
 * @param alias 原始别名
 * @returns 规范化后的别名
 */
function normalizeAlias(alias: string | null | undefined): string | null {
  if (alias == null) return null;
  const trimmed = alias.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 解析最终 paramType：无 alias 时强制 text
 * @param alias 规范化别名
 * @param paramType 请求类型
 * @returns 最终类型
 */
function resolveParamType(alias: string | null, paramType?: string): string {
  if (alias == null) return 'text';
  return paramType ?? 'text';
}
```

- [ ] **Step 4: Implement addParam**

```typescript
  /**
   * 新增工作流参数配置
   * @param input 参数输入
   * @returns 新建的参数行
   */
  addParam(input: AddParamInput) {
    const alias = normalizeAlias(input.alias);
    const defaultValue = input.defaultValue === undefined ? null : input.defaultValue;

    // 至少需要 alias 或 defaultValue 之一
    if (alias == null && defaultValue == null) {
      throw new Error('Either alias or defaultValue is required');
    }

    const paramType = resolveParamType(alias, input.paramType);

    this.db.insert(schema.workflowParams).values({
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      fieldName: input.fieldName,
      alias,
      label: input.label ?? null,
      paramType,
      defaultValue,
    }).run();

    // 按主键回查：alias 可能为 null，不能仅靠 alias 查询
    return this.db.select().from(schema.workflowParams)
      .where(and(
        eq(schema.workflowParams.workflowId, input.workflowId),
        eq(schema.workflowParams.nodeId, input.nodeId),
        eq(schema.workflowParams.fieldName, input.fieldName),
      ))
      .get()!;
  }
```

- [ ] **Step 5: Implement updateParam**

```typescript
  /**
   * 更新参数配置
   * @param id 参数行 ID
   * @param input 更新字段
   * @returns 更新后的参数行
   */
  updateParam(id: number, input: UpdateParamInput) {
    const existing = this.db.select().from(schema.workflowParams)
      .where(eq(schema.workflowParams.id, id))
      .get();
    if (!existing) {
      throw new Error('Param not found');
    }

    const nextAlias = input.alias !== undefined ? normalizeAlias(input.alias) : existing.alias;
    const nextDefault = input.defaultValue !== undefined ? input.defaultValue : existing.defaultValue;

    if (nextAlias == null && nextDefault == null) {
      throw new Error('Either alias or defaultValue is required');
    }

    const nextType = resolveParamType(
      nextAlias,
      input.paramType !== undefined ? input.paramType : existing.paramType,
    );

    this.db.update(schema.workflowParams)
      .set({
        alias: nextAlias,
        label: input.label !== undefined ? input.label : existing.label,
        paramType: nextType,
        defaultValue: nextDefault,
      })
      .where(eq(schema.workflowParams.id, id))
      .run();

    return this.db.select().from(schema.workflowParams)
      .where(eq(schema.workflowParams.id, id))
      .get()!;
  }
```

- [ ] **Step 6: Run service tests**

Run: `pnpm --filter server exec vitest run src/services/workflow.service.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/workflow.service.ts packages/server/src/services/workflow.service.test.ts
git commit -m "feat: support optional alias and defaultValue in WorkflowService"
```

---

### Task 4: Controller + route tests

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`
- Modify: `packages/server/src/routes/workflow.routes.test.ts`

- [ ] **Step 1: Update addParam controller validation**

In `createWorkflowController` → `addParam`:

```typescript
    addParam(req: Request, res: Response): void {
      const id = req.params.id as string;
      const existing = workflowService.getById(id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const { nodeId, fieldName, alias, label, paramType, defaultValue } = req.body;
      if (!nodeId || !fieldName) {
        res.status(400).json({ error: 'nodeId and fieldName are required', code: 'missing_parameter' });
        return;
      }
      // 空字符串 alias 视为未提供
      const normalizedAlias = typeof alias === 'string' && alias.trim() === '' ? null : alias ?? null;
      const hasDefault = defaultValue !== undefined && defaultValue !== null;
      if (normalizedAlias == null && !hasDefault) {
        res.status(400).json({ error: 'alias or defaultValue is required', code: 'missing_parameter' });
        return;
      }
      try {
        const param = workflowService.addParam({
          workflowId: id,
          nodeId,
          fieldName,
          alias: normalizedAlias,
          label,
          paramType,
          defaultValue: defaultValue === undefined ? null : defaultValue,
        });
        res.status(201).json(param);
      } catch (err: unknown) {
        if (err instanceof Error && err.message?.includes('UNIQUE constraint failed')) {
          res.status(409).json({ error: 'Alias already exists', code: 'alias_conflict' });
          return;
        }
        if (err instanceof Error && /alias|defaultValue|required/i.test(err.message)) {
          res.status(400).json({ error: err.message, code: 'missing_parameter' });
          return;
        }
        throw err;
      }
    },
```

- [ ] **Step 2: Update updateParam controller**

```typescript
    updateParam(req: Request, res: Response): void {
      try {
        const body = { ...req.body } as {
          alias?: string | null;
          label?: string | null;
          paramType?: string;
          defaultValue?: string | null;
        };
        if (typeof body.alias === 'string' && body.alias.trim() === '') {
          body.alias = null;
        }
        const param = workflowService.updateParam(Number(req.params.paramId), body);
        res.json(param);
      } catch (err: unknown) {
        if (err instanceof Error && err.message?.includes('UNIQUE constraint failed')) {
          res.status(409).json({ error: 'Alias already exists', code: 'alias_conflict' });
          return;
        }
        if (err instanceof Error && /alias|defaultValue|required|not found/i.test(err.message)) {
          res.status(400).json({ error: err.message, code: 'missing_parameter' });
          return;
        }
        throw err;
      }
    },
```

- [ ] **Step 3: Add route integration tests**

Append to `packages/server/src/routes/workflow.routes.test.ts` (reuse login pattern):

```typescript
  it('POST /params with only defaultValue succeeds', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'wf-default', name: 'D', rawJson: '{}' });

    const res = await supertest(app)
      .post('/api/workflows/wf-default/params')
      .set('Authorization', `Bearer ${token}`)
      .send({ nodeId: '1', fieldName: 'value', defaultValue: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.alias).toBeNull();
    expect(res.body.defaultValue).toBe('hello');
    expect(res.body.paramType).toBe('text');
  });

  it('POST /params without alias and defaultValue returns 400', async () => {
    const loginRes = await supertest(app).post('/api/auth/login').send({ password: '0d000721' });
    const token = loginRes.body.token as string;

    await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'wf-empty-param', name: 'E', rawJson: '{}' });

    const res = await supertest(app)
      .post('/api/workflows/wf-empty-param/params')
      .set('Authorization', `Bearer ${token}`)
      .send({ nodeId: '1', fieldName: 'value' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('missing_parameter');
  });
```

- [ ] **Step 4: Run route + full server tests**

Run: `pnpm --filter server test`

Expected: PASS

- [ ] **Step 5: Typecheck server**

Run: `pnpm --filter server exec tsc --noEmit`

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/controllers/workflow.controller.ts packages/server/src/routes/workflow.routes.test.ts
git commit -m "feat: accept optional alias and defaultValue in param APIs"
```

---

### Task 5: Frontend types, API, Detail page UI

**Files:**
- Modify: `packages/client/src/types/index.ts`
- Modify: `packages/client/src/api/workflows.ts`
- Modify: `packages/client/src/pages/WorkflowDetailPage.vue`
- Modify: `packages/client/src/pages/WorkflowListPage.vue`

- [ ] **Step 1: Update client WorkflowParam type**

In `packages/client/src/types/index.ts`:

```typescript
/**
 * 工作流参数配置
 */
export interface WorkflowParam {
  /** 参数行 ID */
  id: number;
  /** 工作流 ID */
  workflowId: string;
  /** 节点 ID */
  nodeId: string;
  /** 字段名 */
  fieldName: string;
  /** 对外别名；null 表示仅默认值覆盖 */
  alias: string | null;
  /** 展示标签 */
  label: string | null;
  /** 参数类型 */
  paramType: string;
  /** 默认值覆盖；null 表示使用 rawJson 原值 */
  defaultValue: string | null;
}
```

- [ ] **Step 2: Update API helpers**

In `packages/client/src/api/workflows.ts`:

```typescript
/**
 * 新增工作流参数
 * @param workflowId 工作流 ID
 * @param data 参数数据（alias 可选）
 */
export async function addParam(
  workflowId: string,
  data: {
    nodeId: string;
    fieldName: string;
    alias?: string | null;
    label?: string;
    paramType?: string;
    defaultValue?: string | null;
  },
) {
  const res = await client.post(`/workflows/${workflowId}/params`, data);
  return res.data;
}

/**
 * 更新工作流参数
 * @param workflowId 工作流 ID
 * @param paramId 参数 ID
 * @param data 可更新字段
 */
export async function updateParam(
  workflowId: string,
  paramId: number,
  data: Partial<{
    alias: string | null;
    label: string;
    paramType: string;
    defaultValue: string | null;
  }>,
) {
  const res = await client.put(`/workflows/${workflowId}/params/${paramId}`, data);
  return res.data;
}
```

- [ ] **Step 3: Update FieldInfo + parseNodes in WorkflowDetailPage**

In `WorkflowDetailPage.vue` script:

```typescript
interface FieldInfo {
  /** 字段名 */
  name: string;
  /** rawJson 中的原始默认值（字符串化） */
  rawValue: string;
  /** 当前生效展示值（覆盖优先） */
  value: string;
  /** 别名 */
  alias: string;
  /** 标签 */
  label: string;
  /** 已保存参数 ID */
  paramId: number | null;
  /** 参数类型 */
  paramType: string;
  /** 已保存的默认值覆盖 */
  defaultValue: string | null;
}
```

In `parseNodes`, when pushing fields:

```typescript
        const rawValue = String(fieldVal);
        const existing = paramMap.get(`${nodeId}:${fieldName}`);
        const override = existing?.defaultValue ?? null;
        fields.push({
          name: fieldName,
          rawValue,
          value: override != null ? override : rawValue,
          alias: existing?.alias ?? '',
          label: existing?.label ?? '',
          paramId: existing?.id ?? null,
          paramType: existing?.paramType ?? 'text',
          defaultValue: override,
        });
```

- [ ] **Step 4: Update dialog state and openDialog**

```typescript
const dialog = ref({
  show: false,
  node: null as NodeField | null,
  fieldName: '',
  /** 可编辑的默认值输入 */
  fieldValue: '',
  /** rawJson 原始值，用于比较是否清除覆盖 */
  rawValue: '',
  alias: '',
  label: '',
  paramId: null as number | null,
  paramType: 'text',
  saving: false,
});

function openDialog(node: NodeField, info: FieldInfo) {
  dialog.value = {
    show: true,
    node,
    fieldName: info.name,
    fieldValue: info.value,
    rawValue: info.rawValue,
    alias: info.alias,
    label: info.label,
    paramId: info.paramId,
    paramType: info.paramType || 'text',
    saving: false,
  };
}
```

- [ ] **Step 5: Update dialog template**

- 默认值 `v-textarea`：去掉 `readonly`，改为 `v-model="dialog.fieldValue"`，可加 hint「与原始值相同则清除覆盖」
- 别名 label 改为「接口字段别名（可选）」
- 参数类型：

```vue
          <v-select
            v-model="dialog.paramType"
            label="参数类型"
            :items="['text', 'image', 'video', 'audio']"
            density="compact"
            variant="outlined"
            hide-details
            :disabled="!dialog.alias.trim()"
          />
```

- 保存按钮：允许无 alias 时保存（只要有覆盖或已有配置变更）

```vue
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!dialog.fieldName || dialog.saving || !canSaveDialog"
            :loading="dialog.saving"
            @click="saveDialog"
          >
            保存
          </v-btn>
```

```typescript
/**
 * 是否允许保存当前对话框
 */
const canSaveDialog = computed(() => {
  const alias = dialog.value.alias.trim();
  const defaultValue = dialog.value.fieldValue === dialog.value.rawValue
    ? null
    : dialog.value.fieldValue;
  // 新建：至少 alias 或有效覆盖
  if (!dialog.value.paramId) {
    return alias !== '' || defaultValue != null;
  }
  // 已有配置：允许保存（若两者皆空则走删除提示）
  return true;
});
```

Watch alias 清空时强制 paramType：

```typescript
import { ref, computed, onMounted, watch } from 'vue';

watch(
  () => dialog.value.alias,
  (alias) => {
    if (!alias.trim()) {
      dialog.value.paramType = 'text';
    }
  },
);
```

- [ ] **Step 6: Implement saveDialog**

```typescript
/**
 * 保存对话框中的参数配置
 */
async function saveDialog() {
  if (!workflow.value || !dialog.value.node || !dialog.value.fieldName) return;

  const alias = dialog.value.alias.trim() || null;
  const defaultValue = dialog.value.fieldValue === dialog.value.rawValue
    ? null
    : dialog.value.fieldValue;
  const paramType = alias ? dialog.value.paramType : 'text';

  // 无有效配置：已有行则删除，新建则忽略
  if (alias == null && defaultValue == null) {
    if (dialog.value.paramId) {
      await deleteFromDialog();
      return;
    }
    snackbar.value = { show: true, text: '请填写别名或修改默认值', color: 'error' };
    return;
  }

  dialog.value.saving = true;
  try {
    const node = dialog.value.node;
    const info = getNodeByField(node, dialog.value.fieldName);
    if (info?.paramId) {
      await updateParam(workflow.value.id, info.paramId, {
        alias,
        label: dialog.value.label,
        paramType,
        defaultValue,
      });
    } else {
      await addParam(workflow.value.id, {
        nodeId: node.nodeId,
        fieldName: dialog.value.fieldName,
        alias,
        label: dialog.value.label,
        paramType,
        defaultValue,
      });
    }
    snackbar.value = { show: true, text: '保存成功', color: 'success' };
    dialog.value.show = false;
    await load();
  } catch {
    snackbar.value = { show: true, text: '保存失败，别名可能重复', color: 'error' };
  } finally {
    dialog.value.saving = false;
  }
}
```

- [ ] **Step 7: Chip/list display for default-only params**

In chip template, treat `paramId` as configured (already). For alias display when empty:

```vue
                      <span v-if="info.paramId && info.label">{{ info.alias || info.name }}</span>
                      <span v-else-if="info.paramId && !info.alias">{{ info.name }}</span>
                      <span v-else>{{ info.name }}</span>
```

In list alias column, when `paramId` but no alias:

```vue
                  <v-chip
                    v-if="item.paramId"
                    size="small"
                    color="primary"
                    variant="flat"
                  >
                    {{ item.alias || '仅默认值' }}
```

Default value column already binds `item.value` (effective value).

- [ ] **Step 8: Filter null aliases in WorkflowListPage API snippets**

Where `apiParams` is assigned from workflow params, filter:

```typescript
apiParams.value = (params ?? []).filter((p) => p.alias != null && p.alias !== '');
```

In `genJsonSnippet` / `buildApiCode`, if any remaining code uses `p.alias` non-null assertion is fine after filter. If TypeScript complains about `string | null`, narrow with filter type guard:

```typescript
function hasAlias(p: WorkflowParam): p is WorkflowParam & { alias: string } {
  return p.alias != null && p.alias !== '';
}
```

- [ ] **Step 9: Typecheck client**

Run: `pnpm --filter client exec tsc --noEmit`

Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add packages/client/src/types/index.ts packages/client/src/api/workflows.ts packages/client/src/pages/WorkflowDetailPage.vue packages/client/src/pages/WorkflowListPage.vue
git commit -m "feat: edit default values without alias in workflow detail"
```

---

### Task 6: Full verification

**Files:** none (verify only)

- [ ] **Step 1: Run all server tests**

Run: `pnpm --filter server test`

Expected: all PASS

- [ ] **Step 2: Server tsc**

Run: `pnpm --filter server exec tsc --noEmit`

Expected: exit 0

- [ ] **Step 3: Client tsc**

Run: `pnpm --filter client exec tsc --noEmit`

Expected: exit 0

- [ ] **Step 4: Manual smoke (optional if server running)**

1. Open workflow detail → edit a field default only → save  
2. Confirm chip/list shows configured without alias  
3. Execute workflow without that field in body → ComfyUI prompt uses override  
4. Set default back to original → save → override cleared  
5. Without alias, param type select disabled  

- [ ] **Step 5: Final commit if any fixups**

```bash
git add -A
git commit -m "test: verify optional alias default value feature"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| nullable alias + default_value column | Task 1 |
| local DB rebuild, no code migration | Task 1 Step 4 |
| applyAliases priority | Task 2 |
| media skip without alias | Task 2 |
| service validation / force text | Task 3 |
| API optional alias | Task 4 |
| frontend editable default, optional alias | Task 5 |
| clear override when equals raw | Task 5 Step 6 |
| no alias → paramType text only | Task 5 Steps 5–6 |
| API docs snippets ignore null alias | Task 5 Step 8 |
| tsc + tests | Task 6 |

## Placeholder / consistency review

- Types use `defaultValue` (camelCase) in TS; DB column `default_value` via Drizzle  
- `alias: string | null` consistent across server interface, client type, tests  
- Empty string alias normalized to `null` in service + controller + frontend  
- No TBD/TODO left in steps  
