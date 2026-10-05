# 架构与开发约定

> 本文是仓库结构、后端分层与依赖注入、前端约定、测试约定与模块索引的完整说明。
> `AGENTS.md` 只保留摘要与指引，实现细节以本文为准。
>
> 相关文档：[认证与鉴权](auth.md)、[执行提供商](execution-providers.md)、
> [任务调度与队列](task-scheduling.md)、[数据库与迁移](database.md)、[错误码](error-codes.md)。

## 1. 仓库结构

pnpm workspace（Monorepo），根 `package.json` 只提供转发脚本，业务代码在两个包内：

```
packages/server/   Express 后端（TypeScript + Drizzle ORM）
  src/
    index.ts          应用装配：中间件、路由挂载、静态托管、启动
    routes/           URL 路径定义 → controller（工厂函数 createXxxRoutes(db)）
    controllers/      参数校验 → service
    services/         业务逻辑
    middleware/       认证中间件、错误处理
    models/           Drizzle schema + DB 连接 + 版本化迁移
packages/client/   Vue 3 + Vuetify 前端（TypeScript + Vite）
  src/
    App.vue           <v-app> + <v-main> 包裹 <router-view />
    pages/            页面组件（每个路由一个页面）
    components/       可复用组件（含 workflow-canvas / build-script 子目录）
    api/              axios 封装（client.ts）+ 各领域 API 模块
    router/           路由配置（web history、懒加载页面、登录守卫）
    types/ utils/     共享类型与工具函数
```

- 前端开发服务器：Vite（端口 5173），`/api` 代理到 `http://localhost:10721`
- 前端路径别名：`@` → `packages/client/src`（`vite.config.ts` 的 `resolve.alias`）
- 生产由后端 Express 托管前端构建产物（见 §3）

## 2. 后端分层与依赖注入

**依赖方向**：`routes → controllers → services → models (Drizzle)`，不跨层调用。

- 每个路由文件导出工厂函数 `createXxxRoutes(db)`，接收 Drizzle 实例
- Controller / Service 之间通过**闭包注入 `db`**，不使用全局单例
  （例外：`models/db.ts` 导出的进程级 `db` 实例由 `index.ts` 装配时注入）
- Service 抛出带语义的错误信息，由 `middleware/errorHandler.ts` 统一映射为错误码响应
- 路由注册顺序：**静态路径必须早于 `:id` 动态路由**注册
  （如 `/build-api.d.ts`、`/node-info`、`/export`、`/import`、`/batch-delete` 在 `/:id` 之前；
  `POST /api/providers/test` 在 `/:id` 之前），否则会被当作 ID 捕获

### 2.1 请求处理链路

```
Express app (index.ts)
  helmet（CSP 放宽媒体来源）→ cors → express.json
  → /api/<domain> 路由工厂 → auth 中间件（按端点选择性挂载）
  → controller（参数校验、错误码）
  → service（业务逻辑、Drizzle 访问）
  → errorHandler（兜底映射错误码）
```

## 3. 服务端启动与静态托管

`packages/server/src/index.ts`：

- 启动顺序：`ensureDefaultPassword` → 注册进程级错误处理 → 清理过期任务暂存目录 →
  `startExecutionService`（调度器 + 健康巡检）→ `listen(0.0.0.0)`
- 监听 `0.0.0.0`，启动后打印本机与局域网访问 URL
- 前端产物解析顺序：`CLIENT_DIST` 环境变量 → `packages/client/dist` → `<cwd>/client/dist`；
  命中 `index.html` 才启用静态托管，并以 history 回退把非 `/api` 的 GET 请求交给 `index.html`
- 进程级 `uncaughtException` / `unhandledRejection` **只打印不退出**，避免一次异常丢失在途任务
- 启动被 `process.env.VITEST !== 'true'` 守卫，测试导入模块时不会监听端口

### 3.1 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `10721` | 服务端口 |
| `DATA_DIR` | `<cwd>/data` | 数据库 / 附件 / 任务暂存目录 |
| `JWT_SECRET` | 内置开发密钥 | 生产**必须**设置（见 [认证](auth.md)） |
| `CLIENT_DIST` | 自动探测 | 前端构建产物目录 |
| `VITEST` | — | 值为 `'true'` 时不启动 HTTP 服务（由 vitest 设置） |

## 4. 前端约定

- **布局**：`<v-main>` 只在 `App.vue` 中包裹 `<router-view />`；
  **每个页面自带自己的 `<v-app-bar color="primary">`**，不在全局重复
- **页面**：`pages/` 下一个路由一个组件，路由懒加载（`() => import(...)`）
- **导入**：页面 / 组件统一使用 `@/` 别名
- **HTTP**：统一走 `api/client.ts` 的 axios 实例（自动附加 Token、401 统一处理），
  各领域 API 模块放在 `api/` 下，不在组件内直接调用 axios
- **注释**：Vue 组件的 props / watch 需有 JSDoc（见 `AGENTS.md` 编码约束）

### 4.1 路由与页面

