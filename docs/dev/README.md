# 开发与业务参考文档

本目录收录**具体功能实现的业务与开发参考文档**：描述「系统现在是怎么工作的」，
是修改代码前应优先查阅的资料。`AGENTS.md` 只保留编码约束、常用命令与文档索引，细节以本目录为准。

## 文档列表

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 仓库结构、后端分层与依赖注入、服务端启动与静态托管、环境变量、前端约定、测试约定、模块索引 |
| [auth.md](auth.md) | 管理员密码、JWT 生命周期、鉴权开关、端点鉴权范围、前端登录行为 |
| [execution-providers.md](execution-providers.md) | 执行提供商实例模型（`comfyui` / `runninghub` / `group`）、默认实例与解析语义、资产自动清理、API Key 约定 |
| [task-scheduling.md](task-scheduling.md) | 任务队列（待调度 / 已提交）、统一调度器、分组自动分配与成员挑选、健康冷却、人工改派与插队 |
| [database.md](database.md) | SQLite 表清单与 `settings` 键、版本化迁移机制、迁移历史、新增 schema 变更流程 |
| [error-codes.md](error-codes.md) | 全部错误码（HTTP 状态码、触发场景、代码位置） |

## 相关文档（本目录之外）

| 位置 | 内容 |
|---|---|
| [`docs/*.md`](../) | 对外 API 文档：[workflow-api.md](../workflow-api.md)、[workflow-detail-api.md](../workflow-detail-api.md)、[workflow-list-api.md](../workflow-list-api.md) |
| [`docs/dev-plans/`](../dev-plans/) | 按日期记录的设计方案（含已实施与未实施） |
| [`docs/impl/`](../impl/) | 大型重构的实现方案 |
| [`docs/issues/`](../issues/) | 具体问题的根因分析与修复方案 |
| [`docs/superpowers/`](../superpowers/) | 历史设计与实施计划归档（早期功能） |

## 维护约定

- 功能行为变更时**同步更新对应文档**；新增 schema 变更同时更新 [database.md](database.md)
- 新增错误码同时更新 [error-codes.md](error-codes.md)
- 新增执行提供商类型同时更新 [execution-providers.md](execution-providers.md)
