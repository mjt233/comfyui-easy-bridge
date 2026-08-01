# 动态工作流构建设计

## 背景

ComfyUI 的 API 工作流 JSON 是静态的：节点、连线、参数在导入时就已固定。用户希望在**提交执行时**，根据当次提交的参数，通过自定义逻辑对工作流进行动态调整——新增/删除节点、修改节点间连接、修改节点参数。

典型场景：根据参数 `style` 的值，在 prompt 前插入不同的前置节点；根据参数 `upscale` 决定是否保留放大节点；将某节点输入从 A 节点切换到 B 节点等。

## 目标

在原有 ComfyUI 工作流基础上支持**动态构建**：

1. 用户通过编写 TypeScript 脚本，在提交执行时基于本次参数动态调整工作流 JSON 的节点信息
2. 工作流详情页新增"动态构建脚本"页签，用 Monaco 编辑器编写脚本，内置类型提示与辅助函数（新增节点、删除节点、连接字段）的代码补全
3. 支持**模拟构建**：填写参数（已配置的别名字段 + 自由添加字段）后，弹出模拟结果对话框，包含节点与参数表、画布、格式化 JSON + 下载按钮
4. 后端在**文件上传完成后、节点参数字段值替换之前**执行动态构建

## 关键决策（已与用户确认）

| 决策点 | 结论 |
|--------|------|
| 模拟构建执行位置 | **服务端执行**：前端把脚本+参数发给后端模拟接口，后端沙箱执行并返回结果；真实执行与模拟走同一条代码路径，结果一致 |
| 脚本 API 形态 | **命令式辅助函数**：脚本导出默认函数 `build(ctx)`，ctx 含 workflow、params 与辅助函数；**支持 async/await** |
| 沙箱能力边界 | **开放 Node 能力**：脚本可使用 require/fs/process 等（自托管工具可接受该风险）；配合 worker 线程 + 超时硬杀兜底 |
| 模拟结果语义 | **构建 + 参数应用**：展示脚本构建后再应用已配置别名/defaultValue 的最终 JSON，与真实执行一致 |
| 脚本启用方式 | **需要显式启用**：保存后默认不生效，页签中开启"启用动态构建"后才参与真实执行 |

## 方案选型

### 执行引擎：worker_threads + 临时文件执行（方案 A，已选定）

- 每次构建启动一个 worker 线程
- worker 内用 `typescript.transpileModule` 转译脚本 → 写入 `os.tmpdir()` 临时文件 → `require` 执行默认导出函数
- 主线程 `Promise.race` 超时（默认 5s），超时 `worker.terminate()` 硬杀
- 完整 Node 能力天然可用（require/fs/process），异步天然支持
- 同步死循环可被硬杀；`process.exit()` 只退出 worker 线程，不拖垮服务进程
- 已排除方案：主线程 `vm.runInNewContext`（同步死循环会卡死整个服务）、`child_process.fork`（启动开销大、IPC 复杂）

## 详细设计

### 1. 数据模型

`workflows` 表新增两列：

| 列名 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `build_script` | TEXT | `''` | 用户编写的 TypeScript 脚本源码 |
| `build_script_enabled` | INTEGER | `0` | 是否启用动态构建（真实执行时运行脚本） |

- Drizzle `schema.ts`（`packages/server/src/models/schema.ts`）同步新增字段
- `db.ts`（`packages/server/src/models/db.ts`）建表语句同步，并对**已有库**做兼容迁移：启动时检查 `PRAGMA table_info(workflows)`，缺列则 `ALTER TABLE workflows ADD COLUMN ...`（项目无迁移框架，沿用手动同步模式）
- `WorkflowDetail` 响应类型（前端 `types/index.ts`）增加 `buildScript`、`buildScriptEnabled`

### 2. 脚本契约（共享类型定义）

新增服务端文件 `packages/server/src/services/build-script-api.ts`，既是**运行时辅助函数的实现**，也导出等价的 **d.ts 文本常量**（单一事实来源，避免前后端重复定义）。

