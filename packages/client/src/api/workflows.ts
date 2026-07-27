import client from './client';
import type { Workflow, WorkflowDetail } from '@/types';

export async function listWorkflows(): Promise<Workflow[]> {
  const res = await client.get<Workflow[]>('/workflows');
  return res.data;
}

export async function getWorkflow(id: string): Promise<WorkflowDetail> {
  const res = await client.get<WorkflowDetail>(`/workflows/${id}`);
  return res.data;
}

export async function createWorkflow(data: { id: string; name: string; rawJson: string }): Promise<Workflow> {
  const res = await client.post<Workflow>('/workflows', data);
  return res.data;
}

export async function updateWorkflow(id: string, data: Partial<{ id: string; name: string; rawJson: string }>): Promise<Workflow> {
  const res = await client.put<Workflow>(`/workflows/${id}`, data);
  return res.data;
}

export async function deleteWorkflow(id: string): Promise<void> {
  await client.delete(`/workflows/${id}`);
}

export async function addParam(workflowId: string, data: { nodeId: string; fieldName: string; alias: string; label?: string; paramType?: string }) {
  const res = await client.post(`/workflows/${workflowId}/params`, data);
  return res.data;
}

export async function updateParam(workflowId: string, paramId: number, data: Partial<{ alias: string; label: string; paramType: string }>) {
  const res = await client.put(`/workflows/${workflowId}/params/${paramId}`, data);
  return res.data;
}

export async function deleteParam(workflowId: string, paramId: number): Promise<void> {
  await client.delete(`/workflows/${workflowId}/params/${paramId}`);
}

export interface ExecuteResult {
  task_id: string;
  status: string;
  comfyui_response: unknown;
}

export async function executeWorkflow(
  workflowId: string,
  aliasValues: Record<string, string>,
  files?: Record<string, File>,
): Promise<ExecuteResult> {
  if (!files || Object.keys(files).length === 0) {
    const res = await client.post<ExecuteResult>(`/workflows/${workflowId}/execute`, aliasValues);
    return res.data;
  }
  const formData = new FormData();
  formData.append('params', JSON.stringify(aliasValues));
  for (const [alias, file] of Object.entries(files)) {
    formData.append(alias, file);
  }
  const res = await client.post<ExecuteResult>(`/workflows/${workflowId}/execute`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}
