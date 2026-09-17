import { Request, Response, NextFunction } from 'express';

/**
 * 从任意抛出的值中提取错误信息文本。
 * 非 Error 值（字符串、对象等）统一转为字符串，保证日志与策略判断都不中断。
 * @param err 被抛出的值
 * @returns 错误信息文本
 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err == null) return '';
  // 非 Error 对象：优先取 message 字段，否则字符串化
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  return String(err);
}

/**
 * 读取错误堆栈（仅 Error 实例有堆栈；其余返回空字符串）。
 * @param err 被抛出的值
 * @returns 堆栈文本
 */
function extractStack(err: unknown): string {
  return err instanceof Error && typeof err.stack === 'string' ? err.stack : '';
}

/**
 * 全局 Express 错误处理中间件。
 * 所有未被路由处理的异常都会到达此处：输出带请求上下文的错误日志，并映射为统一的错误码响应。
 * 注意 Express 4 不会自动捕获 async 路由抛出的异常，那类异常由 index.ts 的进程级兜底输出。
 * @param err 被抛出的错误（可能是任意值，非 Error 时按字符串处理）
 * @param req 当前请求（用于日志上下文）
 * @param res 响应对象
 * @param _next 下一个中间件（错误处理必须声明 4 个参数才会被 Express 识别）
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const message = extractMessage(err);

  /** 按错误类型映射的响应（状态码 + 错误码 + 对外文案） */
  let status = 500;
  let code = 'internal_error';
  let clientMessage = 'Internal server error';

  if (message.startsWith('Missing required parameter:')) {
    status = 400;
    code = 'missing_parameter';
    clientMessage = message;
  } else if (message === 'Invalid password') {
    status = 401;
    code = 'unauthorized';
    clientMessage = message;
  } else if (message === 'New password too short') {
    status = 400;
    code = 'invalid_parameter';
    clientMessage = message;
  } else if (message.includes('UNIQUE constraint failed')) {
    status = 409;
    code = 'alias_conflict';
    clientMessage = 'Alias already exists';
  } else if (message.startsWith('ComfyUI returned status')) {
    status = 502;
    code = 'comfyui_unreachable';
    clientMessage = 'ComfyUI service error';
  }

  // 统一输出带方法/路径/状态码的日志，便于从控制台定位出错接口
  console.error(
    `[ErrorHandler] ${req.method} ${req.originalUrl} → ${status} (${code}): ${message || '<no message>'}`,
  );
  // 非预期错误（500）额外打印原始错误与堆栈，便于排查根因
  if (status === 500) {
    console.error('[ErrorHandler] unexpected error:', err);
    const stack = extractStack(err);
    if (stack) console.error(stack);
  }

  res.status(status).json({ error: clientMessage, code });
}
