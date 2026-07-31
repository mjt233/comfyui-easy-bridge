# Workflow Attachments & Import/Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support workflow-bound attachments (upload/download/delete) and multi-select ZIP export / batch import (including attachments, params).

**Architecture:** New `workflow_attachments` table + `attachment.service.ts` for file-backed CRUD. New `workflow-io.service.ts` (jszip) for export/import. Extend workflow controller/routes. Frontend: attachments section in `WorkflowEditPage.vue`, multi-select + export/import in `WorkflowListPage.vue`.

**Tech Stack:** jszip (backend ZIP), multer (multipart upload), Vue 3 + Vuetify (frontend).

---

### Task 1: Install jszip and update DB schema

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/models/schema.ts`
- Modify: `packages/server/src/models/db.ts`

- [ ] **Step 1: Install jszip**
  Run: `pnpm --filter server add jszip && pnpm --filter server add -D @types/jszip`

- [ ] **Step 2: Add `workflowAttachments` table to schema.ts**

```typescript
export const workflowAttachments = sqliteTable('workflow_attachments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  storedName: text('stored_name').notNull(),
  size: integer('size').notNull(),
  mimetype: text('mimetype'),
  createdAt: text('created_at').notNull(),
});
```

- [ ] **Step 3: Add CREATE TABLE IF NOT EXISTS to db.ts**

### Task 2: Create `attachment.service.ts` + tests

**Files:**
- Create: `packages/server/src/services/attachment.service.ts`
- Create: `packages/server/src/services/attachment.service.test.ts`

- CRUD + disk file management (list/create/getById/readBuffer/delete/deleteByWorkflow)
- `DATA_DIR` overridable; auto-create dir
- Tests: temp DATA_DIR, verify files written/removed

### Task 3: Create `workflow-io.service.ts` + tests

**Files:**
- Create: `packages/server/src/services/workflow-io.service.ts`
- Create: `packages/server/src/services/workflow-io.service.test.ts`

- `exportWorkflows(ids)` → ZIP buffer (manifest.json + attachments/)
- `importWorkflows(buffer)` → summary; ID conflict → new ID + rename mapping

### Task 4: Extend controller & routes + tests

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`
- Modify: `packages/server/src/routes/workflow.routes.ts`
- Modify: `packages/server/src/routes/workflow.routes.test.ts`

- Attachment handlers: upload/list/download/delete
- export/import handlers; delete cleans attachment files
- Update test CREATE TABLE; add integration tests

### Task 5: Client types + API module

**Files:**
- Modify: `packages/client/src/types/index.ts`
- Modify: `packages/client/src/api/workflows.ts`

### Task 6: WorkflowEditPage attachments UI

**Files:**
- Modify: `packages/client/src/pages/WorkflowEditPage.vue`

### Task 7: WorkflowListPage multi-select export/import

**Files:**
- Modify: `packages/client/src/pages/WorkflowListPage.vue`

### Task 8: Verify

- `pnpm --filter server exec tsc --noEmit`
- `pnpm --filter client exec tsc --noEmit`
- `pnpm --filter server test`
