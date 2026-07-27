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
  outputFiles: string | null;
  status: 'queued' | 'pending' | 'completed' | 'failed';
  errorMessage: string | null;
  progress: number | null;
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

/** 立即提交 queued 任务 */
export async function submitTask(taskId: string): Promise<{ task_id: string; status: string }> {
  const res = await client.post<{ task_id: string; status: string }>(`/tasks/${taskId}/submit`);
  return res.data;
}

/** 输出文件信息 */
export interface OutputFile {
  filename: string;
  subfolder: string;
  type: string;
  nodeId: string;
  fileType: 'image' | 'video' | 'audio';
  url: string;
}

/** 获取任务输出文件列表 */
export async function fetchTaskOutputFiles(taskId: string): Promise<{ files: OutputFile[] }> {
  const res = await client.get<{ files: OutputFile[] }>(`/tasks/${taskId}/output-files`);
  return res.data;
}
