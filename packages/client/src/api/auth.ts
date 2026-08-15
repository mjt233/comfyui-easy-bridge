import client from './client';

export interface LoginResponse {
  token: string;
}

export async function login(password: string): Promise<LoginResponse> {
  const res = await client.post<LoginResponse>('/auth/login', { password });
  return res.data;
}

export interface AuthStatusResponse {
  authEnabled: boolean;
}

export async function getAuthStatus(): Promise<AuthStatusResponse> {
  const res = await client.get<AuthStatusResponse>('/auth/status');
  return res.data;
}

/**
 * 修改管理员密码（需已登录）。
 * 成功后所有旧 token 立即失效，需要重新登录。
 * @param oldPassword 当前密码
 * @param newPassword 新密码（至少 6 位）
 */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await client.post('/auth/change-password', { oldPassword, newPassword });
}
