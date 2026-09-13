# VHS_BatchManager 分批执行的终态误判：根因分析与修复方案（设计，未实施）

- 状态：**未实施**（本文仅记录排查结论与方案评估，代码零改动）
- 触发场景：ComfyUI Easy Bridge 调用含 `VHS_BatchManager` + `VHS_LoadVideo` + `VHS_VideoCombine` 的工作流（示例工作流 `seedvr2`），视频被拆分成多个 meta batch 处理
- 现象：**第一批处理完成后，任务即被标记为「已完成」，且输出文件列表为空（前端显示「无输出文件」）**，而 ComfyUI 侧任务实际仍在继续跑后续批次
- 排查环境：ComfyUI 0.35.1（`C:\Users\xiaotao\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI`）、comfyui-videohelpersuite

---

## 1. 根因

不是 Bridge「误判」，而是 **VHS 的 meta batch 把一次工作流执行拆成了 N 个独立 prompt**，而 Bridge 只跟踪第一次提交返回的那个 `prompt_id`。

三个环节叠加导致必然误判：

### 1.1 VHS 每批 requeue 成**新的 prompt_id**

`videohelpersuite/nodes.py:551-552` 每批处理完都调用 `requeue_workflow(...)`，其实现（`videohelpersuite/utils.py:168-222`）把**整个 workflow 重新塞回 ComfyUI 队列**并生成全新的 `prompt_id`：

```python
number = -server.PromptServer.instance.number
server.PromptServer.instance.number += 1
prompt_id = str(server.uuid.uuid4())
prompt_queue.put((number, prompt_id, prompt, extra_data, outputs_to_execute, sensitive))
```

对 ComfyUI 而言这就是 N 次互不相干的 `POST /prompt`，Bridge 手里只有第 1 个 `prompt_id`。

### 1.2 中间批次**从设计上就不产出输出文件**（不是 bug）

`videohelpersuite/nodes.py:551-567`：

```python
if meta_batch is not None:
    requeue_workflow((meta_batch.unique_id, not meta_batch.has_closed_inputs))
if meta_batch is None or meta_batch.has_closed_inputs:
    ...  # 关闭 ffmpeg 管道、汇总 output_files、返回 {"ui": {"gifs": [preview]}}
else:
    # batch is unfinished
    return {"ui": {"unfinished_batch": [True]}, "result": ((save_output, []),)}
```

mp4/gif 采用 ffmpeg 流式写入，必须等最后一批才能 finalize 并 mux 音频；中间批次提前返回，**只发出 `unfinished_batch` 标记，不注册任何文件**。

### 1.3 ComfyUI 每批都广播 `execution_success`，Bridge 据此判定终态

- `execution.py:824`：每轮执行循环正常结束都发送 `execution_success`（requeue 出来的是新队列任务，同样走完整流程）
- `packages/server/src/services/execution.service.ts:486-487`：`case 'execution_success': completeTask(promptId)`
- `execution.service.ts:374-386`：`completeTask` 立即置 `completed`，随后 `fetchHistoryAndExtractOutputs(promptId)`
- `execution.service.ts:149-185` `parseHistoryOutputs` 只遍历 `outputs` 下的**数组型** key；`unfinished_batch` 的值虽是数组但元素不是文件对象（无 `filename`）→ 解析结果为空
- `execution.service.ts:412`：`if (files.length === 0) return;` → **不写 `output_files`**

### 1.4 为什么后续补救拿不到文件

| 读路径 | 用的 prompt_id | 结果 |
|---|---|---|
| 完成时 `fetchHistoryAndExtractOutputs` | 第 1 个 | 无文件 |
| `task.controller.ts:120-166` `listOutputFiles` 回源兜底（含 2s 重试，见 `outputHistoryBackfillConfig`） | 仍是 `task.promptId` = 第 1 个 | 无文件 |

文件只出现在**最后一批那个新 `prompt_id`** 的 history 下，Bridge 完全不知道它的存在。

