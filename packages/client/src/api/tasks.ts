import client from './client';

/** 任务日志 */
export interface TaskLog {
  id: string;
  workflowId: string;
  workflowName: string;
  promptId: string | null;
  aliasValues: string;
  comfyuiUrl: string;
  comfyuiRequestBody: string | null;
  comfyuiResponse: string | null;
  status: 'pending' | 'completed' | 'failed';
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** 获取所有任务日志 */
export async function listTasks(): Promise<TaskLog[]> {
  const res = await client.get<TaskLog[]>('/tasks');
  return res.data;
}

/** 清理所有已完成和失败的任务日志 */
export async function clearCompletedTasks(): Promise<{ deleted: number }> {
  const res = await client.delete<{ deleted: number }>('/tasks/completed');
  return res.data;
}
