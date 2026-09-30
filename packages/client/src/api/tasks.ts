import client from './client';
import { triggerDownload, isAbsoluteHttpUrl } from '@/utils/download';

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

/**
 * 构造输出文件的后端代理请求路径（与后端 `proxy` 模式返回的 `url` 同构）。
 * 不论 `output_download_mode` 为何值，该路径都能取到文件：后端会自行解析回源地址
 * （平台绝对地址优先，其次执行端 `/view`）。
 * @param taskId 任务 ID
 * @param file 输出文件（使用其 filename / subfolder / type 定位）
 * @returns 相对 `/api` 的请求路径（含查询参数）
 */
export function buildOutputFileRequestPath(taskId: string, file: OutputFile): string {
  const subfolder = encodeURIComponent(file.subfolder ?? '');
  const type = encodeURIComponent(file.type || 'output');
  return `/tasks/${taskId}/output-files/${encodeURIComponent(file.filename)}?subfolder=${subfolder}&type=${type}`;
}

/**
 * 以带鉴权的方式取回输出文件内容。
 *
 * 输出文件接口受鉴权保护（`auth_enabled=1` 时要求 `Authorization: Bearer`），
 * 而 `<img>` / `<video>` / `<a href>` 等浏览器原生请求不会携带该头（会得到 401），
 * 因此统一改为经 axios 请求（拦截器自动附加 token）取回 Blob。
 * @param taskId 任务 ID
 * @param file 输出文件
 * @returns 文件内容 Blob
 */
export async function fetchOutputFileBlob(taskId: string, file: OutputFile): Promise<Blob> {
  const res = await client.get<Blob>(buildOutputFileRequestPath(taskId, file), { responseType: 'blob' });
  return res.data;
}

/**
 * 下载输出文件（触发浏览器保存）。
 *
 * - `direct` 模式：`url` 为执行端/平台绝对地址，直接交给浏览器打开（无需本站鉴权头，也不占用本站带宽）；
 * - `proxy` 模式：`url` 为本站代理路径，用 `<a href>` 打开时不会带鉴权头（401），
 *   因此先带鉴权取回 Blob 再本地保存。
 * @param taskId 任务 ID
 * @param file 输出文件
 */
export async function downloadOutputFile(taskId: string, file: OutputFile): Promise<void> {
  // 绝对地址：同步发起导航，保留用户手势上下文（避免被浏览器拦截新窗口）
  if (isAbsoluteHttpUrl(file.url)) {
    window.open(file.url, '_blank', 'noopener');
    return;
  }
  const blob = await fetchOutputFileBlob(taskId, file);
  triggerDownload(blob, file.filename);
}
