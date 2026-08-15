import path from 'node:path';
import fs from 'node:fs';
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
const PORT = process.env.PORT ?? 10721;

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

function startServer() {
  // 启动时检查管理员密码：未设置过则写入默认密码 0d000721 的 bcrypt 哈希
  ensureDefaultPassword(db);
  startExecutionService(db);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

if (process.env.VITEST !== 'true') {
  startServer();
}

export { app, startServer };
export default app;
