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
