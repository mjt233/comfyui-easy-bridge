# 交付物 2：Bridge「自动清理开关不生效」修复方案（设计，未实施）

## 1. 问题定性

`config.autoCleanup` 是**声明存在、行为缺失**的开关：

| 位置 | 现状 | 是否读到 `autoCleanup` |
|---|---|---|
| 前端开关 | `SettingsPage.vue:159-165`，且 `inputDir` 输入框 `v-if="providerForm.autoCleanup"`（**只有开启才显示**） | 仅用于显示 |
| 类型/持久化 | `types.ts:53`、`provider.service.ts:640-647` 正常存取 | 存取 |
| 文档 | `docs/workflow-api.md:130` 明确写「当 `autoCleanup = true` **且**配置了 `inputDir` 时…才会删除」 | 声明了正确语义 |
| **实际删除** | `comfyui.provider.ts:102-108` 只判断 `inputDir` 是否为空，随后 `fs.unlink` | **❌ 从不读取** |
| **调用方** | `execution.service.ts` 6 处 + `workflow.controller.ts` 2 处全部无条件调用 | ❌ 从不读取 |

即：**只要 `inputDir` 非空就删**。用户为了 `VHS_LoadVideoPath` 需要绝对路径而填写 `inputDir`，就在开关为 `false` 的情况下激活了删除——与 UI、文档双重矛盾。附带后果：任务终态删除 ComfyUI 正在引用的输入资产，会触发交付物 1 里的崩溃链。

## 2. 修复目标与语义收敛

1. `autoCleanup=false`（默认）→ **任何路径都不删除**上传资产。
2. `autoCleanup=true` + `inputDir` 非空 → 任务终态删除本次上传的资产（现状行为，保留）。
3. `autoCleanup=true` + `inputDir` 为空 → 跳过并记日志（现状行为，保留）。
4. `simulateBuild` 预览上传的文件是**纯预览产物**（只用于回显注入后的 JSON，不参与执行）→ 无论开关如何，**始终立即清理**（保留现状，避免预览垃圾堆积）。
5. `inputDir` 语义收敛为「为删除服务的本地输入目录路径」，在 UI/文档中明确写出「不用于解析文件路径」。

## 3. 改动清单（4 个文件 + 3 处测试 + 2 处文档）

### 3.1 `packages/server/src/services/providers/types.ts`

给 `ExecutionProvider` 增加只读能力查询（放 `cleanupUploadedFiles?` 旁边）：

```ts
  /**
   * 是否启用「任务终态自动清理上传资产」。
   * 仅 comfyui 提供商支持（依赖 config.autoCleanup）；未实现该方法的提供商一律视为 false。
   * 供上层服务在调用 cleanupUploadedFiles 前判断，避免"配置关不掉删除行为"。
   * @returns true 表示允许在任务终态删除本次上传的资产
   */
  getAutoCleanup?(): boolean;
```

### 3.2 `packages/server/src/services/providers/comfyui.provider.ts`

1. 新增 `getAutoCleanup()`：

```ts
  /**
   * 是否启用任务终态自动清理上传资产。
   * 未配置（undefined）时视为关闭，与 provider.service 的规范化结果一致。
   * @returns 配置的 autoCleanup 布尔值
   */
  getAutoCleanup(): boolean {
    return this.config.autoCleanup === true;
  }
```

2. 在 `cleanupUploadedFiles` 补上缺失的判断（**双保险**：即使调用方漏判也不会误删）：

```ts
  async cleanupUploadedFiles(filenames: string[]): Promise<void> {
    // 开关关闭时绝不删除：inputDir 仅表示"输入目录在哪"，不代表"允许删除"
    if (!this.getAutoCleanup()) return;
    const inputDir = this.config.inputDir?.trim();
    if (!inputDir) { /* 原有日志与 return 保持不变 */ }
    ...
  }
```

> 注意：现有日志文案 `autoCleanup enabled but inputDir is empty` 此时才名副其实，无需改动。

### 3.3 `packages/server/src/services/cleanup.service.ts`

在服务层增加显式开关与强制参数（让「为什么删」在调用点可读）：

