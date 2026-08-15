import axios from 'axios';
import { authEnabled } from './auth-status';

const client = axios.create({
  baseURL: '/api',
});

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (res) => res,
  (error) => {
    if (
      error.response?.status === 401
      && !error.config?.url?.includes('/auth/login')
      // 修改密码接口的 401 表示旧密码错误，由表单就地提示，不触发登出跳转
      && !error.config?.url?.includes('/auth/change-password')
      && authEnabled.value !== false
    ) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

export default client;
