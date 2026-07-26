import client from './client';

export interface LoginResponse {
  token: string;
}

export async function login(password: string): Promise<LoginResponse> {
  const res = await client.post<LoginResponse>('/auth/login', { password });
  return res.data;
}