| 路径 | 页面 |
|---|---|
| `/login` | `LoginPage.vue` |
| `/admin` | `WorkflowListPage.vue` |
| `/admin/workflow/new`、`/admin/workflow/:id/edit` | `WorkflowEditPage.vue` |
| `/admin/workflow/:id` | `WorkflowDetailPage.vue` |
| `/admin/tasks` | `TaskListPage.vue` |
| `/admin/tags` | `TagManagementPage.vue` |
| `/admin/settings` | `SettingsPage.vue` |
| `/:pathMatch(.*)*` | 重定向 `/admin` |

## 5. 测试约定

- 测试框架：vitest（仅后端）；集成测试用 supertest + express 子应用（**不监听端口**）
- 数据库：统一 `:memory:` SQLite 实例，不依赖磁盘文件
- 文件命名：`*.test.ts`，与**被测试文件放在同一目录**
- 单元测试直接导入模块（`services/*.test.ts`），路由级集成测试放 `routes/*.routes.test.ts`
- 服务端启动被 `VITEST` 守卫，测试导入 `index.ts` 不会监听端口
- 鉴权相关用例可写入 `settings.auth_enabled='0'` 关闭鉴权，聚焦业务行为

### 5.1 类型验证

修改代码后执行（命令速查见 `AGENTS.md`「验证」小节）：

- 后端：`pnpm --filter server exec tsc --noEmit`
- 前端：`pnpm --filter client exec vue-tsc --noEmit`
  —— Vue SFC **必须**用 `vue-tsc`（等价于 `build:client` 的第一步）；纯 `tsc` 无法解析 `*.vue` 导入，
  会报 `Cannot find module './App.vue'`，与本仓库的 `vite-env.d.ts`（仅引用 `vite/client`、无 `*.vue` shim）有关

## 6. 模块索引

### 6.1 后端 services

| 模块 | 职责 |
|---|---|
| `workflow.service.ts` | 工作流 CRUD、参数（别名）管理 |
| `workflow-io.service.ts` | 工作流导入 / 导出（zip 批量） |
| `workflow-tag.service.ts` | 工作流标签关联与元数据校验 |
| `tag.service.ts` | 标签树 CRUD（预设只读、层级约束） |
| `executor.service.ts` | 别名注入、媒体参数处理、上传文件收集（执行与预览共用） |
| `build.service.ts` / `build.worker.ts` / `build-script-api.ts` | 动态构建脚本的沙箱执行与类型声明 |
| `node-info.service.ts` | 从 ComfyUI `/object_info` 取节点信息（供脚本类型提示） |
| `dispatcher.service.ts` | 统一队列调度器（见 [任务调度](task-scheduling.md)） |
| `execution.service.ts` | 执行服务装配：健康巡检 + 调度器 + 按实例的任务跟踪器 |
| `task.service.ts` | 任务日志读写、队列查询、实际执行实例回填 |
| `task-staging.service.ts` | 任务媒体暂存（写入 / 读取 / 释放 / 过期清理） |
| `cleanup.service.ts` | 上传资产清理（终态 / 预览两种场景） |
| `upload.service.ts` / `attachment.service.ts` | 媒体上传与附件存取 |
| `settings.service.ts` | `settings` 表读写 |
| `auth.service.ts` | 密码校验 / 改密、JWT 签发与校验、鉴权开关 |
| `param.types.ts` / `param-candidates.ts` | 参数类型定义与候选项处理 |
| `services/providers/*` | 执行提供商实现与解析（见 [执行提供商](execution-providers.md)） |

### 6.2 后端 controllers / routes

| 模块 | 职责 |
|---|---|
| `controllers/workflow.controller.ts` | 工作流 CRUD、参数、标签、导入导出、附件、`execute`、`simulateBuild` |
| `controllers/task.controller.ts` | 任务列表 / 详情、改派、插队、取消、输出回源与下载 |
| `controllers/providers.controller.ts` | 提供商 CRUD、连通性测试、健康快照 |
| `controllers/settings.controller.ts` | 设置读取 / 更新（默认实例切换触发执行服务重建） |
| `controllers/tags.controller.ts` | 标签 CRUD |
| `controllers/auth.controller.ts` | 登录、状态、改密 |

### 6.3 前端

| 模块 | 职责 |
|---|---|
| `api/client.ts` | axios 实例：Token 注入、401 跳转 |
| `api/workflows.ts` / `tasks.ts` / `providers.ts` / `tags.ts` / `settings.ts` / `auth.ts` | 各领域请求封装 |
| `pages/TaskListPage.vue` | 【待调度】/【已提交】两页签、改派与插队弹窗、详情弹窗 |
| `pages/WorkflowDetailPage.vue` | 工作流详情、执行对话框、API 文档弹窗、输出预览 |
| `pages/WorkflowEditPage.vue` | 工作流 JSON 编辑、参数别名、动态构建脚本、附件 |
| `components/workflow-canvas/*` | 工作流节点画布（Vue Flow） |
| `components/build-script/*` | 构建脚本编辑器、模拟运行、节点参考 |
| `utils/download.ts` / `concurrency.ts` / `candidates.ts` | 产物下载（proxy / direct）、并发控制、候选项处理 |