### 1.5 同时被掩盖的衍生缺陷（同一根因）

1. **并发槽位提前释放**：`completeTask` 末尾 `afterSlotReleased()` → 第一批结束就让出并发额度，`concurrency=1` 的限流失效，后续排队任务可与仍在跑的批次并行提交。
   - 补充风险：VHS 的 `requeue_workflow` 内含 `assert(len(prompt_queue.currently_running) == 1)`，同实例并发 >1 时会踩到该断言。
   - 注：`provider.service.ts:227` 建实例默认 `concurrency=1`，属于规避而非保证。
2. **上传资产提前删除**：`execution.service.ts:381` 在伪终态触发 `cleanupTaskUploads`（`cleanup.service.ts:36-51`）；当 `autoCleanup=true` 时会删除后续批次仍在读取的输入视频。
3. **`isPromptRunning` 对链无效**：`providers/shared.ts:110-129` 只在 `queue_running` 里按单个 prompt_id 查找，链上换 id 后必然返回 `stopped`。当前仅 `ComfyUIProvider.isPromptRunning` 与 RunningHub 引用，跟踪器未使用，属潜在坑。
4. **取消只停当前批次**：`task.controller.ts:284-336` 的 `interrupt` 仅作用于当前运行 prompt；用户取消后链上剩余批次仍会继续（独立缺陷，见 §7）。

---

## 2. 实测证据

### 2.1 用户真实运行（seedvr2 / AnimateDiff_00009）

`VHS_BatchManager(frames_per_batch=6, count=11)`，共 20+ 个批次，全部 `status=success completed=true`：

```
81d6c678…(requeue=1)   outputs={"144":{"unfinished_batch":[true]}}                    ← Bridge 在这一步即判完成
…（中间 20 条同样无文件）
425fa9f2…(requeue=20)  outputs={"144":{"gifs":[{"filename":"AnimateDiff_00009-audio.mp4"}]}}  ← 仅最后一批有文件
```

ComfyUI 日志（`%APPDATA%\Comfy Desktop\logs\app.log_2026-09-13T06-23-30-102Z.log`）证实每个批次都是一次独立执行：

```
Meta-Batch 1/67 … Meta-Batch 12/67
[INFO] got prompt / [INFO] Prompt executed in 21.53 seconds   （逐批成对出现）
```

### 2.2 定向复现（`VHS_LoadVideo` + `VHS_BatchManager(frames_per_batch=2)` + `VHS_VideoCombine`）

WebSocket 全程录制，共观察到 **54 个不同 prompt_id**：

- 每个 prompt 都发出自己的 `execution_start` 与 `execution_success`
- 前 53 个的 `executed` 事件输出均为 `{"unfinished_batch":[true]}`
- 第 54 个为 `{"gifs":[{"filename":"ZZ_probe_00001.mp4"}]}`

### 2.3 「输出形态」核对清单（用于评估误判风险，见 §5）

| 工作流形态 | 实测 `history.outputs` | 是否含 `unfinished_batch` |
|---|---|---|
| SaveImage 实图 | `{6:{images:[{filename,type:"output"}]}}` | 否 |
| PreviewImage | `{7:{images:[{filename,type:"temp"}]}}` | 否 |
| VideoCombine（无 meta_batch） | `{3:{gifs:[{filename,type:"output"}]}}` | 否 |
| VideoCombine `save_output=false` | `{3:{gifs:[{filename,type:"temp"}]}}` | 否 |
| **meta batch 链中间批次** | `{3:{unfinished_batch:[true]}}` | **是** |
| **meta batch 链最后批次** | `{3:{gifs:[{filename,…}]}}` | 否 |

**关键事实**：`unfinished_batch` 这个键在整机（ComfyUI 核心 + 全部 `custom_nodes`，排除 `.venv`）内**只有** `videohelpersuite/nodes.py:567` 产出；ComfyUI 核心零命中。

