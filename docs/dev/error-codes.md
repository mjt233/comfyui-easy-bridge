# 错误码参考

> 本文是全部错误码的完整清单（含 HTTP 状态码、触发条件与代码位置）。
> `AGENTS.md` 只保留摘要与指引，实现细节以本文为准。
>
> 相关文档：[工作流 API 文档](../workflow-api.md)（含各端点的错误响应示例）、
> [执行提供商](execution-providers.md)、[任务调度与队列](task-scheduling.md)、[认证与鉴权](auth.md)。

## 1. 错误响应格式

所有错误响应统一为：

```json
{ "error": "<可读文案>", "code": "<错误码>" }
```

未归类的服务端异常由 `middleware/errorHandler.ts` 兜底映射（`Missing required parameter:`
→ `missing_parameter`、`UNIQUE constraint failed` → `alias_conflict`、
`ComfyUI returned status` → `comfyui_unreachable`），其余一律 `500 internal_error`。

## 2. 通用与认证

| code | HTTP | 场景 |
|---|---|---|
| `missing_parameter` | 400 | 必填参数缺失（路由 / 控制器校验，或 errorHandler 对 `Missing required parameter:` 的映射） |
| `invalid_parameter` | 400 | 修改密码时新密码长度不足（`New password too short`） |
| `unauthorized` | 401 | Token 缺失 / 无效 / 过期；登录密码错误；修改密码时旧密码错误 |
| `internal_error` | 500 | 未归类的服务端异常（兜底） |

## 3. 工作流与参数

| code | HTTP | 场景 |
|---|---|---|
| `workflow_not_found` | 404 | 工作流不存在 |
| `alias_conflict` | 409 | 别名在工作流内重复（`workflow_params` 的 UNIQUE 约束）；errorHandler 亦把所有 UNIQUE 约束冲突映射为此码 |
| `id_conflict` | 409 | 新建 / 导入的工作流 ID 已存在 |
| `attachment_not_found` | 404 | 工作流附件记录不存在，或其磁盘文件缺失 |

## 4. 执行提供商

| code | HTTP | 场景 |
|---|---|---|
| `provider_not_configured` | 400 | 未配置默认提供商；显式指定的实例（工作流 `providerId` / 本次执行 `providerId` / 改派 / 插队）不存在、已停用或配置非法——**不静默回退默认**；插队目标为分组（分组无自有提交端点） |
| `provider_not_configured` | 503 | 改派 / 插队时调度服务未启动（无提交能力） |
| `provider_no_available_instance` | 400 | 提交到分组时该分组没有任何可参与自动分配的成员（无成员 / 成员全部停用） |
| `provider_no_online_instance` | 任务级（非 HTTP） | 分组 `noOnlineInstanceBehavior='error'` 且分组内没有任何**在线**成员时的**任务级失败标记**：写在任务 `error_message` 中，任务置 `failed`；`execute` 本身仍返回 200 + `status: 'failed'`。语义见 [任务调度 §5 分组提供商](task-scheduling.md#5-分组自动分配提供商) |
| `provider_not_found` | 404 | 提供商实例不存在 |
| `default_provider_not_deletable` | 409 | 尝试删除全局默认提供商实例 |
| `comfyui_unreachable` | 502 | 执行提供商服务不可达或返回错误：插队提交时目标实例探测 / 上传失败（任务**保持 `queued`**）；任务输出相关接口回源失败；errorHandler 对 `ComfyUI returned status` 的映射。执行接口本身的不可达以任务 `failed` 状态体现，不返回 HTTP 错误 |

## 5. 任务

| code | HTTP | 场景 |
|---|---|---|
| `task_not_found` | 404 | 任务不存在 |
| `invalid_status` | 400 | 对非 `queued` 任务执行改派 / 插队；对终态（`completed` / `failed`）任务执行取消 |
| `interrupt_unconfirmed` | 502 | 中断请求已发出但未能确认执行端已停止（`GET /queue` 不可用或仍在执行），任务**保持 `pending`**，交由跟踪器收敛 |

## 6. 动态构建脚本

两个码由 `services/build.service.ts` 的 `runBuildScript` 产出，**不是 HTTP 错误码**，
按调用场景以不同形式暴露：

| code | 场景 | 暴露方式 |
|---|---|---|
| `build_script_error` | 脚本编译失败 / 运行时抛错 / 返回非对象 / 结果过大 / 结果不可序列化 / Worker 非零退出 | 预览（`POST /api/workflows/:id/build/simulate`）→ HTTP 400 + 该 `code`；执行（`execute`）→ 任务置 `failed`，`error_message` 形如 `Dynamic build failed [build_script_error]: ...` |
| `build_script_timeout` | 脚本执行超时（默认 5s） | 同上 |

## 7. 标签

| code | HTTP | 场景 |
|---|---|---|
| `tag_not_found` | 404 | 标签（或指定的父标签）不存在 |
| `tag_conflict` | 409 | 同层级标签名重复；自定义标签 ID 已存在 |
| `tag_preset_readonly` | 403 | 预设标签不可编辑 / 删除 |
| `tag_has_children` | 409 | 删除的标签存在子标签 |
| `tag_in_use` | 409 | 删除的标签被工作流引用 |
| `parent_tag_required` | 400 | 打子标签未同时包含其父标签 |
| `invalid_metadata` | 400 | 元数据键不属于字段定义，或值类型不匹配（`number` / `string` / `boolean`） |

## 8. 代码位置索引

| 模块 | 产出的错误码 |
|---|---|
| `middleware/errorHandler.ts` | `missing_parameter`、`unauthorized`、`invalid_parameter`、`alias_conflict`、`comfyui_unreachable`、`internal_error` |
| `middleware/auth.ts` | `unauthorized` |
| `controllers/auth.controller.ts` | `missing_parameter`、`unauthorized` |
| `controllers/workflow.controller.ts` | `workflow_not_found`、`missing_parameter`、`alias_conflict`、`id_conflict`、`provider_not_configured`、`provider_no_available_instance`、`comfyui_unreachable`、`attachment_not_found`、`build_script_error` / `build_script_timeout`（预览） |
| `controllers/task.controller.ts` | `task_not_found`、`invalid_status`、`missing_parameter`、`provider_not_configured`、`comfyui_unreachable`、`interrupt_unconfirmed` |
| `controllers/providers.controller.ts` | `provider_not_found`、`missing_parameter` |
| `services/providers/provider.service.ts` | `default_provider_not_deletable`、`provider_not_configured` |
| `services/dispatcher.service.ts` | `provider_no_online_instance`（任务级 `error_message`） |
| `services/tag.service.ts` / `services/workflow-tag.service.ts` | 全部 `tag_*` 与 `parent_tag_required`、`invalid_metadata` |

## 9. 测试覆盖

| 测试文件 | 覆盖点 |
|---|---|
| `routes/*.routes.test.ts` | 各端点成功 / 校验失败 / 状态冲突的状态码与 `code`（errorHandler 的映射在这些集成用例中间接覆盖） |
| `services/tag.service.test.ts`、`services/workflow-tag.service.test.ts` | 标签错误码的服务层抛出点 |
