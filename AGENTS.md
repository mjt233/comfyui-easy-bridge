## 编码约束

- 避免使用 `any` 类型

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
    services/      业务逻辑
    middleware/    认证中间件、错误处理
    models/        Drizzle schema + DB 连接
packages/client/   Vue 3 + Vuetify 前端
  src/
    pages/         LoginPage / WorkflowListPage / WorkflowEditPage / WorkflowDetailPage / SettingsPage
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

- 后端分层: `routes → controllers → services → models (Drizzle)`
- 每个路由文件导出工厂函数 `createXxxRoutes(db)`，接收 Drizzle 实例
- Controller/Route 之间通过闭包注入 `db` 依赖，不使用全局单例
- 前端每个页面有自己的 `<v-app-bar color="primary">`，`<v-main>` 仅在 `App.vue` 中包裹 `<router-view />`
- 页面使用 `@/` 路径别名 (Vite resolve alias)

## 认证

- 默认密码: `0d000721`，首次启动自动 bcrypt 哈希后存入 settings 表
- Token 存在 `localStorage('token')`，axios 拦截器自动附加 `Authorization: Bearer`
- 401 时自动清除 token 并跳转 `/login`
- 受保护路由在 `router.beforeEach` 中检查
- 公开端点: `POST /api/auth/login`, `POST /api/workflows/:id/execute`

## 数据库

- SQLite 文件: `data/bridge.db` (已 gitignore)
- 表在首次启动时通过 `CREATE TABLE IF NOT EXISTS` 自动创建 (见 `packages/server/src/models/db.ts`)
- Drizzle schema 定义在 `schema.ts` (三表: `workflows`, `workflow_params`, `settings`)
- 测试使用 `:memory:` 数据库，不依赖磁盘文件
- 可以通过 `DATA_DIR` 环境变量覆盖数据库路径

## 测试

- 后端单元测试直接导入模块，使用 `:memory:` SQLite 实例
- 集成测试使用 supertest + express 子应用 (不监听端口)
- 服务端启动被 `process.env.VITEST` 守卫，测试导入时不会监听端口
- 测试文件命名: `*.test.ts`，和被测试文件放在同一目录

## 错误码

| code | 场景 |
|------|------|
| `missing_parameter` | 必填参数缺失 |
| `unauthorized` | Token 无效/过期 |
| `workflow_not_found` | 工作流不存在 |
| `alias_conflict` | 别名重复 (UNIQUE 约束) |
| `comfyui_unreachable` | ComfyUI 服务不可达或返回错误 |

## 参考资料

- [ComfyUI API 文档](https://docs.comfy.org/development/comfyui-server/comms_routes) — `POST /prompt` 接口
- [Vuetify 文档](https://next.vuetifyjs.com/zh-Hans/getting-started/installation/)
