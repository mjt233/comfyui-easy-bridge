import client from './client';
import type { Settings } from '@/types';

export async function getSettings(): Promise<Settings> {
  const res = await client.get<Settings>('/settings');
  return res.data;
}

export async function updateSetting(key: string, value: string): Promise<{ key: string; value: string }> {
  const res = await client.put<{ key: string; value: string }>('/settings', { key, value });
  return res.data;
}
