import { randomUUID } from 'crypto';
import { uploadFileToComfyUI } from './upload.service';
import type { RuntimeParam } from './param.types';

/**
 * 本服务连接 ComfyUI 时使用的稳定 client_id。
 * 提交 /prompt 与 WebSocket `?clientId=` 必须一致，
 * 否则 execution_error 等非广播事件无法送达。
 */
export const COMFYUI_CLIENT_ID: string = randomUUID();

/**
 * 工作流参数配置（别名映射 + 可选默认值覆盖）
 */
export interface WorkflowParam {
  /** 参数行 ID */
  id: number;
  /** 所属工作流 ID */
  workflowId: string;
  /** 节点 ID */
  nodeId: string;
  /** 节点 inputs 字段名 */
  fieldName: string;
  /** 对外别名；null 表示不暴露为可传参字段 */
  alias: string | null;
  /** 展示标签 */
  label: string | null;
  /** 参数类型 text/boolean/number/image/video/audio */
  paramType: string;
  /** 默认值覆盖；null 表示使用 rawJson 原值 */
  defaultValue: string | null;
}

/**
 * 将 DB 静态配置行转换为运行时参数。
 * @param baseParams DB 行列表
 * @returns 运行时参数列表（fileIndex 默认 0）
 */
export function toRuntimeParams(baseParams: WorkflowParam[]): RuntimeParam[] {
  return baseParams.map((p) => ({
    nodeId: p.nodeId,
    fieldName: p.fieldName,
    alias: p.alias,
    label: p.label,
    paramType: p.paramType,
    defaultValue: p.defaultValue,
    fileIndex: 0,
  }));
}

/** 执行工作流的结果 */
export interface ExecutionResult {
  /** 是否成功提交到 ComfyUI */
  success: boolean;
  /** ComfyUI 的响应体（JSON） */
  comfyuiResponse: unknown;
  /** ComfyUI 返回的 prompt_id，为 null 表示提交失败 */
  promptId: string | null;
  /** 错误信息（失败时） */
  errorMessage: string | null;
}

/**
 * 按 paramType 将原始值转换为写入 prompt 的类型。
 * 转换失败时降级为字符串原样写入（不拒绝执行）。
 * @param paramType 参数类型
 * @param raw 请求值或 defaultValue
 * @returns 转换后的值
 */
export function coerceParamValue(paramType: string, raw: unknown): unknown {
  // boolean：已是布尔则直接使用
  if (paramType === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') {
      if (raw === 1) return true;
      if (raw === 0) return false;
      return String(raw);
    }
    const s = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    return String(raw);
  }

  // number：有限数字才转换
  if (paramType === 'number') {
    if (typeof raw === 'number') {
      return Number.isFinite(raw) ? raw : String(raw);
    }
    if (typeof raw === 'boolean') {
      return raw ? 1 : 0;
    }
    const s = String(raw).trim();
    if (s === '') return String(raw);
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    return String(raw);
  }

  // text / media 等：统一字符串
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  return String(raw);
}

/**
 * 将别名请求值与默认值覆盖注入工作流 JSON。
 * 优先级：请求别名值 > defaultValue > rawJson 原值。
 * 写入前按 paramType 做类型转换。
 * @param rawJson 原始工作流 API JSON 字符串
 * @param params 参数配置列表
 * @param aliasValues 请求传入的别名值（可为 string/number/boolean）
 * @returns 注入后的工作流 JSON 字符串
 */
export function applyAliases(
  rawJson: string,
  params: RuntimeParam[],
  aliasValues: Record<string, unknown>,
): string {
  const workflow = JSON.parse(rawJson);

  for (const param of params) {
    // 定位节点
    const node = workflow[param.nodeId];
    if (!node) continue;

    // 跳过节点连接（数组）
    const currentValue = node.inputs?.[param.fieldName];
    if (Array.isArray(currentValue)) continue;

    // 1) 请求值优先（仅当 alias 非空且出现在请求中）
    if (param.alias != null && param.alias !== '' && Object.prototype.hasOwnProperty.call(aliasValues, param.alias)) {
      // 媒体多文件时 aliasValues[alias] 为数组，按 fileIndex 取对应文件
      const raw = aliasValues[param.alias];
      // 数组且目标索引越界（取到 undefined）时跳过注入，保持节点原值，避免写入空字符串
      if (Array.isArray(raw) && raw[param.fileIndex ?? 0] === undefined) continue;
      const value = Array.isArray(raw) ? raw[param.fileIndex ?? 0] : raw;
      node.inputs[param.fieldName] = coerceParamValue(param.paramType, value);
      continue;
    }

    // 2) 默认值覆盖（同样按类型转换）
    if (param.defaultValue != null) {
      node.inputs[param.fieldName] = coerceParamValue(param.paramType, param.defaultValue);
      continue;
    }

    // 3) 保留 rawJson 原值
  }

  return JSON.stringify(workflow);
}

/**
 * 解析实际会提交到 ComfyUI 的别名参数值（含类型转换与 defaultValue 回退）。
 * 仅包含有非空 alias 的参数；值语义与 applyAliases 写入 prompt 时一致。
 * @param params 参数配置列表
 * @param aliasValues 请求/媒体处理后的别名值
 * @returns 转换后的别名 → 值映射（用于任务日志）
 */
