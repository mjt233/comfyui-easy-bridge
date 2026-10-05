# AGENTS.md

本文件是编码代理的工作指引：只保留**编码约束、验证方式、常用命令与文档索引**。
业务细节（认证、执行提供商、任务调度、数据库、错误码等）一律在 [`docs/`](docs/) 下，
修改代码前请按文末 [文档索引](#文档索引) 查阅对应文档。

## 编码约束

- 避免使用 `any` 类型
- 所有类/对象、类/对象的字段、方法/函数、interface、type、Vue组件的props和watch都需要有详细的jsdoc注释
- 生成的代码中，每个关键步骤需要有行内注释，新生成的函数需要有jsdoc注释
- 涉及异步的函数优先使用async / await

## 验证

修改代码后需要执行以下命令进行TypeScript类型验证：
- 验证后端 `pnpm --filter server exec tsc --noEmit`
- 验证前端 `pnpm --filter client exec vue-tsc --noEmit`
  （Vue SFC 必须用 `vue-tsc`；纯 `tsc` 无法解析 `*.vue` 导入，会报 `Cannot find module './App.vue'`）

## 技术栈

- 后端: Node.js + Express + TypeScript + Drizzle ORM (SQLite)
- 前端: Vue 3 + Vuetify + TypeScript + Vite
- 包管理: pnpm workspace (Monorepo)
- 测试: vitest + supertest

## 项目结构

```
packages/server/   Express 后端
  src/
    routes/        URL 路径定义 → controller
    controllers/   参数校验 → service
    services/      业务逻辑（providers/ 为执行提供商实现）
    middleware/    认证中间件、错误处理
    models/        Drizzle schema + DB 连接 + 版本化迁移
packages/client/   Vue 3 + Vuetify 前端
  src/
    pages/         每个路由一个页面组件
    components/    可复用组件（workflow-canvas / build-script 等）
    api/           axios 封装 (client.ts) + API 模块
    router/        路由配置 (web history, lazy loaded pages)
```

## 常用命令

```bash
pnpm dev:server        # tsx watch 开发
pnpm dev:client        # Vite HMR 开发 (代理 /api → localhost:10721)
pnpm test              # vitest (仅后端)
pnpm build:server      # tsc 编译
pnpm build:client      # vue-tsc --noEmit && vite build
pnpm --filter server test          # 仅运行后端测试
pnpm --filter server test:watch    # vitest watch 模式
```

## 关键架构约定

- 后端分层: `routes → controllers → services → models (Drizzle)`，不跨层调用
- 每个路由文件导出工厂函数 `createXxxRoutes(db)`；Controller/Route 之间通过闭包注入 `db`，不使用全局单例
- 路由注册顺序：静态路径必须早于 `:id` 动态路由
- 前端 `<v-main>` 仅在 `App.vue` 中包裹 `<router-view />`，每个页面自带自己的 `<v-app-bar color="primary">`
- 页面使用 `@/` 路径别名 (Vite resolve alias)
- 数据库 schema 变更**必须**走版本化迁移（新建 `vN-xxx.ts` 并在注册表追加），禁止启动时自动改表

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/dev/](docs/dev/README.md) | 开发与业务参考文档**总索引**（架构、认证、执行提供商、任务调度、数据库、错误码） |
| [架构与开发约定](docs/dev/architecture.md) | 分层与依赖注入、启动与静态托管、环境变量、前端约定、测试约定、模块索引 |
| [认证与鉴权](docs/dev/auth.md) | 默认密码、JWT 生命周期、鉴权开关、端点鉴权范围、前端登录行为 |
| [执行提供商](docs/dev/execution-providers.md) | 实例类型与配置、默认实例与解析语义、资产自动清理、API Key 回显约定 |
| [任务调度与队列](docs/dev/task-scheduling.md) | 待调度 / 已提交、统一调度器、分组自动分配、健康冷却、人工改派与插队 |
| [数据库与迁移](docs/dev/database.md) | 表清单与 `settings` 键、版本化迁移机制、迁移历史、新增变更流程 |
| [错误码](docs/dev/error-codes.md) | 全部错误码、HTTP 状态码与触发场景 |
| [工作流 API](docs/workflow-api.md) · [详情 API](docs/workflow-detail-api.md) · [列表 API](docs/workflow-list-api.md) | 对外 REST API 文档 |
| [docs/dev-plans/](docs/dev-plans/) · [docs/impl/](docs/impl/) · [docs/issues/](docs/issues/) · [docs/superpowers/](docs/superpowers/) | 历史设计、实现方案与问题分析归档 |

## 参考资料

- [ComfyUI API 文档](https://docs.comfy.org/development/comfyui-server/comms_routes) — `POST /prompt` 接口
- [Vuetify 文档](https://next.vuetifyjs.com/zh-Hans/getting-started/installation/)