```ts
/** ComfyUI API 工作流节点 */
interface ComfyNode {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: { title?: string };
}
/** ComfyUI API 工作流（节点 ID → 节点） */
type ComfyWorkflow = Record<string, ComfyNode>;

/** 构建上下文：脚本默认导出函数的唯一入参 */
interface BuildContext {
  /** 原始工作流（深拷贝，可直接修改） */
  workflow: ComfyWorkflow;
  /** 用户提交的参数（别名字段 + 自由添加字段） */
  params: Record<string, unknown>;
  /** 新增节点 */
  addNode(nodeId: string, classType: string, inputs?: Record<string, unknown>): void;
  /** 删除节点（自动清理指向它的连线） */
  removeNode(nodeId: string): void;
  /** 连接：source 节点的第 sourceSlot 个输出 → target 节点的 targetField 输入 */
  connect(sourceNodeId: string, sourceSlot: number, targetNodeId: string, targetField: string): void;
  /** 断开 targetField 上的连线，并设置回退值 */
  disconnect(targetNodeId: string, targetField: string, fallbackValue?: unknown): void;
  /** 设置节点字段值 */
  setInput(nodeId: string, field: string, value: unknown): void;
  /** 读取节点字段值 */
  getInput(nodeId: string, field: string): unknown;
  /** 按 class_type 查找节点 ID 列表 */
  findNodesByClass(classType: string): string[];
  /** 获取节点引用（不存在返回 undefined） */
  getNode(nodeId: string): ComfyNode | undefined;
  /** 设置节点标题（_meta.title） */
  setTitle(nodeId: string, title: string): void;
}

/** 脚本入口：默认导出，支持 async/await，返回最终工作流 */
export default function build(ctx: BuildContext): ComfyWorkflow | Promise<ComfyWorkflow>;
```

**类型同步机制**（避免新建 shared 包）：d.ts 文本由服务端导出，通过公开接口 `GET /api/workflows/build-api.d.ts` 下发；前端打开页签时拉取并注册进 Monaco（`addExtraLib`），保证编辑器提示与服务端运行时永远一致。

**辅助函数行为约定：**
- `addNode` 重复 nodeId → 抛错；`connect` 源/目标不存在 → 抛错
- `removeNode` 自动把所有指向该节点的连线输入（`[nodeId, slot]` 数组）重置回 `null`
- 脚本修改的是**深拷贝**，不影响 DB 中的 `rawJson`

### 3. 执行引擎

新增 `packages/server/src/services/build.service.ts` + `packages/server/src/services/build.worker.ts`。

**主线程 `runBuildScript(script, params, workflow, timeoutMs = 5000)`：**

```ts
interface BuildScriptResult {
  ok: boolean;
  /** 构建后的工作流对象（ok=true 时） */
  workflow?: ComfyWorkflow;
  /** 错误信息（ok=false 时） */
  error?: string;
}
```

- 从 `build.worker.ts` 读取 worker 源码字符串（`fs.readFileSync` 于模块加载时缓存，dev/prod 均可用）
- `new Worker(workerSource, { eval: true, workerData: { script, params, workflow } })`
- 主线程 `Promise.race` 超时（默认 5s）→ 超时 `worker.terminate()` 并返回超时错误
- 收集 worker `message`（结果）或 `error`（崩溃），统一返回 `BuildScriptResult`

**worker 线程内（`build.worker.ts`，纯 JS、无 TS 特性）：**

1. `typescript.transpileModule(script, { compilerOptions: { module: CommonJS, target: ES2022 } })` 转译
2. 写入 `os.tmpdir()` 临时文件 → `require(tmpFile)`（完成后 `fs.unlinkSync` 清理）
3. 取导出：`module.exports.default` 或 `module.exports` 作为构建函数
4. 构造 `BuildContext`（深拷贝 workflow + 辅助函数实现），调用构建函数（支持返回 Promise）
5. 校验返回值为对象 → 通过 `parentPort.postMessage` 回传；异常/非对象 → 回传错误

**安全边界（开放 Node 能力前提下的兜底）：**
- 同步死循环 / 卡死 → 主线程超时 `terminate()` 硬杀，不影响服务进程
- `process.exit()` 只退出 worker 线程，不拖垮服务
- 限制构建结果体积（序列化 > 2MB 视为异常）

