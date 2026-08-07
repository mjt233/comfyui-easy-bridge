import client from './client';
import type { ProviderConfigInput, ProviderSummary, ProviderType } from '@/types';

/**
 * 列出全部执行提供商实例（config 中 runninghub 的 apiKey 已打码）
 * @returns 提供商实例摘要列表
 */
export async function listProviders(): Promise<ProviderSummary[]> {
  const res = await client.get<ProviderSummary[]>('/providers');
  return res.data;
}

/**
 * 新建执行提供商实例的入参
 */
export interface ProviderCreateInput {
  /** 展示名 */
  name: string;
  /** 提供商类型 */
  type: ProviderType;
  /** 按类型区分的配置 */
  config: ProviderConfigInput;
  /** 并发上限（可选，后端默认 1） */
  concurrency?: number;
  /** 是否启用（可选，后端默认启用） */
  enabled?: boolean;
}

/**
 * 新建执行提供商实例
 * @param data 新建入参
 * @returns 新建的实例摘要
 */
export async function createProvider(data: ProviderCreateInput): Promise<ProviderSummary> {
  const res = await client.post<ProviderSummary>('/providers', data);
  return res.data;
}

/**
 * 更新执行提供商实例（运行中变更会触发后端跟踪器重建）
 * @param id 实例 ID
 * @param data 可更新字段（部分更新）
 * @returns 更新后的实例摘要
 */
export async function updateProvider(id: string, data: Partial<ProviderCreateInput>): Promise<ProviderSummary> {
  const res = await client.put<ProviderSummary>(`/providers/${id}`, data);
  return res.data;
}

/**
 * 删除执行提供商实例（全局默认实例会被后端拒绝删除）
 * @param id 实例 ID
 */
export async function deleteProvider(id: string): Promise<void> {
  await client.delete(`/providers/${id}`);
}

/**
 * 测试连接结果
 */
export interface TestConnectionResult {
  /** 是否连通 */
  ok: boolean;
  /** 提示信息（失败原因等） */
  message: string;
}

/**
 * 用未保存的配置测试连通性（测试失败不阻止保存）
 * @param type 提供商类型
 * @param config 待测试配置
 * @returns 连通性结果
 */
export async function testProviderConfig(type: ProviderType, config: ProviderConfigInput): Promise<TestConnectionResult> {
  const res = await client.post<TestConnectionResult>('/providers/test', { type, config });
  return res.data;
}

/**
 * 测试已保存实例的连通性
 * @param id 实例 ID
 * @returns 连通性结果
 */
export async function testProviderById(id: string): Promise<TestConnectionResult> {
  const res = await client.post<TestConnectionResult>(`/providers/${id}/test`);
  return res.data;
}
