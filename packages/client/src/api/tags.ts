import client from './client';
import type { TagMetadataFieldDef, TagTreeNode, WorkflowTagGroup, WorkflowTagInput } from '@/types';

/**
 * 标签数据库行（create/update 接口返回；metadataDef 为 JSON 字符串，需 JSON.parse 解析）
 */
export interface TagRecord {
  /** 标签 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** 父标签 ID；null=顶层 */
  parentId: string | null;
  /** 是否预设只读（1=预设，0=自定义） */
  isPreset: number;
  /** 元数据字段定义 JSON 字符串 */
  metadataDef: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/**
 * 列出全部标签树
 * @returns 标签树（顶层节点含 children）
 */
export async function listTags(): Promise<TagTreeNode[]> {
  const res = await client.get<TagTreeNode[]>('/tags');
  return res.data;
}

/**
 * 新建自定义标签的入参
 */
export interface TagCreateInput {
  /** 显示名 */
  name: string;
  /** 父标签 ID（可选，null=顶层） */
  parentId?: string | null;
  /** 元数据字段定义（可选） */
  metadataDef?: TagMetadataFieldDef[];
}

/**
 * 新建自定义标签
 * @param data 新建入参
 * @returns 新标签（DB 行结构）
 */
export async function createTag(data: TagCreateInput): Promise<TagRecord> {
  const res = await client.post<TagRecord>('/tags', data);
  return res.data;
}

/**
 * 更新自定义标签（预设标签会被后端拒绝）
 * @param id 标签 ID
 * @param data 可更新字段
 */
export async function updateTag(id: string, data: Partial<TagCreateInput>): Promise<TagRecord> {
  const res = await client.put<TagRecord>(`/tags/${id}`, data);
  return res.data;
}

/**
 * 删除自定义标签（预设/有子/被引用会被后端拒绝）
 * @param id 标签 ID
 */
export async function deleteTag(id: string): Promise<void> {
  await client.delete(`/tags/${id}`);
}

/**
 * 设置工作流标签（整组替换）
 * @param workflowId 工作流 ID
 * @param tags 标签数组（tagId + 可选 metadataValues）
 * @returns 替换后的标签分组
 */
export async function setWorkflowTags(
  workflowId: string,
  tags: WorkflowTagInput[],
): Promise<WorkflowTagGroup[]> {
  const res = await client.put<WorkflowTagGroup[]>(`/workflows/${workflowId}/tags`, { tags });
  return res.data;
}
