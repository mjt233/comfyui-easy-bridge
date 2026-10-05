# 认证与鉴权

> 本文是管理员认证、Token 生命周期、鉴权开关与前端登录行为的完整说明。
> `AGENTS.md` 只保留摘要与指引，实现细节以本文为准。
>
> 相关文档：[错误码](error-codes.md)、[数据库与迁移](database.md)（`settings` 键）、
> [架构与开发约定](architecture.md)。

## 1. 管理员密码

| 项 | 值 |
|---|---|
| 默认密码 | `0d000721` |
| 存储 | `settings.admin_password_hash`（bcrypt，cost 10） |
| 最短长度 | 6 位（`AuthService.MIN_PASSWORD_LENGTH`） |
| 初始化 | 服务启动（`ensureDefaultPassword`）与 `AuthService` 构造时均检查：**从未设置过**才写入默认密码哈希，已有哈希保持不变 |

修改密码：`POST /api/auth/change-password`（需登录），请求体 `{ oldPassword, newPassword }`。

- 旧密码错误 → 401 `unauthorized`（由 errorHandler 映射）
- 新密码过短 → 400 `invalid_parameter`
- 修改成功后 `settings.auth_token_version` **+1**，所有此前签发的 token 立即失效

## 2. Token（JWT）

| 项 | 值 |
|---|---|
| 签发 | `POST /api/auth/login`，请求体 `{ password }`，响应 `{ token }` |
| 载荷 | `{ role: 'admin', v: <auth_token_version> }` |
| 有效期 | 24h（`expiresIn: '24h'`） |
| 密钥 | 环境变量 `JWT_SECRET`；未设置时使用代码内置的开发密钥 |
| 传递 | 请求头 `Authorization: Bearer <token>` |
| 校验 | `middleware/auth.ts` → `AuthService.verifyToken`：验签 + 校验 `v` 与当前 `auth_token_version` 一致，落后即视为已吊销（`Token revoked`） |

> 生产环境必须通过 `.env` 或环境变量设置 `JWT_SECRET`，否则内置开发密钥存在 token 伪造风险
> （见 `docker-compose.yml`）。

## 3. 鉴权开关

- 由设置 `auth_enabled` 控制，`'0'` 表示**关闭**，其余值（含未设置）表示开启
- 关闭时 `createAuthMiddleware` 直接放行所有请求，供内网 / 受信环境免登录使用
- 前端通过公开端点 `GET /api/auth/status`（响应 `{ authEnabled }`）感知开关状态

## 4. 端点鉴权范围

| 端点 | 鉴权 |
|---|---|
| `GET /api/health` | 公开 |
| `POST /api/auth/login` | 公开 |
| `GET /api/auth/status` | 公开 |
| `POST /api/workflows/:id/execute` | **公开**（设计上供外部系统直接调用） |
| `POST /api/auth/change-password` | 需 Bearer Token |
| `/api/workflows/*`（除 execute）、`/api/tasks/*`、`/api/providers/*`、`/api/settings/*`、`/api/tags/*` | 需 Bearer Token |

未通过鉴权 → 401 `unauthorized`。

## 5. 前端行为

`packages/client/src/api/`：

- **Token 存储**：`localStorage('token')`
- **自动附加**：`client.ts` 的 axios 请求拦截器为每个请求加 `Authorization: Bearer <token>`
- **401 处理**：响应拦截器清除 token 并跳转 `/login`
  - 例外：`/auth/login`（密码错误就地提示）与 `/auth/change-password`（旧密码错误由表单提示），
    以及 `authEnabled === false`（鉴权关闭）时不触发跳转
- **路由守卫**：`router/index.ts` 的 `router.beforeEach` 检查受保护路由——
  `authEnabled` 仍为 `null`（未加载完）或 `false`（鉴权关闭）时放行，否则无 token 跳转 `Login`
- **开关感知**：`App.vue` 挂载时调用 `GET /api/auth/status` 写入 `authEnabled`（请求失败时按开启处理）

## 6. 测试覆盖

| 测试文件 | 覆盖点 |
|---|---|
| `services/auth.service.test.ts` | 默认密码初始化、密码校验、改密后 token 版本失效、鉴权开关判定 |
| `routes/auth.routes.test.ts` | 登录成功 / 密码错误、状态端点、改密校验（长度、旧密码） |
| `routes/*.routes.test.ts` | 各受保护端点的鉴权行为（测试中通常写入 `auth_enabled='0'` 以聚焦业务） |