```ts
/** 清理行为选项 */
export interface CleanupOptions {
  /** 强制清理：忽略 provider 的 autoCleanup 设置（仅用于预览产物等"必然不再被使用"的场景） */
  force?: boolean;
}

/**
 * 触发执行提供商清理任务的上传资产（fire-and-forget）。
 * 默认遵循 provider 的自动清理开关：getAutoCleanup() 为 false 时直接跳过，不产生任何删除。
 * @param provider 任务使用的执行提供商
 * @param uploadedFilesJson 任务 uploadedFiles 字段的 JSON 字符串
 * @param options 清理选项（force=true 用于 simulateBuild 预览产物）
 */
export function cleanupTaskUploads(
  provider: ExecutionProvider,
  uploadedFilesJson: string | null | undefined,
  options: CleanupOptions = {},
): void {
  // 提供商未实现清理能力（如 RunningHub）时直接跳过
  if (typeof provider.cleanupUploadedFiles !== 'function') return;
  // 未强制且提供商未开启自动清理时不删除（修复：原先只看 inputDir，开关形同虚设）
  if (!options.force && provider.getAutoCleanup?.() !== true) return;
  const filenames = parseUploadedFiles(uploadedFilesJson);
  if (filenames.length === 0) return;
  provider.cleanupUploadedFiles(filenames).catch((err: unknown) => {
    console.error(`[Cleanup:${provider.id}] cleanup uploaded files failed`, err);
  });
}
```

### 3.4 `packages/server/src/controllers/workflow.controller.ts`

仅预览路径显式强制（`446` 行）：

```ts
        // 预览上传的文件不参与任何执行，属纯预览产物：忽略 autoCleanup 开关立即清理
        cleanupTaskUploads(provider, JSON.stringify(...), { force: true });
```

执行路径（`947` 行）与 `execution.service.ts` 的 6 处**保持原样调用**——它们将自动遵循开关，无需改动，这正是把判断放在 service/provider 两层的好处。

## 4. 行为矩阵（修复后）

| `autoCleanup` | `inputDir` | 任务终态 | `simulateBuild` 预览 | 备注 |
|---|---|---|---|---|
| false（默认/你当前） | 任意（含已填） | **不删除** | 删除预览产物 | ✅ 修复点 |
| true | 非空 | 删除本次上传 | 删除预览产物 | 原有功能 |
| true | 空 | 跳过 + 警告日志 | 删除预览产物 | 原有功能 |
| 未实现该能力的提供商（runninghub/group） | — | 不删除 | 不删除 | 现状 |

## 5. 测试计划

| 文件 | 用例 |
|---|---|
| `comfyui.provider.test.ts`（新增 2） | ① `autoCleanup=false` + `inputDir` 已配置 → 文件**仍存在**（回归锁定本次缺陷）；② `getAutoCleanup()` 在 undefined/false/true 三种配置下的返回值 |
| `cleanup.service.test.ts`（新增 3） | ① provider `getAutoCleanup()` 返回 false → 不调用 `cleanupUploadedFiles`；② `{ force: true }` → 即使 false 也调用；③ provider 未实现 `getAutoCleanup` → 视为 false 不删除 |
| 现有测试 | 该文件底部 3 个用例（`uploadedFiles` 为空 / 未实现清理 / 调用异常）逻辑不变，需给 provider 桩补 `getAutoCleanup`；`comfyui.provider.test.ts` 现有 `makeProviderWithInputDir` 用 `autoCleanup: true`，不受影响 |

## 6. 文档同步

1. `docs/workflow-api.md:127 / :130`：补一句「`inputDir` 仅作为删除时的本地路径来源，不用于解析文件路径；关闭 `autoCleanup` 时填写它不会导致任何删除」。
2. `AGENTS.md`（执行提供商小节）：补「`autoCleanup=false` 时**绝不删除**；`simulateBuild` 预览产物始终清理」。
3. 建议（可选）：`SettingsPage.vue:162` 的 hint 增补风险提示——「开启后每次任务结束都会删除本机输入目录中的本次上传文件；若 ComfyUI 缓存仍持有对该文件的延迟引用，可能导致其 prompt 工作线程异常，请确认 ComfyUI 已重启或缓存已清空」。

## 7. 实施顺序与验证

1. 先改 `comfyui.provider.ts`（补判断 + getter）→ 跑 `pnpm --filter server test`。
2. 再改 `cleanup.service.ts` + controller 预览路径 → 补测。
3. 更新文档；执行 AGENTS.md 要求的两条类型校验：
   - `pnpm --filter server exec tsc --noEmit`
   - `pnpm --filter client exec tsc --noEmit`
4. 手工验证：把 `autoCleanup` 关掉、`inputDir` 保持非空，跑一个任务，确认任务终态后 `ComfyUI-Shared\input\` 里的上传文件**仍在**；再打开开关跑一次，确认被删除。

## 8. 未纳入本方案的相关项（需另行决策）

- **终态清理本身的时序风险**：即使开关正确开启，删除也会让 ComfyUI 缓存里的延迟引用失效（交付物 1 的崩溃链）。可选的后续增强：删除前校验该 prompt 已无缓存引用、或对「最近 N 分钟内的上传」延迟删除。属于独立设计，不在本次修复范围。
- **崩溃后的任务状态**：当前 ComfyUI 工作线程死亡时，任务会永久停留在 `pending`（bridge 只能靠 history 连续失败计数兜底）。可作为单独改进项。
