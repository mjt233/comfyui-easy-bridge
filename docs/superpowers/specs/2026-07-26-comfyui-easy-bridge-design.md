# ComfyUI Easy Bridge 设计文档

## 概述

ComfyUI Easy Bridge 是一个简化 ComfyUI 工作流调用的中间层服务。它允许用户上传 ComfyUI 导出的 API JSON 工作流模板，将指定节点的输入字段标记为别名（alias），然后通过一个简化的 HTTP API 传入别名对应的值即可触发工作流执行，无需直接操作 ComfyUI 的原始 API。

## 技术栈

| 层 | 技术 |
|---|------|
| 后端运行时 | Node.js + TypeScript |
| 后端框架 | Express |
| 数据库 | SQLite (via Drizzle ORM) |
| 前端框架 | Vue 3 + Vuetify + TypeScript |
| 包管理 | pnpm workspace (Monorepo) |
| 认证 | JWT + bcrypt |

## 项目结构

```
comfyui-easy-bridge/
├── packages/
│   ├── server/               # Express 后端
│   │   ├── src/
│   │   │   ├── routes/       # 路由定义
│   │   │   ├── controllers/  # 请求处理
│   │   │   ├── services/     # 业务逻辑
│   │   │   ├── models/       # Drizzle schema + DB 连接
│   │   │   ├── middleware/   # 认证等中间件
│   │   │   └── index.ts      # 入口
│   │   └── package.json
│   └── client/               # Vue3 + Vuetify 前端
│       ├── src/
│       │   ├── pages/        # 页面组件
│       │   ├── components/   # 通用组件
│       │   ├── api/          # HTTP 调用封装
│       │   └── types/        # TypeScript 类型定义
│       └── package.json
├── docs/
│   └── superpowers/
│       └── specs/
└── package.json              # pnpm workspace root
```

## 数据库 Schema

### workflows

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | TEXT | PRIMARY KEY | 工作流唯一标识（用户自定义或随机生成） |
| name | TEXT | NOT NULL | 工作流名称 |
| raw_json | TEXT | NOT NULL | 原始 ComfyUI API JSON |
| created_at | TEXT | NOT NULL | ISO 8601 时间戳 |
| updated_at | TEXT | NOT NULL | ISO 8601 时间戳 |

### workflow_params

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增 ID |
| workflow_id | TEXT | NOT NULL REFERENCES workflows(id) ON DELETE CASCADE | 关联工作流 |
| node_id | TEXT | NOT NULL | 节点 ID，如 "30:19" |
| field_name | TEXT | NOT NULL | 节点 input 字段名，如 "value" |
| alias | TEXT | NOT NULL UNIQUE | 外部调用时使用的参数名 |
| label | TEXT | 可选 | 中文标签，前端展示用 |

### settings

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| key | TEXT | PRIMARY KEY | 设置键 |
| value | TEXT | NOT NULL | 设置值 |

初始记录：
- `comfyui_base_url`: ComfyUI 服务地址（默认空）
- `admin_password_hash`: 管理员密码的 bcrypt 哈希

## 后端架构

### 分层结构

```
routes → controllers → services → models (Drizzle)
```

- **routes**: 定义 URL 路径与 HTTP 方法的映射，绑定到对应的 controller
- **controllers**: 参数校验、调用 service、返回 HTTP 响应
- **services**: 核心业务逻辑
- **models**: Drizzle schema 定义 + 数据库连接实例

### 核心 Service：executor.service.ts

执行工作流的核心流程：

1. 接收 `workflowId` 和 `aliasValues: Record<string, string>`
2. 从 DB 加载 `workflows.raw_json` 和对应的 `workflow_params` 别名映射
3. 遍历别名映射，对每个别名：
   a. 在 `raw_json` 中找到 `node_id` 对应的节点
   b. 将 `inputs[field_name]` 替换为传入的值
4. 将替换后的完整 JSON 通过 `POST /prompt` 发送到 ComfyUI
5. 透传返回 ComfyUI 的响应

### Services 列表

| Service | 职责 |
|---------|------|
| workflow.service.ts | 工作流 CRUD，参数别名管理 |
| executor.service.ts | 核心引擎：别名替换 + ComfyUI 调用 |
| settings.service.ts | 系统设置读写 |

## 前端结构

### 页面路由

| 路径 | 页面 | 说明 |
|------|------|------|
| `/login` | LoginPage | 管理员登录 |
| `/admin` | WorkflowListPage | 工作流列表（首页） |
| `/admin/workflow/new` | WorkflowEditPage | 新建工作流 |
| `/admin/workflow/:id` | WorkflowDetailPage | 工作流详情 + 参数别名管理 |
| `/admin/workflow/:id/edit` | WorkflowEditPage | 编辑工作流 |
| `/admin/settings` | SettingsPage | 系统设置 |

### WorkflowDetailPage 交互流程

1. 加载工作流数据及原始 JSON
2. 解析 JSON 中所有节点的 `_meta.title` 和 `inputs` 字段
3. 以表格展示：节点 ID | 节点标题 | 可配置 input 字段
4. 用户可为某个 input 字段添加别名（alias）和可选标签（label）
5. 已配置别名的行显示编辑/删除操作
6. 保存后写入 `workflow_params` 表

## API 设计

### 认证相关

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录，返回 JWT token |

### 工作流管理（需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/workflows` | 获取工作流列表 |
| POST | `/api/workflows` | 新建工作流 |
| GET | `/api/workflows/:id` | 获取工作流详情（含参数列表） |
| PUT | `/api/workflows/:id` | 更新工作流 |
| DELETE | `/api/workflows/:id` | 删除工作流 |
| POST | `/api/workflows/:id/params` | 添加参数别名 |
| PUT | `/api/workflows/:id/params/:paramId` | 编辑参数别名 |
| DELETE | `/api/workflows/:id/params/:paramId` | 删除参数别名 |

### 系统设置（需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/settings` | 获取系统设置 |
| PUT | `/api/settings` | 更新系统设置 |

### 外部调用（无需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/workflows/:id/execute` | 执行工作流 |

请求体示例：
```json
{
  "img_desc": "一只橘黄色的凶猛小猫..."
}
```

响应：ComfyUI `POST /prompt` 的原始响应（透传）。

## 认证设计

- 仅一个管理员账号
- 密码固定为 `0d000721`，首次启动时写入 settings 表（bcrypt 哈希）
- 登录接口返回 JWT token，有效期 24 小时
- 前端将 token 存入 localStorage，axios 拦截器自动附加 `Authorization: Bearer <token>`
- 后端 auth 中间件保护除 `/api/auth/login` 和 `/api/workflows/:id/execute` 外的所有 `/api/*` 路由

## 错误处理

### 统一错误响应格式

```json
{
  "error": "描述信息",
  "code": "error_code"
}
```

### 错误码

| HTTP 状态码 | code | 场景 |
|-------------|------|------|
| 400 | `missing_parameter` | 必填参数缺失 |
| 401 | `unauthorized` | Token 无效/过期 |
| 404 | `workflow_not_found` | 工作流 ID 不存在 |
| 409 | `alias_conflict` | 别名重复 |
| 502 | `comfyui_unreachable` | ComfyUI 服务不可达 |

### 前端处理

- axios 响应拦截器统一处理错误
- 使用 Vuetify `v-snackbar` 显示错误提示
- 401 时自动跳转登录页

## 测试策略

- 后端：vitest + supertest，覆盖 controller 和 service 层
- 前端：当前阶段暂不编写前端测试，人工验证
