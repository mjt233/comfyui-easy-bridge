export interface WorkflowParam {
  id: number;
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label: string | null;
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

export async function executeWorkflow(
  rawJson: string,
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
  comfyuiBaseUrl: string,
): Promise<unknown> {
  const modifiedJson = applyAliases(rawJson, params, aliasValues);
  const response = await fetch(`${comfyuiBaseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: modifiedJson,
  });
  if (!response.ok) {
    throw new Error(`ComfyUI returned status ${response.status}`);
  }
  return response.json();
}
