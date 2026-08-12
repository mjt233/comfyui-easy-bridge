# 执行对话框本次执行字段类型覆盖 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在执行工作流对话框内支持「仅本次执行」的字段类型覆盖，并为媒体字段提供「上传文件 / 输入值」双模式，且不修改工作流持久化配置。

**Architecture:** 后端在 execute 请求中接收可选 `paramTypeOverrides`（别名→类型），在动态构建后应用于运行参数 `paramType`，使现有上传/注入/清理管线自动使用覆盖类型；同时修复 `collectUploadedFilenames` 仅收集真正上传的文件。前端每个已配置字段加类型下拉（仅本次有效），媒体字段加文件/文本模式切换。

**Tech Stack:** Express + TypeScript + Drizzle ORM / Vue 3 + Vuetify / vitest + supertest

---

## 文件结构

- 修改 `packages/server/src/services/executor.service.ts` — 新增 `applyParamTypeOverrides`；修复 `collectUploadedFilenames`
- 修改 `packages/server/src/controllers/workflow.controller.ts` — execute/simulate 解析并应用覆盖、传 files 给 collectUploadedFilenames
- 测试 `packages/server/src/services/executor.service.test.ts` / `packages/server/src/routes/workflow.routes.test.ts`
- 修改 `packages/client/src/api/workflows.ts` — `executeWorkflow` 增加 paramTypeOverrides
- 修改 `packages/client/src/pages/WorkflowListPage.vue` — 类型下拉 + 媒体双模式 + 提交逻辑

---

### Task 1: 后端 `executor.service.ts` 新增覆盖与清理修复

**Files:**
- Modify: `packages/server/src/services/executor.service.ts`
- Test: `packages/server/src/services/executor.service.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `executor.service.test.ts` 新增：
  - `applyParamTypeOverrides` 合法覆盖生效、非法类型忽略、无别名忽略、返回新数组不改原参数
  - `collectUploadedFilenames` 增加 files 参数：媒体别名无文件（文本值）不收集，有文件才收集
- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 `applyParamTypeOverrides`**（白名单 `text/boolean/number/image/video/audio`，仅非空 alias）
- [ ] **Step 4: 修复 `collectUploadedFilenames`** — 第三参 `files`，仅收集 `files[alias]` 非空的媒体别名
- [ ] **Step 5: 运行测试通过**
- [ ] **Step 6: 提交**

### Task 2: 后端 `workflow.controller.ts` 解析与应用覆盖

**Files:**
- Modify: `packages/server/src/controllers/workflow.controller.ts`

- [ ] **Step 1: execute 解析覆盖** — multipart 读 `req.body.paramTypeOverrides`（JSON 字符串）；JSON 从 body 提取保留键
- [ ] **Step 2: 动态构建后应用覆盖** — `effectiveParams = applyParamTypeOverrides(effectiveParams, paramTypeOverrides)`
- [ ] **Step 3: 两处 collectUploadedFilenames 调用补传 files**（execute 传 uploadedFiles，simulate 传 filesMeta）
- [ ] **Step 4: `pnpm --filter server exec tsc --noEmit` 通过**
- [ ] **Step 5: 提交**

### Task 3: 后端路由集成测试

**Files:**
- Test: `packages/server/src/routes/workflow.routes.test.ts`

- [ ] **Step 1: 写失败测试** — JSON 模式 text→image 传文件被上传并注入；multipart 模式 image→video 上传到 video 端点；覆盖不持久化
- [ ] **Step 2: 运行测试通过**
- [ ] **Step 3: 提交**

### Task 4: 前端 API 客户端

**Files:**
- Modify: `packages/client/src/api/workflows.ts`

- [ ] **Step 1: `executeWorkflow` 增加 `paramTypeOverrides?: Record<string, string>`** — 无覆盖不发；JSON 模式放保留键；multipart 追加表单字段
- [ ] **Step 2: `pnpm --filter client exec tsc --noEmit` 通过**
- [ ] **Step 3: 提交**

### Task 5: 前端执行对话框

**Files:**
- Modify: `packages/client/src/pages/WorkflowListPage.vue`

- [ ] **Step 1: ExecuteField 增加 `overrideType` / `mediaMode` 字段**，初始化 overrideType = paramType
- [ ] **Step 2: 模板** — 每个字段行加类型下拉（6 类型）；输入控件按 overrideType 渲染；媒体字段加文件/文本模式切换
- [ ] **Step 3: confirmExecute** — 按 overrideType 组装 aliasValues/files，收集 paramTypeOverrides 提交
- [ ] **Step 4: `pnpm --filter client exec tsc --noEmit` 通过**
- [ ] **Step 5: 提交**

### Task 6: 全量验证

- [ ] **Step 1: 运行 `pnpm test`（后端全部测试）**
- [ ] **Step 2: 前后端 tsc 均通过**
- [ ] **Step 3: 提交**