---

## 3. 修复方向评估

### 3.1 各方向对比

| 方向 | 做法 | 正确性 | 静默失效风险 | 影响范围 | 工作量 | 结论 |
|---|---|---|---|---|---|---|
| **A 标记识别** | history 中出现 `unfinished_batch` 时不判终态 | 高（确定性握手） | 中（依赖 VHS 私有键） | 仅 `execution.service.ts` | 小 | **推荐** |
| B 链认领 | 轮询 `/queue` + `/history`，按节点签名 + `requeue` 字段认领后继 prompt_id | 中（启发式 + 竞态） | 高（误认领会串输出） | 跟踪器 / provider 接口 / 控制器 / 可能 DB | 大 | 可选；如需「中断整链」 |
| C 静默窗口 | 任务保持 pending，连续 N 轮无新 prompt 即认为链结束 | 低（本质是猜） | 高 | 跟踪器 | 中 | **排除** |
| D 拒绝 meta batch | 提交前静态检查，命中则拒绝并给出错误码 | 高 | 无 | 校验层 | 极小 | 仅作临时护栏 |
| E 上游配合 | 推动 VHS 让 `unfinished_batch` 携带可关联信息 | 高 | 无 | 第三方插件 | 不可控 | 长期 |
| F 代持 requeue | Bridge 自己逐批提交 | — | — | — | — | **不可行**（BatchManager 的 `inputs`/`outputs`/ffmpeg 子进程状态活在 ComfyUI 进程内存里，跨 prompt 存活，外部无法续接） |

### 3.2 方向 B / C 被排除的具体理由

- **B**：`requeue` 字段是唯一能区分「首个」与「后继」的抓手，但 VHS 的首个 prompt 里可以没有该字段（实测两种形态都出现过，见 §2.1 与 §2.2）；「节点集合 + class_type 相同」也可能命中同实例上另一条同工作流任务 → 误认领会把两个任务的输出混在一起。`requeue` 值还会重复（实测出现两个 `requeue=53`），不能用于排序。链状态只能放内存，Bridge 重启即丢，正在跑的长任务会永久 pending。
- **C**：批次间隔差异极大（实测真实任务批次间隔达分钟级），静默窗口必须设得很大 → 每个任务固定多等一个窗口；且仍无法确知链的最后一个 prompt 是谁，用户此时在 ComfyUI UI 手动跑同工作流就会取到别人的输出。相比 A 没有换来任何确定性。

---

## 4. 推荐方案：方向 A + 超时护栏

### 4.1 语义收敛

**只新增一个判断条件**：`history.outputs` 中出现 `unfinished_batch` 键 → 该 prompt 是链条中间态，**不落终态、不释放槽位、不触发清理/暂存释放**；否则照旧。

判定依据（`execution.py:407-414`、`:563`）：节点返回的 ui 为空字典时 `len(output_ui) > 0` 为假，该节点根本不进 `ui_outputs`，因此**「无输出」与「批次未完成」在 history 里天然可区分**。

### 4.2 改动点（预估）

| 文件 | 改动 |
|---|---|
| `packages/server/src/services/execution.service.ts` | `resolveHistoryOutcome` 增加 `unfinished_batch` 检测 → 返回 `{kind:'running'}`；WS 的 `execution_success` 分支不再直接 `completeTask`，改走同一判定；新增「批次链超时」护栏 |
| `packages/server/src/services/execution.service.ts`（配置） | `executionServiceConfig` 增加 `maxBatchChainMs` 之类的上限阈值 |
| 测试 | `execution.service.test.ts` 增加标记识别、超时收敛、最后一批正常完成三类用例 |
| `docs/`、`AGENTS.md` | 记录该行为与阈值配置 |

`task.controller.ts` 的输出回源兜底**无需改动**（终态推迟后，本地已在完成时写入 `outputFiles`）。

