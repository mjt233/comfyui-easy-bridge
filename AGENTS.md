## 编码约束

- 避免使用 `any` 类型
- 所有类/对象、类/对象的字段、方法/函数、interface、type、Vue组件的props和watch都需要有详细的jsdoc注释
- 生成的代码中，每个关键步骤需要有行内注释，新生成的函数需要有jsdoc注释
- 涉及异步的函数优先使用async / await

## 验证

修改代码后需要执行以下命令进行TypeScript类型验证：
- 验证后端 `pnpm --filter server exec tsc --noEmit`
- 验证前端 `pnpm --filter client exec tsc --noEmit`

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

## 执行提供商

- 工作流执行通过「执行提供商」实例进行，取代旧的全局设置 `comfyui_base_url` / `comfyui_concurrency`（旧设置仅迁移期读取）
- 类型：`comfyui`（`config.baseUrl`）/ `runninghub`（`config.apiKey` + `gpuSize: '24G'|'48G'`，基础地址由 proxy / proxy-plus 推导）
- 全局默认实例由设置 `default_provider_id` 指定；工作流 `providerId` 字段可覆盖（空 = 用全局默认）
- 实现位于 `services/providers/`：`types.ts`（抽象接口）、`shared.ts`（公共请求）、`comfyui.provider.ts` / `runninghub.provider.ts`（具体实现）、`provider.service.ts`（CRUD 与实例解析）；`services/execution.service.ts` 按实例维护任务跟踪器

## 数据库

- SQLite 文件: `data/bridge.db` (已 gitignore)
- 初始建表与后续 schema 变更统一走**版本化迁移**：`packages/server/src/models/migrations/`（引擎 `runner.ts`、注册表 `index.ts`、迁移 `vN-xxx.ts`）
- 已应用迁移记录在 `schema_migrations` 表；每个迁移在独立事务中执行，失败自动回滚
- 旧库启动时自动补齐缺失列（迁移 1 幂等兼容），无需人工干预
- Drizzle schema 定义在 `schema.ts`（六表: `workflows`, `workflow_params`, `workflow_attachments`, `settings`, `task_logs`, `providers`）
- 新增 schema 变更：在 `migrations/` 新建 `vN-xxx.ts` 并在 `index.ts` 注册表中追加，同步更新设计文档
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
| `comfyui_unreachable` | 执行提供商服务不可达或返回错误 |
| `provider_not_configured` | 未配置默认提供商 / 工作流指定的实例不存在或已禁用 |
| `build_script_error` | 动态构建脚本编译失败 / 运行时抛错 / 返回非对象 |
| `build_script_timeout` | 动态构建脚本执行超时（默认 5s） |
| `tag_not_found` | 标签不存在 |
| `tag_conflict` | 同层级标签名重复 |
| `tag_preset_readonly` | 预设标签不可编辑 / 删除 |
| `tag_has_children` | 删除的标签存在子标签 |
| `tag_in_use` | 删除的标签被工作流引用 |
| `parent_tag_required` | 打子标签未同时包含父标签 |
| `invalid_metadata` | 元数据键不属于字段定义或值类型不匹配 |

## 参考资料

- [ComfyUI API 文档](https://docs.comfy.org/development/comfyui-server/comms_routes) — `POST /prompt` 接口
- [Vuetify 文档](https://next.vuetifyjs.com/zh-Hans/getting-started/installation/)