export function resolveSubmittedAliasValues(
  params: RuntimeParam[],
  aliasValues: Record<string, unknown>,
): Record<string, unknown> {
  const submitted: Record<string, unknown> = {};

  for (const param of params) {
    // 无别名的参数不对外传参，不记入提交参数日志
    if (param.alias == null || param.alias === '') continue;

    // 1) 请求中带了该别名 → 转换后记录（媒体多文件为数组时按 fileIndex 取元素）
    if (Object.prototype.hasOwnProperty.call(aliasValues, param.alias)) {
      const raw = aliasValues[param.alias];
      const value = Array.isArray(raw) ? raw[param.fileIndex ?? 0] : raw;
      submitted[param.alias] = coerceParamValue(param.paramType, value);
      continue;
    }

    // 2) 未传参但有默认值覆盖 → 转换后记录（与 applyAliases 一致）
    if (param.defaultValue != null) {
      submitted[param.alias] = coerceParamValue(param.paramType, param.defaultValue);
    }

    // 3) 否则依赖 rawJson 原值，日志中不出现该别名
  }

  return submitted;
}

/**
 * 确保请求体 JSON 中包含 client_id（已有则保留）。
 * @param body 原始请求体字符串
 * @returns 注入 client_id 后的请求体字符串；无法解析为对象时原样返回
 */
function ensureClientIdInBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    // 仅对对象请求体注入 client_id
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return body;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.client_id === 'string' && obj.client_id.trim() !== '') {
      return body;
    }
    obj.client_id = COMFYUI_CLIENT_ID;
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

/**
 * 提交 prompt JSON 到 ComfyUI 并返回结果。
 * 自动注入 COMFYUI_CLIENT_ID，使 execution_error 等事件可经 WebSocket 送达。
 * @param body 请求体 JSON 字符串（通常含 prompt）
 * @param comfyuiBaseUrl ComfyUI 基础 URL
 */