### 4.3 处理 WS 路径的时序竞态

`execution_success` 在 `execute_async` 内发送（`execution.py:824`），而 history 条目由 `task_done` 稍后写入（`execution.py:1286-1305`）。若 WS 成功分支立即回查 history，可能读到空条目。建议：判定为「无条目」时继续轮询，而不是落终态（只会让最后一批晚 ~10s 由兜底轮询收尾，**不会错判**）。

### 4.4 护栏（必须项，非可选）

存在**合法但永不 requeue** 的批次链，会让任务永久 pending。已构造并实测确认：

```json
{ "1": VHS_LoadVideo(frame_load_cap=4),        // 未连接 meta_batch
  "3": VHS_VideoCombine(meta_batch=[4,0]),
  "4": VHS_BatchManager(frames_per_batch=2) }
```
结果：`status=success completed=true`，`outputs={"3":{"unfinished_batch":[true]}}` —— 标记发了，但 `nodes.py:552` 的 `requeue_workflow` 因 `has_closed_inputs` 已成 `true` 而**不触发 requeue**。

同类情形还有：LoadVideo 中途抛错、用户在 ComfyUI UI 手动清队列、ComfyUI 进程被杀。

因此需要「自首次进入 pending 起」的全局上限，超时后按失败收敛并给出可读文案（而非无限等待）。

---

## 5. 方向 A 的误判风险核查（结论：非 meta-batch 工作流影响为零）

### 5.1 问题一：是否影响其他类型工作流

不影响。判定条件只看 `unfinished_batch` 是否存在，「有没有输出文件」不在条件里。见 §2.3 核对清单：所有非 meta-batch 形态实测均为「否」。

必要代价（是修复本身的语义变化，不是副作用）：

- 任务终态时间从「第一个批次结束」推迟到「整条链结束」（真实任务 20 批 → 终端显示「已完成」最多晚 20 分钟，但这是**正确**的终态时间）。
- 并发槽位、`autoCleanup`、`releaseStaged` 的时机随之全部变正确。
- 中断语义更真实：原先点取消后先落 `failed`（链路仍在跑），现在保持 `pending` 直到真正停止，`interrupt_unconfirmed`（`task.controller.ts:313-321`）已有行为正好兜住。

### 5.2 问题二：真正「无输出资源」的工作流会不会被误留 pending

不会。两条路径都碰不到该标记：

**路径 1：图里没有输出节点 → ComfyUI 在提交期直接拒绝**（不会执行，Bridge 侧任务直接建为 `failed`）

```
{"error":{"type":"prompt_no_outputs","message":"Prompt has no outputs"}}
```

实测：只放 `VHS_LoadVideo + VHS_VideoInfo`、或整图只有 `VHS_BatchManager`，均在 `POST /prompt` 阶段被拒。原因：`VHS_VideoInfo` 未声明 `OUTPUT_NODE`，被 ComfyUI 当作未使用节点剔除。

**路径 2：有输出节点，但该节点不注册 ui → `outputs` 里根本没有它**

`execution.py:407-414` 的 ui 为空字典时不进 `ui_outputs`。history 为 `status_str=success / completed=true`，`outputs` 为空或没有该节点 → 判定完成、`output_files` 仍为 null、前端仍显示「无输出文件」，**与今天完全一致**。

附带实测结论（本实例上「执行成功且零文件」很难构造，三条窄路都被堵死）：

| 构造 | 实测结果 |
|---|---|
| VHS 零帧（`skip_first_frames=999999`） | `VHS_LoadVideo` 抛 `No frames generated`（error） |
| `EmptyImage(width=0,height=0)` | 校验期拒绝（`value_smaller_than_min`） |
| `PreviewImage` / `VideoCombine(save_output=false)` | 落 temp 目录，**仍注册文件条目**（`type:"temp"`） |

即：这类实例上「成功但无输出」主要表现为「节点不注册 ui」；只要节点注册了 ui，就必然带文件名。

