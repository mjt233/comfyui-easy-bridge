import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { db } from './models/db';
import { createAuthRoutes } from './routes/auth.routes';
import { createWorkflowRoutes } from './routes/workflow.routes';
import { createSettingsRoutes } from './routes/settings.routes';
import { errorHandler } from './middleware/errorHandler';

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

app.use(errorHandler);

function startServer() {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

if (process.env.VITEST !== 'true') {
  startServer();
}

export { app, startServer };
export default app;