export async function submitPrompt(
  body: string,
  comfyuiBaseUrl: string,
): Promise<ExecutionResult> {
  try {
    // 注入稳定 client_id，与 WebSocket 连接保持一致
    const requestBody = ensureClientIdInBody(body);
    const response = await fetch(`${comfyuiBaseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });
    const text = await response.text();
    let responseBody: unknown;
    try { responseBody = JSON.parse(text); } catch { responseBody = text; }
    if (!response.ok) {
      return {
        success: false,
        comfyuiResponse: responseBody,
        promptId: null,
        errorMessage: `ComfyUI returned status ${response.status}: ${text}`,
      };
    }
    const promptId = (responseBody as { prompt_id?: string }).prompt_id ?? null;
    return {
      success: true,
      comfyuiResponse: responseBody,
      promptId,
      errorMessage: null,
    };
  } catch (err: unknown) {
    return {
      success: false,
      comfyuiResponse: null,
      promptId: null,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * 处理媒体参数：将上传的文件发送到 ComfyUI，返回最终 aliasValues。
 * 无别名的参数不参与对外媒体上传。
 * 同别名被多个参数引用（或该别名文件数 > 1）时，result[alias] 为文件名数组
 * （按 files[alias] 上传顺序），供 applyAliases 按 fileIndex 分别注入；否则为单文件名 string。
 * @param params 参数配置列表
 * @param aliasValues 请求传入的别名值
 * @param files 按别名分组的上传文件
 * @param comfyuiBaseUrl ComfyUI 服务地址
 * @returns 合并上传结果后的别名值（媒体多文件时值为 string[]）
 */
export async function processMediaParams(
  params: RuntimeParam[],
  aliasValues: Record<string, unknown>,
  files: Record<string, { buffer: Buffer; originalname: string; mimetype: string }[]>,
  comfyuiBaseUrl: string,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...aliasValues };

  // 统计每个媒体别名被多少个参数引用（决定单文件返回 string 还是数组）
  const mediaAliasCount: Record<string, number> = {};
  for (const param of params) {
    if (!['image', 'video', 'audio'].includes(param.paramType)) continue;
    if (param.alias == null || param.alias === '') continue;
    mediaAliasCount[param.alias] = (mediaAliasCount[param.alias] ?? 0) + 1;
  }

  // 已处理的媒体别名（每个别名只上传一次，避免同别名多参数重复上传同一批文件）
  const processedAliases = new Set<string>();

  for (const param of params) {
    // 仅处理媒体类型；boolean/number/text 不走上传
    if (!['image', 'video', 'audio'].includes(param.paramType)) continue;
    // 无别名的参数不参与对外媒体上传
    if (param.alias == null || param.alias === '') continue;
    // 该别名已被前面的参数上传过，跳过（同一别名只上传一次）
    if (processedAliases.has(param.alias)) continue;
    const fileList = files[param.alias];
    if (!fileList || fileList.length === 0) continue;
    processedAliases.add(param.alias);

    // 同别名多参数或多文件 → 上传全部文件返回数组；否则返回单文件名（兼容既有行为）
    const multi = mediaAliasCount[param.alias] > 1 || fileList.length > 1;
    if (multi) {
      const names: string[] = [];
      for (const file of fileList) {
        const filename = await uploadFileToComfyUI(
          file,
          param.paramType as 'image' | 'video' | 'audio',
          comfyuiBaseUrl,
        );
        names.push(filename);
      }
      result[param.alias] = names;
    } else {
      const filename = await uploadFileToComfyUI(
        fileList[0],
        param.paramType as 'image' | 'video' | 'audio',
        comfyuiBaseUrl,
      );
      result[param.alias] = filename;
    }
  }
  return result;
}

/** 中断后确认停止的轮询间隔（ms） */
const INTERRUPT_POLL_INTERVAL = 500;
/** 中断后确认停止的最大轮询次数（超过后放弃等待，返回失败）；500ms × 120 ≈ 60s */
const INTERRUPT_MAX_ATTEMPTS = 120;

/** 延迟指定毫秒数，用于中断轮询的节流 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 查询指定 prompt 是否仍在 ComfyUI 执行队列中。
 * 通过 GET /queue 检查 queue_running 中是否包含该 prompt_id；
 * 请求失败或响应结构异常时保守返回 true（无法确认已停止）。
 * @param comfyuiBaseUrl ComfyUI 基础 URL
 * @param promptId 要检查的 ComfyUI prompt_id
 * @returns 仍在执行返回 true；已离开执行队列返回 false
 */
export async function isPromptRunning(comfyuiBaseUrl: string, promptId: string): Promise<boolean> {
  try {
    const response = await fetch(`${comfyuiBaseUrl}/queue`);
    if (!response.ok) return true;
    const data: unknown = await response.json();
    const queueRunning = (data as { queue_running?: unknown }).queue_running;
    // 响应结构异常时无法判断，保守视为仍在运行
    if (!Array.isArray(queueRunning)) return true;
    return queueRunning.some((entry: unknown) => {
      // queue_running 每个条目形如 [prompt_id, workflow, extra]
      if (!Array.isArray(entry) || entry.length < 1) return false;
      return entry[0] === promptId;
    });
  } catch {
    // 网络异常时无法确认，保守视为仍在运行
    return true;
  }
}

/**
 * 中断 ComfyUI 当前正在执行的 prompt，并在中断后轮询确认其已停止执行。
 * 轮询发现目标 prompt 仍在执行队列中时，会重新调用 /interrupt 接口，直至确认停止或超时。
 * 仅在首次中断请求成功且提供了 promptId 时才进行轮询。
 * @param comfyuiBaseUrl ComfyUI 基础 URL
 * @param promptId 目标 prompt_id；为空时只发送一次中断请求、不轮询
 * @param options 可选配置（供测试缩短轮询间隔/次数）
 * @returns 是否已确认目标 prompt 停止执行；未提供 promptId 时等价于中断请求是否成功
 */
export async function interruptPrompt(
  comfyuiBaseUrl: string,
  promptId?: string,
  options?: { pollIntervalMs?: number; maxAttempts?: number },
): Promise<boolean> {
  const pollIntervalMs = options?.pollIntervalMs ?? INTERRUPT_POLL_INTERVAL;
  const maxAttempts = options?.maxAttempts ?? INTERRUPT_MAX_ATTEMPTS;
  try {
    // 1) 首次发送中断请求；失败则直接返回（无法连上 ComfyUI 时无需轮询）
    const first = await fetch(`${comfyuiBaseUrl}/interrupt`, { method: 'POST' });
    if (!first.ok) return false;
    // 无 promptId 时无法定向确认是否已停止，仅中断一次
    if (!promptId) return true;

    // 2) 轮询确认目标 prompt 已离开执行队列；仍在执行则重新调用中断接口
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const stillRunning = await isPromptRunning(comfyuiBaseUrl, promptId);
      if (!stillRunning) return true; // 已确认停止执行
      // 仍在执行 → 重新发送中断请求（单次失败不中断轮询，下一轮会再次重试）
      try {
        await fetch(`${comfyuiBaseUrl}/interrupt`, { method: 'POST' });
      } catch {
        // 忽略单次中断失败，继续轮询
      }
      await sleep(pollIntervalMs);
    }
    // 轮询超时仍未确认停止 → 返回失败
    return false;
  } catch {
    return false;
  }
}

/**
 * 提交工作流到 ComfyUI 执行
 * 不会抛出网络或 HTTP 异常，所有错误通过 ExecutionResult.errorMessage 返回
 */
export async function executeWorkflow(
  rawJson: string,
  params: RuntimeParam[],
  aliasValues: Record<string, unknown>,
  comfyuiBaseUrl: string,
): Promise<ExecutionResult> {
  try {
    const modifiedJson = applyAliases(rawJson, params, aliasValues);
    const body = JSON.stringify({ prompt: JSON.parse(modifiedJson) });
    return submitPrompt(body, comfyuiBaseUrl);
  } catch (err: unknown) {
    return {
      success: false,
      comfyuiResponse: null,
      promptId: null,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
