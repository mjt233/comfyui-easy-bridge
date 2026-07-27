import { uploadFileToComfyUI } from './upload.service';

export interface WorkflowParam {
  id: number;
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label: string | null;
  paramType: string;
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

export function applyAliases(
  rawJson: string,
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
): string {
  const workflow = JSON.parse(rawJson);

  for (const param of params) {
    const node = workflow[param.nodeId];
    if (!node) continue;

    const currentValue = node.inputs?.[param.fieldName];
    if (Array.isArray(currentValue)) continue;

    if (!(param.alias in aliasValues)) {
      throw new Error(`Missing required parameter: ${param.alias}`);
    }

    node.inputs[param.fieldName] = aliasValues[param.alias];
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

/** 处理媒体参数：将上传的文件发送到 ComfyUI，返回最终 aliasValues */
export async function processMediaParams(
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
  files: Record<string, { buffer: Buffer; originalname: string; mimetype: string }[]>,
  comfyuiBaseUrl: string,
): Promise<Record<string, string>> {
  const result = { ...aliasValues };
  for (const param of params) {
    if (param.paramType === 'text') continue;
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
