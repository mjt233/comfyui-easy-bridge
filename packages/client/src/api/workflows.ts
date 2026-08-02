import client from './client';
import type { Workflow, WorkflowDetail, WorkflowAttachment, ImportResult, SimulateResult, ComfyNodeReference } from '@/types';

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

/**
 * 复制工作流：后端克隆本体、参数、动态构建脚本与附件，名称追加 " (copy)"
 * @param id 源工作流 ID
 * @returns 复制后的新工作流
 */
export async function duplicateWorkflow(id: string): Promise<Workflow> {
  const res = await client.post<Workflow>(`/workflows/${id}/duplicate`);
  return res.data;
}

/**
 * 新增工作流参数
 * @param workflowId 工作流 ID
 * @param data 参数数据（alias 可选）
 */
export async function addParam(
  workflowId: string,
  data: {
    nodeId: string;
    fieldName: string;
    alias?: string | null;
    label?: string;
    paramType?: string;
    defaultValue?: string | null;
  },
) {
  const res = await client.post(`/workflows/${workflowId}/params`, data);
  return res.data;
}

/**
 * 更新工作流参数
 * @param workflowId 工作流 ID
 * @param paramId 参数 ID
 * @param data 可更新字段
 */
export async function updateParam(
  workflowId: string,
  paramId: number,
  data: Partial<{
    alias: string | null;
    label: string;
    paramType: string;
    defaultValue: string | null;
  }>,
) {
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
  /** 别名参数值；boolean 可传真正布尔，后端会按类型转换 */
  aliasValues: Record<string, string | number | boolean>,
  /** 媒体文件：按别名分组，每个别名可多文件（后端 multer 按重复 fieldname 收集为数组） */
  files?: Record<string, File[]>,
): Promise<ExecuteResult> {
  // 无媒体文件时走普通 JSON 请求
  if (!files || Object.keys(files).length === 0) {
    const res = await client.post<ExecuteResult>(`/workflows/${workflowId}/execute`, aliasValues);
    return res.data;
  }
  // 有媒体文件时走 multipart：params 为 JSON 文本字段，文件以别名为字段名（同一别名多文件重复追加）
  const formData = new FormData();
  formData.append('params', JSON.stringify(aliasValues));
  for (const [alias, fileList] of Object.entries(files)) {
    for (const file of fileList) {
      formData.append(alias, file);
    }
  }
  const res = await client.post<ExecuteResult>(`/workflows/${workflowId}/execute`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

/** 拉取动态构建脚本 API 类型声明（d.ts 文本） */
export async function getBuildApiTypes(): Promise<string> {
  const res = await client.get<string>('/workflows/build-api.d.ts');
  return res.data;
}

/**
 * 拉取 ComfyUI 节点速查表（按类名字母序排序）
 * ComfyUI 未配置/不可达时后端返回 503，由调用方展示错误
 * @returns 节点速查条目数组
 */
export async function getNodeInfo(): Promise<ComfyNodeReference[]> {
  const res = await client.get<{ nodes: ComfyNodeReference[] }>('/workflows/node-info');
  return res.data.nodes;
}

/**
 * 保存动态构建脚本与启用状态
 * @param workflowId 工作流 ID
 * @param data 脚本与启用状态
 * @returns 更新后的工作流详情
 */
export async function saveBuildScript(
  workflowId: string,
  data: { script: string; enabled: boolean },
): Promise<WorkflowDetail> {
  const res = await client.put<WorkflowDetail>(`/workflows/${workflowId}/build-script`, data);
  return res.data;
}

/**
 * 模拟构建：脚本 + 参数 + 可选媒体文件 → 构建后的最终 JSON 与参数配置
 * @param workflowId 工作流 ID
 * @param data 脚本源码与参数
 * @param files 按别名分组的媒体文件数组（可选，脚本按 files[alias] 读取数量）
 * @returns 模拟结果
 */
export async function simulateBuild(
  workflowId: string,
  data: { script: string; params: Record<string, unknown> },
  files?: Record<string, File[]>,
): Promise<SimulateResult> {
  // 无媒体文件时走普通 JSON 请求
  if (!files || Object.keys(files).length === 0) {
    const res = await client.post<SimulateResult>(`/workflows/${workflowId}/build/simulate`, data);
    return res.data;
  }
  // 有媒体文件时走 multipart：script/params 为文本字段，文件以别名为字段名（同一别名多文件重复追加）
  const formData = new FormData();
  formData.append('script', data.script);
  formData.append('params', JSON.stringify(data.params));
  for (const [alias, fileList] of Object.entries(files)) {
    for (const file of fileList) {
      formData.append(alias, file);
    }
  }
  const res = await client.post<SimulateResult>(`/workflows/${workflowId}/build/simulate`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

/**
 * 触发浏览器下载 Blob
 * @param blob 文件内容
 * @param filename 下载文件名
 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * 列出工作流附件
 * @param workflowId 工作流 ID
 * @returns 附件记录列表
 */
export async function listAttachments(workflowId: string): Promise<WorkflowAttachment[]> {
  const res = await client.get<WorkflowAttachment[]>(`/workflows/${workflowId}/attachments`);
  return res.data;
}

/**
 * 上传工作流附件
 * @param workflowId 工作流 ID
 * @param file 待上传文件
 * @returns 新建的附件记录
 */
export async function uploadAttachment(workflowId: string, file: File): Promise<WorkflowAttachment> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await client.post<WorkflowAttachment>(
    `/workflows/${workflowId}/attachments`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  );
  return res.data;
}

/**
 * 下载工作流附件（触发浏览器保存）
 * @param workflowId 工作流 ID
 * @param attachment 附件记录
 */
export async function downloadAttachment(workflowId: string, attachment: WorkflowAttachment): Promise<void> {
  const res = await client.get<Blob>(
    `/workflows/${workflowId}/attachments/${attachment.id}/download`,
    { responseType: 'blob' },
  );
  triggerDownload(res.data, attachment.filename);
}

/**
 * 删除工作流附件
 * @param workflowId 工作流 ID
 * @param attachmentId 附件行 ID
 */
export async function deleteAttachment(workflowId: string, attachmentId: number): Promise<void> {
  await client.delete(`/workflows/${workflowId}/attachments/${attachmentId}`);
}

/**
 * 多选导出工作流为 ZIP（含参数与附件），触发浏览器下载
 * @param ids 选中的工作流 ID 列表
 */
export async function exportWorkflows(ids: string[]): Promise<void> {
  const res = await client.post<Blob>(
    '/workflows/export',
    { ids },
    { responseType: 'blob' },
  );
  triggerDownload(res.data, `workflows-export-${Date.now()}.zip`);
}

/**
 * 批量导入工作流 ZIP
 * @param file 导出的 ZIP 文件
 * @returns 导入结果摘要
 */
export async function importWorkflows(file: File): Promise<ImportResult> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await client.post<ImportResult>('/workflows/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}
