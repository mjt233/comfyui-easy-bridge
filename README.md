# ComfyUI Easy Bridge

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-9-orange)](https://pnpm.io)

将 ComfyUI 导出的 API 格式工作流 JSON 进行封装，通过可视化界面为节点输入字段标记别名，对外暴露简洁的 REST API — 传入别名 + 值即可触发工作流执行。

---

## 目录

- [ComfyUI Easy Bridge](#comfyui-easy-bridge)
  - [目录](#目录)
  - [核心功能](#核心功能)
    - [示例](#示例)
  - [快速开始](#快速开始)
    - [前置要求](#前置要求)
    - [安装](#安装)
    - [启动](#启动)
  - [操作流程](#操作流程)
  - [API 文档](#api-文档)
    - [认证](#认证)
    - [执行工作流](#执行工作流)
    - [错误码](#错误码)
  - [配置](#配置)
  - [开发](#开发)
    - [命令](#命令)
    - [项目结构](#项目结构)
    - [测试](#测试)
  - [技术栈](#技术栈)
    - [后端](#后端)
    - [前端](#前端)
  - [参考资料](#参考资料)

---

## 核心功能

1. **工作流管理** — 上传 / 粘贴 ComfyUI API JSON，在线编辑别名映射
2. **参数别名** — 为任意节点输入字段绑定别名，屏蔽底层节点结构
3. **简洁调用** — `POST /api/workflow/:id` 传入别名键值对，自动组装并转发给 ComfyUI
4. **认证保护** — 管理员后台需登录，外部调用需 Bearer Token

### 示例

原始 ComfyUI API JSON（部分）：

```json
{
  "30:19": {
    "inputs": { "value": "..." },
    "class_type": "PrimitiveStringMultiline",
    "_meta": { "title": "Text String (User Prompt)" }
  }
}
```

将 `30:19.inputs.value` 标记为别名 `img_desc` 后，调用：

```
POST /api/workflow/:id
Authorization: Bearer <token>

{ "img_desc": "一只橘黄色的凶猛小猫，写实风格" }
```

---

## 快速开始

### 前置要求

- Node.js >= 18
- pnpm 9+

### 安装

```bash
git clone <repo-url>
cd comfyui-easy-bridge

pnpm install
pnpm build:server
```

### 启动

```bash
pnpm dev:server   # 后端 (tsx watch, 默认 10721)
pnpm dev:client   # 前端 (Vite HMR, 代理 /api → 10721)
```

首次启动会自动创建 SQLite 数据库及表，并初始化默认管理员密码。

> 默认管理员密码: `0d000721`（启动时若未设置密码则自动 bcrypt 哈希存储；登录后可在 **系统设置 → 安全设置** 修改密码，修改后所有旧 token 立即失效）

### Docker 部署（单容器）

```bash
docker compose up -d --build
```

- 构建过程见 `Dockerfile`（多阶段：pnpm 安装 → 编译 server/client → 裁剪生产依赖的运行时镜像）
- 前端由后端 Express 统一托管，访问 `http://<host>:10721` 即可（`/api/*` 仍为纯 JSON 接口）
- SQLite 数据库、附件与任务输出持久化在宿主机 `./data` 目录（映射到容器 `/app/data`）
- 生产环境请通过 `.env` 文件或环境变量设置 `JWT_SECRET`（见 `docker-compose.yml`），
  否则将使用代码内置的开发密钥，存在 token 伪造风险

---

## 操作流程

1. 浏览器访问 `/admin`，使用默认密码登录
2. 进入 **系统设置**，配置 ComfyUI 的 HTTP 地址（baseUrl）
3. 进入 **工作流管理 → 新增工作流**，上传或粘贴 ComfyUI 导出的 API JSON
4. 为每个需要暴露的节点输入字段添加别名（唯一标识）和可选的标签
5. 保存后即可通过 `POST /api/workflow/:id` 调用

系统会解析原始 JSON，替换别名对应的节点字段值，然后向 ComfyUI 的 `POST /prompt` 发起请求并返回结果。

---

## API 文档

### 认证

```
POST /api/auth/login

{ "password": "0d000721" }

→ { "token": "eyJ..." }
```

Token 在 24 小时后过期。后续请求通过 `Authorization: Bearer <token>` 头传递。

### 执行工作流

```
POST /api/workflow/:id
Authorization: Bearer <token>

{ "alias_key": "value", ... }

→ ComfyUI 原始响应
```

### 错误码

| code | 场景 |
|------|------|
| `missing_parameter` | 必填参数缺失 |
| `unauthorized` | Token 无效 / 过期 |
| `workflow_not_found` | 工作流不存在 |
| `alias_conflict` | 别名重复（UNIQUE 约束） |
| `comfyui_unreachable` | ComfyUI 服务不可达或返回错误 |

---

## 配置

通过环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `10721` | 服务端口 |
| `DATA_DIR` | `data/` | 数据库文件目录 |

数据库文件为 `bridge.db`，已加入 `.gitignore`。

---

## 开发

### 命令

```bash
pnpm dev:server      # 后端开发（热重载）
pnpm dev:client      # 前端开发（HMR）
pnpm test            # 运行后端测试
pnpm build:server    # 编译后端
pnpm build:client    # 类型检查 + 构建前端
```

### 项目结构

```
packages/server/   Express 后端 (TypeScript + Drizzle ORM)
  src/
    routes/        URL 路径定义
    controllers/   参数校验
    services/      业务逻辑
    models/        Drizzle schema + DB 连接

packages/client/   Vue 3 + Vuetify 前端 (TypeScript + Vite)
  src/
    pages/         页面组件
    api/           HTTP 客户端封装
    router/        路由配置
```

### 测试

后端使用 vitest + supertest，测试时使用 `:memory:` SQLite 数据库，不依赖磁盘文件。

```bash
pnpm test
pnpm --filter server test:watch   # 监视模式
```

---

## 技术栈

### 后端

| 技术 | 用途 |
|------|------|
| Node.js / Express | HTTP 服务 |
| TypeScript | 类型安全 |
| Drizzle ORM | 数据库 ORM |
| better-sqlite3 | SQLite 驱动 |
| jsonwebtoken + bcryptjs | JWT 认证 |

### 前端

| 技术 | 用途 |
|------|------|
| Vue 3 (Composition API) | UI 框架 |
| Vuetify 3 | Material Design 组件库 |
| TypeScript | 类型安全 |
| Vite | 构建工具 |
| Vue Router | 路由 |
| Axios | HTTP 客户端 |

---

## 参考资料

- [ComfyUI API 官方文档](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [Vuetify 文档](https://next.vuetifyjs.com/zh-Hans/getting-started/installation/)
