import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
// Initialize database (creates tables on first run)
import './models/db';

const app = express();
const PORT = process.env.PORT ?? 10721;

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

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
