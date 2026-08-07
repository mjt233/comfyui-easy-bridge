import { COMFYUI_CLIENT_ID, type ExecutionResult, type OutputFileRef } from './types';

/** 延迟指定毫秒数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * 提交 prompt JSON 到执行端并返回结果。
 * 自动注入稳定 client_id，使 execution_error 等事件可经 WebSocket 送达。
 * @param baseUrl 执行端基础 URL
 * @param body 请求体 JSON 字符串（通常含 prompt）
 * @returns 提交结果；网络/HTTP 异常不抛出，通过 ExecutionResult.errorMessage 返回
 */
export async function submitPromptRequest(baseUrl: string, body: string): Promise<ExecutionResult> {
  try {
    // 注入稳定 client_id，与 WebSocket 连接保持一致
    const requestBody = ensureClientIdInBody(body);
    const response = await fetch(`${baseUrl}/prompt`, {
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
        errorMessage: `Executor returned status ${response.status}: ${text}`,
      };
    }
    const promptId = (responseBody as { prompt_id?: string }).prompt_id ?? null;
    return { success: true, comfyuiResponse: responseBody, promptId, errorMessage: null };
  } catch (err: unknown) {
    return {
      success: false,
      comfyuiResponse: null,
      promptId: null,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/** 中断后确认停止的轮询间隔（ms） */
const INTERRUPT_POLL_INTERVAL = 500;
/** 中断后确认停止的最大轮询次数（超过后放弃等待，返回失败）；500ms × 120 ≈ 60s */
const INTERRUPT_MAX_ATTEMPTS = 120;

/**
 * 查询指定 prompt 是否仍在执行队列。
 * 通过 GET /queue 检查 queue_running 中是否包含该 prompt_id；
 * 请求失败或响应结构异常时保守返回 true（无法确认已停止）。
 * @param baseUrl 执行端基础 URL
 * @param promptId 要检查的 prompt_id
 * @returns 仍在执行返回 true；已离开执行队列返回 false
 */
export async function isPromptRunningRequest(baseUrl: string, promptId: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/queue`);
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
 * 中断执行端当前正在执行的 prompt，并在中断后轮询确认其已停止。
 * 轮询发现目标 prompt 仍在执行队列中时，会重新调用 /interrupt 接口，直至确认停止或超时。
 * 仅在首次中断请求成功且提供了 promptId 时才进行轮询。
 * @param baseUrl 执行端基础 URL
 * @param promptId 目标 prompt_id；为空时只发送一次中断请求、不轮询
 * @param options 可选配置（供测试缩短轮询间隔/次数）
 * @returns 是否已确认目标 prompt 停止执行；未提供 promptId 时等价于中断请求是否成功
 */
export async function interruptRequest(
  baseUrl: string,
  promptId?: string,
  options?: { pollIntervalMs?: number; maxAttempts?: number },
): Promise<boolean> {
  const pollIntervalMs = options?.pollIntervalMs ?? INTERRUPT_POLL_INTERVAL;
  const maxAttempts = options?.maxAttempts ?? INTERRUPT_MAX_ATTEMPTS;
  try {
    // 1) 首次发送中断请求；失败则直接返回（无法连上执行端时无需轮询）
    const first = await fetch(`${baseUrl}/interrupt`, { method: 'POST' });
    if (!first.ok) return false;
    // 无 promptId 时无法定向确认是否已停止，仅中断一次
    if (!promptId) return true;

    // 2) 轮询确认目标 prompt 已离开执行队列；仍在执行则重新调用中断接口
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const stillRunning = await isPromptRunningRequest(baseUrl, promptId);
      if (!stillRunning) return true; // 已确认停止执行
      // 仍在执行 → 重新发送中断请求（单次失败不中断轮询，下一轮会再次重试）
      try {
        await fetch(`${baseUrl}/interrupt`, { method: 'POST' });
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
 * 拉取指定 prompt 的 history。
 * @param baseUrl 执行端基础 URL
 * @param promptId prompt_id
 * @returns history 响应体；HTTP 非 2xx 时抛出异常
 */
export async function fetchHistoryRequest(baseUrl: string, promptId: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/history/${promptId}`);
  if (!res.ok) {
    throw new Error(`history returned status ${res.status}`);
  }
  return res.json() as Promise<unknown>;
}

/**
 * 构造输出文件下载地址。
 * @param baseUrl 执行端基础 URL
 * @param file 输出文件引用
 * @returns 可访问的 /view 下载地址
 */
export function buildViewUrl(baseUrl: string, file: OutputFileRef): string {
  const q = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type,
  });
  return `${baseUrl}/view?${q.toString()}`;
}