### 5.3 残留风险（次要）

1. **键名冲突**：若 VHS 被本地魔改／分支版重命名该键，修复静默失效，退化为今天的行为（完成但无输出），不产生新错误。若有其他插件恰好也用 `unfinished_batch`，该任务会一直 pending 直到护栏超时。概率极低（本机零命中），后果被护栏限制为「延迟收敛」。
2. **误用不会挂住**：`BatchManager` 只被 `VideoCombine` 消费 + `image/gif` 格式时，会提前抛 `Pillow('image/') formats are not compatible with batched output` → 走失败路径；`BatchManager` 未被任何节点消费时会被 ComfyUI 剔除，不影响判定。

---

## 6. 待决策项

1. **护栏阈值**：批次链超时上限取多长？定得太短会误杀长视频任务（实测真实任务单批 ~21s、20+ 批），太长则异常场景收敛慢。
2. **超时后落哪个状态**：落 `failed`（带说明文案，推荐，语义清晰）还是回退成今天的「完成但无输出」（保底不改变用户既有观感）。
3. **是否一并处理「中断整链」**：当前 `interrupt` 只停当前批次。若要停整链，需引入链状态（即方向 B 的一部分），属独立增强。
4. **是否加临时护栏 D**：在方向 A 落地前，是否先对检测到 meta batch 的工作流给出显式拒绝/警告。

---

## 7. 不在本方案范围内的相关项

- **中断整链**（`task.controller.ts` 的 `interrupt` 仅作用于当前 prompt）。
- **`isPromptRunning` 对 requeue 链失效**（`providers/shared.ts:110-129`）——当前无调用方，属潜在坑。
- **同实例并发 >1 时 VHS 的 `assert` 崩溃风险**——由 `concurrency=1` 默认值规避，非强保证。

---

## 8. 验证方式（实施后）

1. 单测：`pnpm --filter server test`
2. 类型校验：`pnpm --filter server exec tsc --noEmit`、`pnpm --filter client exec tsc --noEmit`
3. 端到端：跑一个 `frames_per_batch` 较小的 meta batch 工作流，确认
   - 中间批次期间任务保持 `pending`，并发槽位不释放；
   - 最后一批结束后任务转 `completed` 且 `output_files` 非空；
   - 全程未出现「已完成但输出文件为空」。
4. 回归：跑一个非 meta batch 工作流 + 一个无输出节点工作流，确认行为与修复前一致。

---

## 附：根因相关代码位置索引

| 位置 | 作用 |
|---|---|
| `videohelpersuite/nodes.py:551-567` | 中间批次提前返回、只发 `unfinished_batch` |
| `videohelpersuite/nodes.py:634` | 最后批次返回 `{"ui": {"gifs": [preview]}}` |
| `videohelpersuite/nodes.py:819-877` | `BatchManager`（`unique_id` 维度的进程内状态） |
| `videohelpersuite/utils.py:168-222` | `requeue_workflow_unchecked` 生成新 `prompt_id` |
| ComfyUI `execution.py:824` | 每批广播 `execution_success` |
| ComfyUI `execution.py:407-414`、`:563` | ui 为空则不注册 → 「无输出」与「批次未完成」可区分 |
| ComfyUI `execution.py:1286-1305` | `task_done` 写入 history |
| `execution.service.ts:82-125` | `resolveHistoryOutcome`（终态判定的唯一真源） |
| `execution.service.ts:374-386`、`:486-487` | `completeTask` 与 WS 成功分支 |
| `execution.service.ts:149-185` | `parseHistoryOutputs` |
| `task.controller.ts:120-166` | 输出回源兜底（仅用 `task.promptId`） |
| `cleanup.service.ts:36-51`、`comfyui.provider.ts:111-139` | 终态清理上传资产 |
| `packages/client/src/pages/TaskListPage.vue:308` | 前端「无输出文件」渲染 |
