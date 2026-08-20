import client from './client';

/** 任务日志 */
export interface TaskLog {
  id: string;
  workflowId: string;
  workflowName: string;
  /** 实际执行的提供商实例 ID；历史任务可能为 null */
  providerId: string | null;
  /** 实际执行的提供商实例名称；历史任务可能为 null */
  providerName: string | null;
  promptId: string | null;
  aliasValues: string;
  /** 用户原始请求表单 JSON（含参数与上传文件元数据）；旧任务可能为 null */
  originalForm: string | null;
  comfyuiUrl: string;
  comfyuiRequestBody: string | null;
  comfyuiResponse: string | null;
  outputFiles: string | null;
  status: 'queued' | 'pending' | 'completed' | 'failed';
  errorMessage: string | null;
  progress: number | null;
  createdAt: string;
  /** 实际开始执行时间（进入 pending 时）；排队中或历史任务可能为 null */
  startedAt: string | null;
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

/** 中断任务执行（支持 queued 和 pending 状态） */
export async function cancelTask(taskId: string): Promise<{ task_id: string; status: string }> {
  const res = await client.post<{ task_id: string; status: string }>(`/tasks/${taskId}/cancel`);
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