### 4. 后端 API

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| `GET` | `/api/workflows/build-api.d.ts` | ✅ | 返回脚本 API 的 d.ts 文本（供 Monaco 注册） |
| `PUT` | `/api/workflows/:id/build-script` | ✅ | body `{ script, enabled }` 保存脚本与启用状态 |
| `POST` | `/api/workflows/:id/build/simulate` | ✅ | body `{ script, params }` → 返回 `{ json: string }` 或 `{ error, code }` |

- **simulate 语义**：脚本构建（用请求中的 `script`，即编辑器当前内容）→ 再对**已保存的** `workflow_params` 配置执行 `applyAliases`（模拟真实执行顺序），返回最终 JSON 字符串
- `workflow.controller.ts` 新增 handler；`workflow.routes.ts` 挂载
- **路由顺序**：`GET /api/workflows/build-api.d.ts` 必须挂在 `/:id` 参数化路由之前注册，避免被 `/:id` 路由吞掉
- 路径以 `.d.ts` 结尾：便于浏览器网络面板一眼识别该请求是 TypeScript 类型声明

### 5. 执行链路集成（`workflow.controller.ts` 的 `execute`）

在 `processMediaParams` 之后、`applyAliases` 之前插入动态构建：

```ts
// 处理媒体文件上传（现有）
const finalAliasValues = await processMediaParams(params, aliasValues, uploadedFiles, baseUrl);

// 【新增】动态构建：仅当脚本已保存且启用
let buildSource = wf.rawJson;
if (wf.buildScriptEnabled && wf.buildScript) {
  const buildResult = await runBuildScript(wf.buildScript, finalAliasValues, JSON.parse(wf.rawJson));
  if (!buildResult.ok) {
    // 创建 failed 任务日志，errorMessage 带构建错误，直接返回（不提交 ComfyUI）
    return;
  }
  buildSource = JSON.stringify(buildResult.workflow);
}

// 将别名值注入工作流 JSON（现有，作用于构建后的 JSON）
const modifiedJson = applyAliases(buildSource, params, finalAliasValues);
```

- 脚本收到的是**媒体处理后的** `finalAliasValues`（含上传后的真实文件名），符合"上传完成后构建"的时序
- 脚本构建失败 → 任务记录为 `failed`，错误码 `build_script_error` / `build_script_timeout`，不向 ComfyUI 提交
- 并发排队逻辑不变（排队的是构建后的 JSON）

### 6. 前端 UI

#### 6.1 依赖与 Monaco 集成

- 新增 `monaco-editor` 依赖；`vite.config.ts` 配置 worker（`editor.worker?worker` + `ts.worker?worker` 的 `MonacoEnvironment`）
- `WorkflowDetailPage` 新增第三个页签 **"动态构建脚本"**（value=`build`），仅在页签激活时挂载编辑器（与画布同样的懒挂载策略）

#### 6.2 页签内容

```
┌─────────────────────────────────────────────────┐
│ [启用动态构建]开关   [保存]   [模拟构建]           │
│ （提示文案：保存后需启用才会在真实执行中运行）      │
├─────────────────────────────────────────────────┤
│              Monaco 编辑器（TS 语言）             │
│         高度约 520px，含默认导出模板补全          │
└─────────────────────────────────────────────────┘
```

- 打开页签时：`GET /workflows/:id` 拿已保存脚本 → 拉取 `/api/workflows/build-api.d.ts` 注册为 Monaco extra lib（`addExtraLib`，同名文件覆盖更新）
- 编辑器预置"默认导出模板" snippet（含 `build` 签名与空实现），用户可一键插入
- 状态栏：`已保存 HH:mm` / `未保存更改` 提示；切换页签不销毁编辑器内容（`v-show` 或缓存），仅初次加载时初始化

#### 6.3 模拟构建对话框

点击"模拟构建"打开对话框，分两步（内部 `v-stepper`）：

**步骤 1 · 填写参数**
- 遍历已保存的 `workflow_params`（仅 `alias != null` 的条目）渲染输入控件：
  - `text` → `v-text-field`；`number` → 数字输入；`boolean` → `v-switch`；`image/video/audio` → 文本输入（模拟时不涉及真实上传，直接传字符串值）
