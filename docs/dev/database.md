# 数据库与迁移

> 本文是 SQLite schema、版本化迁移机制与新增变更流程的完整说明。
> `AGENTS.md` 只保留摘要与指引，实现细节以本文为准。
>
> 相关文档：[执行提供商](execution-providers.md)、[任务调度与队列](task-scheduling.md)、
> [架构与开发约定](architecture.md)。

## 1. 存储位置

| 项 | 值 |
|---|---|
| 数据库文件 | `data/bridge.db`（已 gitignore） |
| 路径覆盖 | `DATA_DIR` 环境变量 |
| 驱动 | better-sqlite3 + Drizzle ORM |
| schema 定义 | `packages/server/src/models/schema.ts` |
| 连接与初始化 | `packages/server/src/models/db.ts` |
| 附件存储 | `DATA_DIR/attachments/`（工作流附件，见 `workflow_attachments` 表） |
| 任务媒体暂存 | `DATA_DIR/task-staging/<taskId>/`（提交成功后释放，启动时清理超过 24h 的残留） |

## 2. 表清单

| 表 | 用途 | 关键字段 |
|---|---|---|
| `workflows` | 工作流定义 | `raw_json`（ComfyUI API JSON）、`build_script` / `build_script_enabled`（动态构建）、`declared_params`、`provider_id`（空 = 用全局默认实例） |
| `workflow_params` | 参数 ↔ 节点字段映射 | `node_id` / `field_name`、`alias`（null = 不暴露）、`param_type`、`default_value`、`candidates` / `multiple`；`UNIQUE(workflow_id, alias)` |
| `workflow_attachments` | 工作流附件 | `filename`（原始名）、`stored_name`（磁盘 uuid 名）、`size` / `mimetype` |
| `task_logs` | 任务日志 | `status`、`provider_id` / `provider_name`（选择的提供商）、`actual_provider_id` / `actual_provider_name`（实际执行实例）、`comfyui_request_body`、`uploaded_files`、`output_files`、`created_at` / `started_at` / `completed_at` |
| `providers` | 执行提供商实例 | `type`、`config`(JSON)、`concurrency`、`enabled`(0/1) |
| `settings` | 键值设置表 | 见下表 |
| `tags` | 标签定义（父/子两级） | `parent_id`、`is_preset`(1=只读)、`metadata_def`(JSON) |
| `workflow_tags` | 工作流 ↔ 标签（多对多） | `(workflow_id, tag_id)` 主键、`metadata_values`(JSON) |

### 2.1 `settings` 关键键

| key | 用途 |
|---|---|
| `admin_password_hash` | 管理员密码的 bcrypt 哈希（见 [认证](auth.md)） |
| `auth_token_version` | Token 版本号；改密时 +1 使旧 token 立即失效 |
| `auth_enabled` | 鉴权开关；`'0'` 表示关闭（缺省开启） |
| `default_provider_id` | 全局默认执行提供商实例 ID |
| `output_download_mode` | 任务产物下载模式：`proxy`（缺省）/ `direct` |
| `comfyui_base_url`、`comfyui_concurrency` | **遗留设置**，仅迁移 v4 读取一次，新代码不再使用 |

## 3. 版本化迁移机制

初始建表与后续 schema 变更**统一走版本化迁移**，不做「启动时对比 schema 自动改表」。

```
packages/server/src/models/migrations/
  runner.ts              迁移引擎（Migration 接口 + runMigrations）
  index.ts               迁移注册表（按 version 升序）
  v1-initial-schema.ts   各版本迁移，命名 vN-简短描述.ts
  ...
```

### 3.1 `Migration` 接口

```ts
interface Migration {
  version: number;                        // 正整数，严格递增
  name: string;                           // 简短描述，仅用于记录 / 日志
  up: (sqlite: Database) => void;         // 执行体，在独立事务中运行
}
```

### 3.2 `runMigrations` 执行流程

1. 创建版本记录表 `schema_migrations(version, name, applied_at)`（幂等，不在事务内）
2. 读取已应用的最大版本号（旧库无记录 → 0）
3. 过滤出未应用的迁移并按 `version` 升序排序；**校验版本号唯一性**（重复会让后一个迁移被静默跳过，直接抛错）
4. 每个迁移在**独立事务**中执行：`up(sqlite)` → 写入记录 → 提交；任一迁移失败即回滚该迁移并抛错
   （错误信息带上版本号与名称，便于从启动日志定位）

### 3.3 兼容性说明

- 已应用迁移记录在 `schema_migrations` 表，重复启动不会重跑
- 迁移 v1 的建表语句保持 `IF NOT EXISTS`，并对 `workflows` 表**幂等补齐**缺失列
  （`build_script` / `build_script_enabled`），因此「部分表已存在」的旧库启动时自动兼容，
  无需人工干预

## 4. 迁移历史

| 版本 | 名称 | 内容 |
|---|---|---|
| v1 | initial schema | 初始 5 张业务表（`workflows` / `workflow_params` / `workflow_attachments` / `settings` / `task_logs`）+ 旧库缺列幂等补偿 |
| v2 | task original form | `task_logs.original_form`（用户原始请求表单） |
| v3 | declared params | `workflows.declared_params`（动态字段静态声明） |
| v4 | execution providers | `providers` 表；由遗留设置 `comfyui_base_url` 迁移出默认 ComfyUI 实例并写入 `default_provider_id` |
| v5 | workflow tags | `tags` / `workflow_tags` 表 + 预设标签数据 |
| v6 | task uploaded files | `task_logs.uploaded_files`（供终态资产清理） |
| v7 | add tts voice clone tag | 预设标签 `tts-voice-clone` |
| v8 | task provider name | `task_logs.provider_name`（冗余实例名，便于实例改名/删除后溯源） |
| v9 | task started at | `task_logs.started_at`（真实提交成功时间） |
| v10 | workflow param candidates | `workflow_params.candidates` / `multiple` |
| v11 | task actual provider | `task_logs.actual_provider_id` / `actual_provider_name`（分组自动分配的实际执行实例） |

## 5. 新增 schema 变更流程

1. 在 `migrations/` 新建 `vN-简短描述.ts`，导出版本号 = 现有最大值 + 1 的 `Migration`
2. 在 `migrations/index.ts` 的注册表中**追加**（数组按 version 升序）
3. 同步更新 `models/schema.ts` 的 Drizzle 定义
4. 为新迁移补测试（`vN-xxx.test.ts`，使用 `:memory:` 数据库）
5. 同步更新本文档（§2 表清单 / §4 迁移历史）与相关业务文档

## 6. 测试约定

- 测试统一使用 `:memory:` SQLite 实例，不依赖磁盘文件
- `models/migrations.test.ts`：迁移引擎行为（未应用迁移的执行、记录写入、失败回滚、版本号重复报错）
- `models/migrations/vN-*.test.ts`：单个迁移的前后 schema 与数据迁移结果
- `models/schema.test.ts`：Drizzle schema 与建表结果一致
- 测试中通过 `SettingsService` 直接写入设置来调整行为（如 `auth_enabled='0'` 关闭鉴权）
