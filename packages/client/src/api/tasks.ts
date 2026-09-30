import client from './client';

/** 任务日志 */
export interface TaskLog {
  id: string;
  workflowId: string;
  workflowName: string;
  /** 用户选择的提供商实例 ID（分组任务即为分组本身）；历史任务可能为 null */
  providerId: string | null;
  /** 用户选择的提供商实例名称；历史任务可能为 null */
  providerName: string | null;
  /** 实际执行任务的成员实例 ID（仅分组任务调度成功后写入）；普通任务与排队中为 null */
  actualProviderId: string | null;
  /** 实际执行任务的成员实例名称（冗余存储） */
  actualProviderName: string | null;
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

/** 修改执行目标的返回结果 */
export interface UpdateTaskProviderResult {
  task_id: string;
  /** 改派并调度后的任务状态 */
  status: string;
  /** 生效的目标实例 ID */
  provider_id: string;
  /** 生效的目标实例名称 */
  provider_name: string;
  /** 滞留风险提示（如目标分组没有可用成员）；无风险时为 undefined */
  warning?: string;
}

/**
 * 修改待调度任务的执行目标（人工干预自动调度，仅影响后续调度，不会立即提交）。
 * @param taskId 任务 ID（须处于待调度 queued 状态）
 * @param providerId 目标执行提供商实例 ID（可为分组或具体实例）
 * @returns 改派结果（含可选滞留警告）
 */
export async function updateTaskProvider(
  taskId: string,
  providerId: string,
): Promise<UpdateTaskProviderResult> {
  const res = await client.patch<UpdateTaskProviderResult>(`/tasks/${taskId}/provider`, { providerId });
  return res.data;
}

/** 立即提交（插队）的返回结果 */
export interface SubmitTaskResult {
  task_id: string;
  status: string;
  error_message?: string;
}

/**
 * 立即提交待调度任务（插队）：无视目标实例并发上限直接提交工作流，
 * 并把任务归属一并改为该实例（插队即改道）。
 * @param taskId 任务 ID（须处于待调度 queued 状态）
 * @param providerId 目标具体实例 ID（分组无自有提交端点，后端会拒绝）
 * @returns 提交结果
 */
export async function submitTask(taskId: string, providerId: string): Promise<SubmitTaskResult> {
  const res = await client.post<SubmitTaskResult>(`/tasks/${taskId}/submit`, { providerId });
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
