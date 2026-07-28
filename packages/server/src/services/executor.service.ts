import { uploadFileToComfyUI } from './upload.service';

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
  /** 参数类型 text/image/video/audio */
  paramType: string;
  /** 默认值覆盖；null 表示使用 rawJson 原值 */
  defaultValue: string | null;
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
 * 将别名请求值与默认值覆盖注入工作流 JSON。
 * 优先级：请求别名值 > defaultValue > rawJson 原值。
 * 不修改入参 rawJson 字符串本身以外的持久化数据；返回新的 JSON 字符串。
 * @param rawJson 原始工作流 API JSON 字符串
 * @param params 参数配置列表
 * @param aliasValues 请求传入的别名值
 * @returns 注入后的工作流 JSON 字符串
 */
export function applyAliases(
  rawJson: string,
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
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
      node.inputs[param.fieldName] = aliasValues[param.alias];
      continue;
    }

    // 2) 默认值覆盖
    if (param.defaultValue != null) {
      node.inputs[param.fieldName] = param.defaultValue;
      continue;
    }

    // 3) 保留 rawJson 原值
  }

  return JSON.stringify(workflow);
}

/** 提交 prompt JSON 到 ComfyUI 并返回结果 */
export async function submitPrompt(
  body: string,
  comfyuiBaseUrl: string,
): Promise<ExecutionResult> {
  try {
    const response = await fetch(`${comfyuiBaseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
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
 * @param params 参数配置列表
 * @param aliasValues 请求传入的别名值
 * @param files 按别名分组的上传文件
 * @param comfyuiBaseUrl ComfyUI 服务地址
 * @returns 合并上传结果后的别名值
 */
export async function processMediaParams(
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
  files: Record<string, { buffer: Buffer; originalname: string; mimetype: string }[]>,
  comfyuiBaseUrl: string,
): Promise<Record<string, string>> {
  const result = { ...aliasValues };
  for (const param of params) {
    if (param.paramType === 'text') continue;
    // 无别名的参数不参与对外媒体上传
    if (param.alias == null || param.alias === '') continue;
    const fileList = files[param.alias];
    const file = fileList?.[0];
    if (file) {
      const filename = await uploadFileToComfyUI(
        file,
        param.paramType as 'image' | 'video' | 'audio',
        comfyuiBaseUrl,
      );
      result[param.alias] = filename;
    }
  }
  return result;
}

/** 中断 ComfyUI 当前正在执行的 prompt */
export async function interruptPrompt(comfyuiBaseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${comfyuiBaseUrl}/interrupt`, { method: 'POST' });
    return response.ok;
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
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
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