- "添加自定义字段"按钮：动态追加一行 `{ key, value, type }`（type 可选 text/number/boolean），供脚本读取自由字段
- 底部"开始模拟"按钮 → 调 `POST /api/workflows/:id/build/simulate`，body 为 `{ script: 编辑器当前内容, params: 合并后的参数 }`
- 请求中携带编辑器**当前内容**（即使未保存也能模拟）

**步骤 2 · 模拟结果**
- 顶部错误区：`simulate` 返回错误时显示 `v-alert`（脚本编译/运行错误、超时），附"返回修改参数"
- 成功时三个视图（`v-tabs` 切换）：
  1. **节点与参数表**：解析构建后的 JSON，复用现有"参数配置"页签的节点/字段表格样式，展示每个节点的字段名与当前值
  2. **画布**：复用 `<WorkflowCanvas :raw-json="builtJson" />`，`height` 约 460px
  3. **JSON**：`<v-textarea readonly>` 展示格式化 JSON + **"下载 JSON"** 按钮（Blob 下载，文件名 `workflow-<id>-build.json`）
- 对话框复用 `WorkflowDetailPage` 现有 `v-dialog` + `v-snackbar` 模式

#### 6.4 类型与页面结构调整

- `types/index.ts`：`WorkflowDetail` 增加 `buildScript`、`buildScriptEnabled`；新增 `SimulateResult` 类型
- `api/workflows.ts`：新增 `getBuildApiTypes()`、`saveBuildScript()`、`simulateBuild()`
- 节点/字段表格解析逻辑若需复用，抽取为组合函数（供"参数配置"页签与模拟结果共用），避免重复实现

### 7. 错误处理

**错误码新增两个**（沿用现有错误码表格式）：

| code | 场景 |
|------|------|
| `build_script_error` | 脚本编译失败 / 运行时抛错 / 返回非对象 |
| `build_script_timeout` | 脚本执行超时（默认 5s） |

**各环节错误行为：**

| 环节 | 行为 |
|------|------|
| 保存脚本（`PUT build-script`） | 仅存储，不执行、不校验（校验发生在模拟/执行时），保存永不因脚本内容失败 |
| 模拟构建（`simulate`） | 返回 `{ error, code }`，前端在结果区 `v-alert` 展示错误与堆栈摘要 |
| 真实执行（`execute`） | 构建失败 → 创建 `failed` 任务日志，`errorMessage` 为 `Dynamic build failed: <原因>`，`code` 取 `build_script_error`/`build_script_timeout`，**不向 ComfyUI 提交** |

错误信息从 worker 线程回传主线程时需**字符串化**（Error 对象无法跨线程序列化，worker 内 `err.message + '\n' + err.stack`）。

## 测试计划

**`build.service.test.ts`（核心）**：
- 正常构建：脚本用 `addNode`/`removeNode`/`connect`/`setInput` 修改工作流，断言返回对象
- 异步脚本：`await new Promise(r => setTimeout(r, 10))` 后返回
- 语法错误 → `ok:false` 且错误信息含位置
- 运行时抛错 → `ok:false` 且含错误消息
- 同步死循环 `while(true){}` → 超时终止，返回 `build_script_timeout`
- 开放 Node 能力：脚本内 `require('fs')` 读取文件成功
- 返回非对象（`null`/数组/字符串）→ `ok:false`
- 辅助函数边界：重复 `addNode` 抛错、`connect` 到不存在节点抛错、`removeNode` 清理指向它的连线

**`workflow.routes.test.ts`（集成）**：
- `PUT /build-script` 保存并回读
- `POST /build/simulate` 成功返回 `{ json }`；脚本报错返回 `{ error, code }`
- `execute` 启用脚本时：先构建后应用别名（构造可断言的构建逻辑，如脚本强制把某节点 `seed` 改为固定值，验证提交的 `comfyuiRequestBody`）
- `execute` 启用脚本但脚本失败 → 任务 `failed`，不提交 ComfyUI（mock `submitPrompt`）
- `execute` 脚本未启用/为空 → 行为与现状完全一致（回归）

**前端**：`vue-tsc --noEmit` 类型验证 + 手动验证 Monaco 加载、模拟对话框三视图、下载 JSON。

## 验证命令

```bash
pnpm --filter server exec tsc --noEmit
pnpm --filter client exec tsc --noEmit
pnpm --filter server test
```
