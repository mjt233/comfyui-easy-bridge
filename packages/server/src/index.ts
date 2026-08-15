import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { db } from './models/db';
import { createAuthRoutes } from './routes/auth.routes';
import { createWorkflowRoutes } from './routes/workflow.routes';
import { createSettingsRoutes } from './routes/settings.routes';
import { createProvidersRoutes } from './routes/providers.routes';
import { createTaskRoutes } from './routes/task.routes';
import { createTagsRoutes } from './routes/tags.routes';
import { errorHandler } from './middleware/errorHandler';
import { ensureDefaultPassword } from './services/auth.service';
import { startExecutionService } from './services/execution.service';

const app: Express = express();
// 端口号支持通过环境变量覆盖，统一转为数字（非法值退化为 NaN 时由 listen 报错）
const PORT = Number(process.env.PORT ?? 10721);

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', createAuthRoutes(db));
app.use('/api/workflows', createWorkflowRoutes(db));
app.use('/api/settings', createSettingsRoutes(db));
app.use('/api/providers', createProvidersRoutes(db));
app.use('/api/tasks', createTaskRoutes(db));
app.use('/api/tags', createTagsRoutes(db));

/**
 * 解析前端构建产物目录（单容器部署时托管 SPA）。
 * 依序尝试：CLIENT_DIST 环境变量 → monorepo 内 packages/client/dist → 工作目录下 client/dist。
 * 仅当目录中存在 index.html 时返回，否则返回 null（纯 API 模式，跳过静态托管）。
 */
function resolveClientDist(): string | null {
  const candidates: string[] = [
    process.env.CLIENT_DIST ?? '',
    path.resolve(__dirname, '../../client/dist'),
    path.resolve(process.cwd(), 'client/dist'),
  ];
  for (const dir of candidates) {
    // 跳过空字符串候选，并校验构建产物确实存在
    if (dir && fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return null;
}

const clientDist = resolveClientDist();
if (clientDist) {
  // 静态托管前端构建产物（需在 API 路由之后注册，避免遮蔽 /api 前缀）
  app.use(express.static(clientDist));
  // SPA history 路由回退：非 /api 前缀的 GET 请求一律返回 index.html
  app.get(/^\/(?!api(?:$|\/)).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use(errorHandler);

/**
 * 获取本机所有可对外访问的 IPv4 地址（排除回环地址与内部虚拟网卡），
 * 用于启动后在控制台打印局域网访问 URL。
 * @returns 局域网 IPv4 地址列表
 */
function getLanIPv4Addresses(): string[] {
  const addresses: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    // 逐网卡遍历其地址条目，仅收集非内部（非回环）IPv4 地址
    const entries = interfaces[name] ?? [];
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

/**
 * 在控制台打印服务启动后的访问 URL（本机回环 + 所有局域网网卡地址）。
 * @param port 服务实际监听的端口号
 */
function printAccessUrls(port: number): void {
  console.log(`Server running on port ${port}`);
  console.log(`Local:   http://localhost:${port}`);
  const lanIPs = getLanIPv4Addresses();
  for (const ip of lanIPs) {
    // 局域网内的其他设备可通过该地址访问本服务
    console.log(`Network: http://${ip}:${port}`);
  }
}

function startServer() {
  // 启动时检查管理员密码：未设置过则写入默认密码 0d000721 的 bcrypt 哈希
  ensureDefaultPassword(db);
  startExecutionService(db);
  // 绑定 0.0.0.0：监听所有网络接口，允许局域网设备访问
  const server = app.listen(PORT, '0.0.0.0', () => {
    // 端口可能被指定为 0（随机分配），以实际监听地址为准打印
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : PORT;
    printAccessUrls(actualPort);
  });
}

if (process.env.VITEST !== 'true') {
  startServer();
}

export { app, startServer };
export default app;
