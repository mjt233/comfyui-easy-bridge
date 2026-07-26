# ComfyUI Easy Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) for syntax tracking.

**Goal:** Build a simplified API layer that wraps ComfyUI workflow JSONs, allows marking node inputs as aliases, and exposes a clean HTTP API for workflow execution.

**Architecture:** Classic layered Express backend (routes → controllers → services → Drizzle ORM) with a Vue 3 + Vuetify admin SPA. Monorepo managed by pnpm workspace.

**Tech Stack:** Node.js + TypeScript + Express + Drizzle ORM + SQLite (better-sqlite3), Vue 3 + Vuetify + Vite, JWT + bcryptjs

---

### Task 1: Monorepo + Server Scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/vitest.config.ts`
- Create: `packages/server/src/index.ts`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "comfyui-easy-bridge",
  "private": true,
  "scripts": {
    "dev:server": "pnpm --filter server dev",
    "dev:client": "pnpm --filter client dev",
    "build:server": "pnpm --filter server build",
    "build:client": "pnpm --filter client build",
    "test": "pnpm --filter server test"
  }
}
```

- [ ] **Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

- [ ] **Step 4: Create packages/server/package.json**

```json
{
  "name": "server",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "express": "^4.21.0",
    "cors": "^2.8.5",
    "helmet": "^8.0.0",
    "drizzle-orm": "^0.36.0",
    "better-sqlite3": "^11.0.0",
    "jsonwebtoken": "^9.0.2",
    "bcryptjs": "^2.4.3"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "supertest": "^7.0.0",
    "drizzle-kit": "^0.28.0",
    "@types/express": "^5.0.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/bcryptjs": "^2.4.0",
    "@types/cors": "^2.8.0",
    "@types/supertest": "^6.0.0"
  }
}
```

- [ ] **Step 5: Create packages/server/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 6: Create packages/server/vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 7: Create packages/server/src/index.ts (minimal entry)**

```ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

const app = express();
const PORT = process.env.PORT ?? 10721;

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
```

- [ ] **Step 8: Install dependencies and verify server starts**

Run: `pnpm install`
Then: `pnpm --filter server dev`
Expected: Server prints "Server running on port 10721"
Kill the server with Ctrl+C.

- [ ] **Step 9: Create a smoke test for the health endpoint**

Create: `packages/server/src/index.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import app from './index';

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const res = await supertest(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 10: Run tests to verify**

Run: `pnpm --filter server test`
Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json packages/server/
git commit -m "feat: initialize monorepo with server scaffold"
```

### Task 2: Database Schema and Connection

**Files:**
- Create: `packages/server/src/models/db.ts`
- Create: `packages/server/src/models/schema.ts`
- Create: `packages/server/drizzle.config.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Write the test for db and schema**

Create: `packages/server/src/models/schema.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { workflows, workflowParams, settings } from './schema';

describe('schema', () => {
  it('creates tables with correct columns', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    db.run(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE workflow_params (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        alias TEXT NOT NULL UNIQUE,
        label TEXT
      )
    `);
    db.run(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    expect(workflows).toBeDefined();
    expect(workflowParams).toBeDefined();
    expect(settings).toBeDefined();
    sqlite.close();
  });
});
```

- [ ] **Step 2: Create drizzle.config.ts**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/models/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/bridge.db',
  },
});
```

- [ ] **Step 3: Create schema.ts**

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rawJson: text('raw_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workflowParams = sqliteTable('workflow_params', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  fieldName: text('field_name').notNull(),
  alias: text('alias').notNull().unique(),
  label: text('label'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
```

- [ ] **Step 4: Create db.ts**

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(path.join(dataDir, 'bridge.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// Auto-create tables on first run
db.run(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS workflow_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    alias TEXT NOT NULL UNIQUE,
    label TEXT
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);
```

- [ ] **Step 5: Add .gitignore for data/ directory**

Create: `.gitignore`
```
node_modules/
dist/
data/
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter server test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/models/ packages/server/drizzle.config.ts .gitignore
git commit -m "feat: add drizzle schema and database connection"
```

### Task 3: Settings Service

**Files:**
- Create: `packages/server/src/services/settings.service.ts`
- Create: `packages/server/src/services/settings.service.test.ts`

- [ ] **Step 1: Write failing test for settings service**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  let service: SettingsService;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)
    `);
    const db = drizzle(sqlite, { schema });
    service = new SettingsService(db);
  });

  it('returns null for non-existent key', () => {
    expect(service.get('nonexistent')).toBeNull();
  });

  it('sets and gets a value', () => {
    service.set('comfyui_base_url', 'http://localhost:8188');
    expect(service.get('comfyui_base_url')).toBe('http://localhost:8188');
  });

  it('overwrites existing value', () => {
    service.set('key', 'value1');
    service.set('key', 'value2');
    expect(service.get('key')).toBe('value2');
  });

  it('returns all settings', () => {
    service.set('key1', 'val1');
    service.set('key2', 'val2');
    const all = service.getAll();
    expect(all).toEqual({ key1: 'val1', key2: 'val2' });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter server test`
Expected: Fails — SettingsService not defined

- [ ] **Step 3: Implement settings.service.ts**

```ts
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

export class SettingsService {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  get(key: string): string | null {
    const row = this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run();
  }

  getAll(): Record<string, string> {
    const rows = this.db.select().from(schema.settings).all();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }
}
```

- [ ] **Step 4: Run test to verify passes**

Run: `pnpm --filter server test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/
git commit -m "feat: implement settings service"
```

### Task 4: Auth Middleware and Login Endpoint

**Files:**
- Create: `packages/server/src/middleware/auth.ts`
- Create: `packages/server/src/routes/auth.routes.ts`
- Create: `packages/server/src/controllers/auth.controller.ts`
- Create: `packages/server/src/services/auth.service.ts`
- Create: `packages/server/src/middleware/auth.test.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Write tests for auth service and middleware**

Create: `packages/server/src/services/auth.service.test.ts`
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const db = drizzle(sqlite, { schema });
    service = new AuthService(db);
  });

  it('initializes default password on first access', () => {
    expect(service.verifyPassword('0d000721')).toBe(true);
  });

  it('rejects wrong password', () => {
    expect(service.verifyPassword('wrong')).toBe(false);
  });

  it('generates a valid JWT token', () => {
    const token = service.login('0d000721');
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
  });

  it('rejects login with wrong password', () => {
    expect(() => service.login('wrong')).toThrow('Invalid password');
  });

  it('verifies a valid token', () => {
    const token = service.login('0d000721');
    const payload = service.verifyToken(token);
    expect(payload).toHaveProperty('role', 'admin');
  });

  it('rejects an invalid token', () => {
    expect(() => service.verifyToken('bad-token')).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter server test`
Expected: Fails

- [ ] **Step 3: Implement auth.service.ts**

```ts
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from './settings.service';

const JWT_SECRET = process.env.JWT_SECRET ?? 'comfyui-easy-bridge-secret-key-change-in-production';
const DEFAULT_PASSWORD = '0d000721';

export class AuthService {
  private settings: SettingsService;

  constructor(private db: BetterSQLite3Database<typeof schema>) {
    this.settings = new SettingsService(db);
    this.ensureDefaultPassword();
  }

  private ensureDefaultPassword(): void {
    const existing = this.settings.get('admin_password_hash');
    if (!existing) {
      const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
      this.settings.set('admin_password_hash', hash);
    }
  }

  verifyPassword(password: string): boolean {
    const hash = this.settings.get('admin_password_hash');
    if (!hash) return false;
    return bcrypt.compareSync(password, hash);
  }

  login(password: string): string {
    if (!this.verifyPassword(password)) {
      throw new Error('Invalid password');
    }
    return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  }

  verifyToken(token: string): { role: string } {
    return jwt.verify(token, JWT_SECRET) as { role: string };
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter server test`
Expected: Passes

- [ ] **Step 5: Implement auth middleware**

Create: `packages/server/src/middleware/auth.ts`
```ts
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

export function createAuthMiddleware(db: BetterSQLite3Database<typeof schema>) {
  const authService = new AuthService(db);

  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid token', code: 'unauthorized' });
      return;
    }

    const token = authHeader.slice(7);
    try {
      authService.verifyToken(token);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token', code: 'unauthorized' });
    }
  };
}
```

- [ ] **Step 6: Implement auth controller**

Create: `packages/server/src/controllers/auth.controller.ts`
```ts
import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

export function createAuthController(db: BetterSQLite3Database<typeof schema>) {
  const authService = new AuthService(db);

  return {
    login(req: Request, res: Response): void {
      const { password } = req.body;
      if (!password) {
        res.status(400).json({ error: 'Password is required', code: 'missing_parameter' });
        return;
      }
      try {
        const token = authService.login(password);
        res.json({ token });
      } catch {
        res.status(401).json({ error: 'Invalid password', code: 'unauthorized' });
      }
    },
  };
}
```

- [ ] **Step 7: Implement auth routes**

Create: `packages/server/src/routes/auth.routes.ts`
```ts
import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createAuthController } from '../controllers/auth.controller';

export function createAuthRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createAuthController(db);

  router.post('/login', controller.login);

  return router;
}
```

- [ ] **Step 8: Create integration test for auth**

Create: `packages/server/src/routes/auth.routes.test.ts`
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createAuthRoutes } from './auth.routes';

describe('POST /api/auth/login', () => {
  let app: express.Express;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const db = drizzle(sqlite, { schema });

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));
  });

  it('returns token with valid password', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('returns 401 with invalid password', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when password is missing', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 9: Wire auth routes into index.ts**

Modify: `packages/server/src/index.ts`
```ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { db } from './models/db';
import { createAuthRoutes } from './routes/auth.routes';

const app = express();
const PORT = process.env.PORT ?? 10721;

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', createAuthRoutes(db));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
```

- [ ] **Step 10: Run all tests**

Run: `pnpm --filter server test`
Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add packages/server/src/middleware/ packages/server/src/routes/ packages/server/src/controllers/ packages/server/src/services/auth.service.ts packages/server/src/services/auth.service.test.ts
git commit -m "feat: implement authentication (JWT + bcrypt)"
```

### Task 5: Executor Service (Core Engine)

**Files:**
- Create: `packages/server/src/services/executor.service.ts`
- Create: `packages/server/src/services/executor.service.test.ts`

- [ ] **Step 1: Write failing test for executor service**

```ts
import { describe, it, expect } from 'vitest';
import { applyAliases, executeWorkflow } from './executor.service';

describe('executor.service', () => {
  const sampleJson = JSON.stringify({
    "29": {
      "inputs": { "filename_prefix": "test", "images": ["30:8", 0] },
      "class_type": "SaveImage",
      "_meta": { "title": "保存图像" }
    },
    "30:19": {
      "inputs": { "value": "original prompt" },
      "class_type": "PrimitiveStringMultiline",
      "_meta": { "title": "Text String" }
    }
  });

  it('applyAliases replaces primitive values', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null }
    ];
    const result = applyAliases(sampleJson, params, { img_desc: 'a cute cat' });
    const parsed = JSON.parse(result);
    expect(parsed['30:19'].inputs.value).toBe('a cute cat');
  });

  it('applyAliases does not modify node connections (arrays)', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '29', fieldName: 'images', alias: 'img_alias', label: null }
    ];
    const result = applyAliases(sampleJson, params, { img_alias: 'something' });
    const parsed = JSON.parse(result);
    // images is an array (connection), should NOT be replaced
    expect(Array.isArray(parsed['29'].inputs.images)).toBe(true);
  });

  it('applyAliases throws on missing alias value', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: '30:19', fieldName: 'value', alias: 'img_desc', label: null }
    ];
    expect(() => applyAliases(sampleJson, params, {})).toThrow('Missing required parameter: img_desc');
  });

  it('applyAliases ignores params for non-existent nodes', () => {
    const params = [
      { id: 1, workflowId: 'test', nodeId: 'nonexistent', fieldName: 'value', alias: 'x', label: null }
    ];
    const result = applyAliases(sampleJson, params, { x: 'val' });
    expect(result).toBe(sampleJson);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter server test`
Expected: Fails — executor.service.ts not found

- [ ] **Step 3: Implement executor.service.ts**

```ts
export interface WorkflowParam {
  id: number;
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label: string | null;
}

export function applyAliases(
  rawJson: string,
  params: WorkflowParam[],
  aliasValues: Record<string, string>
): string {
  const workflow = JSON.parse(rawJson);

  for (const param of params) {
    const node = workflow[param.nodeId];
    if (!node) continue;

    const currentValue = node.inputs?.[param.fieldName];
    if (Array.isArray(currentValue)) continue;

    if (!(param.alias in aliasValues)) {
      throw new Error(`Missing required parameter: ${param.alias}`);
    }

    node.inputs[param.fieldName] = aliasValues[param.alias];
  }

  return JSON.stringify(workflow);
}

export async function executeWorkflow(
  rawJson: string,
  params: WorkflowParam[],
  aliasValues: Record<string, string>,
  comfyuiBaseUrl: string
): Promise<unknown> {
  const modifiedJson = applyAliases(rawJson, params, aliasValues);
  const response = await fetch(`${comfyuiBaseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: modifiedJson,
  });
  if (!response.ok) {
    throw new Error(`ComfyUI returned status ${response.status}`);
  }
  return response.json();
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter server test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/executor.service.ts packages/server/src/services/executor.service.test.ts
git commit -m "feat: implement executor service core engine"
```

### Task 6: Workflow Service (CRUD + Params)

**Files:**
- Create: `packages/server/src/services/workflow.service.ts`
- Create: `packages/server/src/services/workflow.service.test.ts`

- [ ] **Step 1: Write test for workflow service**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { WorkflowService } from './workflow.service';

describe('WorkflowService', () => {
  let service: WorkflowService;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_params (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, node_id TEXT NOT NULL, field_name TEXT NOT NULL, alias TEXT NOT NULL UNIQUE, label TEXT);
    `);
    const db = drizzle(sqlite, { schema });
    service = new WorkflowService(db);
  });

  it('creates and retrieves a workflow', () => {
    const wf = service.create({ id: 'my-flow', name: 'Test Flow', rawJson: '{}' });
    expect(wf.id).toBe('my-flow');
    expect(wf.name).toBe('Test Flow');

    const retrieved = service.getById('my-flow');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('Test Flow');
  });

  it('lists all workflows', () => {
    service.create({ id: 'wf1', name: 'WF1', rawJson: '{}' });
    service.create({ id: 'wf2', name: 'WF2', rawJson: '{}' });
    const list = service.list();
    expect(list).toHaveLength(2);
  });

  it('returns null for non-existent workflow', () => {
    expect(service.getById('nonexistent')).toBeNull();
  });

  it('updates a workflow', () => {
    service.create({ id: 'wf', name: 'Original', rawJson: '{}' });
    service.update('wf', { name: 'Updated' });
    const wf = service.getById('wf');
    expect(wf!.name).toBe('Updated');
  });

  it('deletes a workflow', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.delete('wf');
    expect(service.getById('wf')).toBeNull();
  });

  it('adds and lists params for a workflow', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const param = service.addParam({
      workflowId: 'wf',
      nodeId: '30:19',
      fieldName: 'value',
      alias: 'img_desc',
    });
    expect(param.alias).toBe('img_desc');

    const params = service.getParams('wf');
    expect(params).toHaveLength(1);
    expect(params[0].alias).toBe('img_desc');
  });

  it('deletes params when workflow is deleted', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'a' });
    service.delete('wf');
    const params = service.getParams('wf');
    expect(params).toHaveLength(0);
  });

  it('throws on duplicate alias', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'dup' });
    expect(() => service.addParam({ workflowId: 'wf', nodeId: '2', fieldName: 'v', alias: 'dup' })).toThrow();
  });

  it('deletes a param', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'a' });
    service.deleteParam(p.id);
    expect(service.getParams('wf')).toHaveLength(0);
  });

  it('updates a param', () => {
    service.create({ id: 'wf', name: 'WF', rawJson: '{}' });
    const p = service.addParam({ workflowId: 'wf', nodeId: '1', fieldName: 'v', alias: 'a' });
    const updated = service.updateParam(p.id, { alias: 'b', label: '标签' });
    expect(updated.alias).toBe('b');
    expect(updated.label).toBe('标签');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter server test`
Expected: Fails

- [ ] **Step 3: Implement workflow.service.ts**

```ts
import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';

interface CreateWorkflowInput {
  id: string;
  name: string;
  rawJson: string;
}

interface UpdateWorkflowInput {
  name?: string;
  rawJson?: string;
}

interface AddParamInput {
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label?: string;
}

interface UpdateParamInput {
  alias?: string;
  label?: string | null;
}

export class WorkflowService {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  create(input: CreateWorkflowInput) {
    const now = new Date().toISOString();
    this.db.insert(schema.workflows).values({
      id: input.id,
      name: input.name,
      rawJson: input.rawJson,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.getById(input.id)!;
  }

  list() {
    return this.db.select().from(schema.workflows).orderBy(schema.workflows.createdAt).all();
  }

  getById(id: string) {
    return this.db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get() ?? null;
  }

  update(id: string, input: UpdateWorkflowInput) {
    const now = new Date().toISOString();
    this.db.update(schema.workflows)
      .set({ ...input, updatedAt: now })
      .where(eq(schema.workflows.id, id))
      .run();
    return this.getById(id)!;
  }

  delete(id: string) {
    this.db.delete(schema.workflows).where(eq(schema.workflows.id, id)).run();
  }

  addParam(input: AddParamInput) {
    this.db.insert(schema.workflowParams).values({
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      fieldName: input.fieldName,
      alias: input.alias,
      label: input.label ?? null,
    }).run();
    return this.db.select().from(schema.workflowParams)
      .where(eq(schema.workflowParams.alias, input.alias))
      .get()!;
  }

  getParams(workflowId: string) {
    return this.db.select()
      .from(schema.workflowParams)
      .where(eq(schema.workflowParams.workflowId, workflowId))
      .all();
  }

  updateParam(id: number, input: UpdateParamInput) {
    this.db.update(schema.workflowParams)
      .set(input)
      .where(eq(schema.workflowParams.id, id))
      .run();
    return this.db.select().from(schema.workflowParams)
      .where(eq(schema.workflowParams.id, id))
      .get()!;
  }

  deleteParam(id: number) {
    this.db.delete(schema.workflowParams).where(eq(schema.workflowParams.id, id)).run();
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter server test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/workflow.service.ts packages/server/src/services/workflow.service.test.ts
git commit -m "feat: implement workflow CRUD and param management"
```

### Task 7: Workflow API Endpoints (Controller + Routes)

**Files:**
- Create: `packages/server/src/controllers/workflow.controller.ts`
- Create: `packages/server/src/controllers/settings.controller.ts`
- Create: `packages/server/src/routes/workflow.routes.ts`
- Create: `packages/server/src/routes/settings.routes.ts`
- Create: `packages/server/src/middleware/errorHandler.ts`
- Modify: `packages/server/src/index.ts`
- Create: `packages/server/src/routes/workflow.routes.test.ts`
- Create: `packages/server/src/routes/settings.routes.test.ts`

- [ ] **Step 1: Create error handler middleware**

```ts
import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error(err);

  if (err.message.startsWith('Missing required parameter:')) {
    res.status(400).json({ error: err.message, code: 'missing_parameter' });
    return;
  }

  if (err.message === 'Invalid password') {
    res.status(401).json({ error: err.message, code: 'unauthorized' });
    return;
  }

  if (err.message?.includes('UNIQUE constraint failed')) {
    res.status(409).json({ error: 'Alias already exists', code: 'alias_conflict' });
    return;
  }

  if (err.message?.startsWith('ComfyUI returned status')) {
    res.status(502).json({ error: 'ComfyUI service error', code: 'comfyui_unreachable' });
    return;
  }

  res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
}
```

- [ ] **Step 2: Create workflow controller**

```ts
import { Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { WorkflowService } from '../services/workflow.service';
import { executeWorkflow } from '../services/executor.service';
import { SettingsService } from '../services/settings.service';

export function createWorkflowController(db: BetterSQLite3Database<typeof schema>) {
  const workflowService = new WorkflowService(db);
  const settingsService = new SettingsService(db);

  return {
    list(_req: Request, res: Response): void {
      res.json(workflowService.list());
    },

    getById(req: Request, res: Response): void {
      const wf = workflowService.getById(req.params.id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const params = workflowService.getParams(req.params.id);
      res.json({ ...wf, params });
    },

    create(req: Request, res: Response): void {
      const { id, name, rawJson } = req.body;
      if (!id || !name || !rawJson) {
        res.status(400).json({ error: 'id, name, and rawJson are required', code: 'missing_parameter' });
        return;
      }
      const wf = workflowService.create({ id, name, rawJson });
      res.status(201).json(wf);
    },

    update(req: Request, res: Response): void {
      const existing = workflowService.getById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const wf = workflowService.update(req.params.id, req.body);
      res.json(wf);
    },

    delete(req: Request, res: Response): void {
      const existing = workflowService.getById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      workflowService.delete(req.params.id);
      res.status(204).send();
    },

    addParam(req: Request, res: Response): void {
      const existing = workflowService.getById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const { nodeId, fieldName, alias, label } = req.body;
      if (!nodeId || !fieldName || !alias) {
        res.status(400).json({ error: 'nodeId, fieldName, and alias are required', code: 'missing_parameter' });
        return;
      }
      try {
        const param = workflowService.addParam({ workflowId: req.params.id, nodeId, fieldName, alias, label });
        res.status(201).json(param);
      } catch (err: unknown) {
        if (err instanceof Error && err.message?.includes('UNIQUE constraint failed')) {
          res.status(409).json({ error: 'Alias already exists', code: 'alias_conflict' });
          return;
        }
        throw err;
      }
    },

    updateParam(req: Request, res: Response): void {
      const param = workflowService.updateParam(Number(req.params.paramId), req.body);
      res.json(param);
    },

    deleteParam(req: Request, res: Response): void {
      workflowService.deleteParam(Number(req.params.paramId));
      res.status(204).send();
    },

    async execute(req: Request, res: Response): Promise<void> {
      const wf = workflowService.getById(req.params.id);
      if (!wf) {
        res.status(404).json({ error: 'Workflow not found', code: 'workflow_not_found' });
        return;
      }
      const params = workflowService.getParams(req.params.id);
      const baseUrl = settingsService.get('comfyui_base_url');
      if (!baseUrl) {
        res.status(400).json({ error: 'ComfyUI base URL not configured', code: 'missing_parameter' });
        return;
      }
      try {
        const result = await executeWorkflow(wf.rawJson, params, req.body, baseUrl);
        res.json(result);
      } catch (err: unknown) {
        if (err instanceof Error) {
          res.status(502).json({ error: err.message, code: 'comfyui_unreachable' });
          return;
        }
        throw err;
      }
    },
  };
}
```

- [ ] **Step 3: Create settings controller**

```ts
import { Request, Response } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { SettingsService } from '../services/settings.service';

export function createSettingsController(db: BetterSQLite3Database<typeof schema>) {
  const settingsService = new SettingsService(db);

  return {
    getAll(_req: Request, res: Response): void {
      res.json(settingsService.getAll());
    },

    update(req: Request, res: Response): void {
      const { key, value } = req.body;
      if (!key || value === undefined) {
        res.status(400).json({ error: 'key and value are required', code: 'missing_parameter' });
        return;
      }
      settingsService.set(key, value);
      res.json({ key, value });
    },
  };
}
```

- [ ] **Step 4: Create workflow routes**

```ts
import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createWorkflowController } from '../controllers/workflow.controller';
import { createAuthMiddleware } from '../middleware/auth';

export function createWorkflowRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createWorkflowController(db);
  const auth = createAuthMiddleware(db);

  // Public endpoint
  router.post('/:id/execute', controller.execute);

  // Protected endpoints
  router.get('/', auth, controller.list);
  router.post('/', auth, controller.create);
  router.get('/:id', auth, controller.getById);
  router.put('/:id', auth, controller.update);
  router.delete('/:id', auth, controller.delete);
  router.post('/:id/params', auth, controller.addParam);
  router.put('/:id/params/:paramId', auth, controller.updateParam);
  router.delete('/:id/params/:paramId', auth, controller.deleteParam);

  return router;
}
```

- [ ] **Step 5: Create settings routes**

```ts
import { Router } from 'express';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createSettingsController } from '../controllers/settings.controller';
import { createAuthMiddleware } from '../middleware/auth';

export function createSettingsRoutes(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();
  const controller = createSettingsController(db);
  const auth = createAuthMiddleware(db);

  router.get('/', auth, controller.getAll);
  router.put('/', auth, controller.update);

  return router;
}
```

- [ ] **Step 6: Write integration tests for workflow routes**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../models/schema';
import { createWorkflowRoutes } from './workflow.routes';
import { createAuthRoutes } from './auth.routes';

describe('Workflow API', () => {
  let app: express.Express;

  beforeAll(() => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workflow_params (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, node_id TEXT NOT NULL, field_name TEXT NOT NULL, alias TEXT NOT NULL UNIQUE, label TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const db = drizzle(sqlite, { schema });

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRoutes(db));
    app.use('/api/workflows', createWorkflowRoutes(db));
  });

  function getToken(): string {
    return 'test-token';
  }

  it('POST /api/workflows with auth creates a workflow', async () => {
    // First login to get token
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token;

    const res = await supertest(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'test-flow', name: 'Test', rawJson: '{}' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('test-flow');
  });

  it('GET /api/workflows returns list', async () => {
    const loginRes = await supertest(app)
      .post('/api/auth/login')
      .send({ password: '0d000721' });
    const token = loginRes.body.token;

    const res = await supertest(app)
      .get('/api/workflows')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/workflows/:id/execute without auth returns 400 (no base URL)', async () => {
    const res = await supertest(app)
      .post('/api/workflows/test-flow/execute')
      .send({ img_desc: 'cat' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 7: Update index.ts to wire all routes**

```ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { db } from './models/db';
import { createAuthRoutes } from './routes/auth.routes';
import { createWorkflowRoutes } from './routes/workflow.routes';
import { createSettingsRoutes } from './routes/settings.routes';
import { errorHandler } from './middleware/errorHandler';

const app = express();
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
```

- [ ] **Step 8: Run all tests**

Run: `pnpm --filter server test`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/routes/ packages/server/src/controllers/ packages/server/src/middleware/errorHandler.ts packages/server/src/index.ts
git commit -m "feat: implement workflow and settings API endpoints"
```

### Task 8: Client Scaffold (Vue 3 + Vuetify)

**Files:**
- Create: `packages/client/package.json`
- Create: `packages/client/tsconfig.json`
- Create: `packages/client/vite.config.ts`
- Create: `packages/client/index.html`
- Create: `packages/client/src/main.ts`
- Create: `packages/client/src/App.vue`
- Create: `packages/client/src/router/index.ts`
- Create: `packages/client/src/types/index.ts`
- Create: `packages/client/src/api/client.ts`
- Create: `packages/client/src/vite-env.d.ts`

- [ ] **Step 1: Create packages/client/package.json**

```json
{
  "name": "client",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "^3.5.0",
    "vue-router": "^4.4.0",
    "vuetify": "^3.7.0",
    "@mdi/font": "^7.4.0",
    "axios": "^1.7.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "@vitejs/plugin-vue": "^5.1.0",
    "vue-tsc": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create packages/client/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.vue"]
}
```

- [ ] **Step 3: Create packages/client/vite.config.ts**

```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:10721',
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 4: Create packages/client/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ComfyUI Easy Bridge</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 5: Create packages/client/src/main.ts**

```ts
import { createApp } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import '@mdi/font/css/materialdesignicons.css';
import 'vuetify/styles';
import App from './App.vue';
import { router } from './router';

const vuetify = createVuetify({
  components,
  directives,
});

const app = createApp(App);
app.use(vuetify);
app.use(router);
app.mount('#app');
```

- [ ] **Step 6: Create packages/client/src/App.vue**

```vue
<template>
  <v-app>
    <router-view />
  </v-app>
</template>

<script setup lang="ts">
</script>
```

- [ ] **Step 7: Create packages/client/src/vite-env.d.ts**

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 8: Create packages/client/src/types/index.ts**

```ts
export interface Workflow {
  id: string;
  name: string;
  rawJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowParam {
  id: number;
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label: string | null;
}

export interface WorkflowDetail extends Workflow {
  params: WorkflowParam[];
}

export interface Settings {
  [key: string]: string;
}
```

- [ ] **Step 9: Create packages/client/src/api/client.ts**

```ts
import axios from 'axios';

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
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default client;
```

- [ ] **Step 10: Create packages/client/src/router/index.ts**

```ts
import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/pages/LoginPage.vue'),
    },
    {
      path: '/admin',
      name: 'WorkflowList',
      component: () => import('@/pages/WorkflowListPage.vue'),
    },
    {
      path: '/admin/workflow/new',
      name: 'WorkflowNew',
      component: () => import('@/pages/WorkflowEditPage.vue'),
    },
    {
      path: '/admin/workflow/:id',
      name: 'WorkflowDetail',
      component: () => import('@/pages/WorkflowDetailPage.vue'),
    },
    {
      path: '/admin/workflow/:id/edit',
      name: 'WorkflowEdit',
      component: () => import('@/pages/WorkflowEditPage.vue'),
    },
    {
      path: '/admin/settings',
      name: 'Settings',
      component: () => import('@/pages/SettingsPage.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/admin',
    },
  ],
});

router.beforeEach((to) => {
  const token = localStorage.getItem('token');
  if (to.name !== 'Login' && !token) {
    return { name: 'Login' };
  }
});

export { router };
```

- [ ] **Step 11: Install client dependencies and verify dev server starts**

Run: `pnpm install`
Then: `pnpm --filter client dev`
Expected: Vite dev server starts on port 5173
Kill with Ctrl+C.

- [ ] **Step 12: Commit**

```bash
git add packages/client/
git commit -m "feat: scaffold Vue3 + Vuetify client"
```

### Task 9: Login Page

**Files:**
- Create: `packages/client/src/pages/LoginPage.vue`
- Create: `packages/client/src/api/auth.ts`

- [ ] **Step 1: Create auth API module**

```ts
import client from './client';

export interface LoginResponse {
  token: string;
}

export async function login(password: string): Promise<LoginResponse> {
  const res = await client.post<LoginResponse>('/auth/login', { password });
  return res.data;
}
```

- [ ] **Step 2: Create LoginPage.vue**

```vue
<template>
  <v-container class="fill-height d-flex align-center justify-center">
    <v-card width="400" class="pa-4">
      <v-card-title class="text-h5 text-center">ComfyUI Easy Bridge</v-card-title>
      <v-card-subtitle class="text-center mb-4">管理员登录</v-card-subtitle>
      <v-card-text>
        <v-alert v-if="error" type="error" closable class="mb-4">{{ error }}</v-alert>
        <v-text-field
          v-model="password"
          label="密码"
          type="password"
          variant="outlined"
          @keyup.enter="handleLogin"
          :disabled="loading"
        />
      </v-card-text>
      <v-card-actions class="justify-center pb-4">
        <v-btn
          color="primary"
          size="large"
          :loading="loading"
          @click="handleLogin"
        >登录</v-btn>
      </v-card-actions>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { login } from '@/api/auth';

const router = useRouter();
const password = ref('');
const error = ref('');
const loading = ref(false);

async function handleLogin() {
  if (!password.value) {
    error.value = '请输入密码';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const res = await login(password.value);
    localStorage.setItem('token', res.token);
    router.push('/admin');
  } catch {
    error.value = '密码错误';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.fill-height {
  min-height: 100vh;
}
</style>
```

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/pages/LoginPage.vue packages/client/src/api/auth.ts
git commit -m "feat: add login page"
```

### Task 10: Workflow List Page

**Files:**
- Create: `packages/client/src/pages/WorkflowListPage.vue`
- Create: `packages/client/src/api/workflows.ts`

- [ ] **Step 1: Create workflows API module**

```ts
import client from './client';
import type { Workflow, WorkflowDetail } from '@/types';

export async function listWorkflows(): Promise<Workflow[]> {
  const res = await client.get<Workflow[]>('/workflows');
  return res.data;
}

export async function getWorkflow(id: string): Promise<WorkflowDetail> {
  const res = await client.get<WorkflowDetail>(`/workflows/${id}`);
  return res.data;
}

export async function createWorkflow(data: { id: string; name: string; rawJson: string }): Promise<Workflow> {
  const res = await client.post<Workflow>('/workflows', data);
  return res.data;
}

export async function updateWorkflow(id: string, data: Partial<{ name: string; rawJson: string }>): Promise<Workflow> {
  const res = await client.put<Workflow>(`/workflows/${id}`, data);
  return res.data;
}

export async function deleteWorkflow(id: string): Promise<void> {
  await client.delete(`/workflows/${id}`);
}

export async function addParam(workflowId: string, data: { nodeId: string; fieldName: string; alias: string; label?: string }) {
  const res = await client.post(`/workflows/${workflowId}/params`, data);
  return res.data;
}

export async function updateParam(workflowId: string, paramId: number, data: Partial<{ alias: string; label: string }>) {
  const res = await client.put(`/workflows/${workflowId}/params/${paramId}`, data);
  return res.data;
}

export async function deleteParam(workflowId: string, paramId: number): Promise<void> {
  await client.delete(`/workflows/${workflowId}/params/${paramId}`);
}
```

- [ ] **Step 2: Create WorkflowListPage.vue**

```vue
<template>
  <v-app-bar>
    <v-app-bar-title>ComfyUI Easy Bridge</v-app-bar-title>
    <v-spacer />
    <v-btn to="/admin/settings" variant="text" prepend-icon="mdi-cog">设置</v-btn>
    <v-btn variant="text" @click="handleLogout" prepend-icon="mdi-logout">退出</v-btn>
  </v-app-bar>

  <v-container class="mt-4">
    <v-row class="mb-4 align-center">
      <v-col><h2 class="text-h5">工作流列表</h2></v-col>
      <v-col cols="auto">
        <v-btn color="primary" to="/admin/workflow/new" prepend-icon="mdi-plus">新建工作流</v-btn>
      </v-col>
    </v-row>

    <v-card v-if="workflows.length === 0">
      <v-card-text class="text-center py-8 text-grey">暂无工作流，点击上方按钮新建</v-card-text>
    </v-card>

    <v-list v-else lines="two">
      <v-list-item
        v-for="wf in workflows"
        :key="wf.id"
        :title="wf.name"
        :subtitle="`ID: ${wf.id} | 创建: ${wf.createdAt}`"
        @click="router.push(`/admin/workflow/${wf.id}`)"
      >
        <template #append>
          <v-btn icon variant="text" @click.stop="handleDelete(wf.id)">
            <v-icon>mdi-delete</v-icon>
          </v-btn>
        </template>
      </v-list-item>
    </v-list>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>确认删除</v-card-title>
        <v-card-text>确定要删除该工作流吗？此操作不可撤销。</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleteDialog = false">取消</v-btn>
          <v-btn color="error" @click="confirmDelete">删除</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">{{ snackbar.text }}</v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { listWorkflows, deleteWorkflow } from '@/api/workflows';
import type { Workflow } from '@/types';

const router = useRouter();
const workflows = ref<Workflow[]>([]);
const deleteDialog = ref(false);
const deleteTarget = ref<string | null>(null);
const snackbar = ref({ show: false, text: '', color: 'success' });

async function load() {
  try {
    workflows.value = await listWorkflows();
  } catch {
    snackbar.value = { show: true, text: '加载失败', color: 'error' };
  }
}

function handleDelete(id: string) {
  deleteTarget.value = id;
  deleteDialog.value = true;
}

async function confirmDelete() {
  if (!deleteTarget.value) return;
  try {
    await deleteWorkflow(deleteTarget.value);
    snackbar.value = { show: true, text: '已删除', color: 'success' };
    await load();
  } catch {
    snackbar.value = { show: true, text: '删除失败', color: 'error' };
  } finally {
    deleteDialog.value = false;
    deleteTarget.value = null;
  }
}

function handleLogout() {
  localStorage.removeItem('token');
  router.push('/login');
}

onMounted(load);
</script>
```

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/pages/WorkflowListPage.vue packages/client/src/api/workflows.ts
git commit -m "feat: add workflow list page"
```

### Task 11: Workflow Create/Edit Page

**Files:**
- Create: `packages/client/src/pages/WorkflowEditPage.vue`

- [ ] **Step 1: Create WorkflowEditPage.vue**

```vue
<template>
  <v-app-bar>
    <v-app-bar-title>{{ isEdit ? '编辑工作流' : '新建工作流' }}</v-app-bar-title>
    <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">返回</v-btn>
  </v-app-bar>

  <v-container class="mt-4">
    <v-card>
      <v-card-text>
        <v-alert v-if="error" type="error" closable class="mb-4">{{ error }}</v-alert>

        <v-text-field
          v-model="form.id"
          label="工作流 ID"
          hint="唯一标识，创建后不可修改"
          variant="outlined"
          class="mb-3"
          :disabled="isEdit"
        />
        <v-btn
          v-if="!isEdit"
          size="small"
          variant="text"
          class="mb-3"
          @click="generateId"
        >随机生成</v-btn>

        <v-text-field
          v-model="form.name"
          label="工作流名称"
          variant="outlined"
          class="mb-3"
        />

        <v-textarea
          v-model="form.rawJson"
          label="ComfyUI API JSON"
          variant="outlined"
          rows="12"
          class="mb-3"
          :clearable="true"
        />

        <v-file-input
          v-if="!isEdit"
          label="或上传 JSON 文件"
          variant="outlined"
          accept=".json"
          @update:model-value="handleFileUpload"
        />
      </v-card-text>
      <v-card-actions class="pa-4">
        <v-spacer />
        <v-btn variant="text" to="/admin">取消</v-btn>
        <v-btn color="primary" :loading="saving" @click="handleSave">保存</v-btn>
      </v-card-actions>
    </v-card>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">{{ snackbar.text }}</v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { createWorkflow, getWorkflow, updateWorkflow } from '@/api/workflows';

const route = useRoute();
const router = useRouter();
const isEdit = computed(() => !!route.params.id);

const form = ref({ id: '', name: '', rawJson: '' });
const error = ref('');
const saving = ref(false);
const snackbar = ref({ show: false, text: '', color: 'success' });

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  form.value.id = result;
}

function handleFileUpload(file: File | null) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    form.value.rawJson = reader.result as string;
  };
  reader.readAsText(file);
}

async function handleSave() {
  error.value = '';
  if (!form.value.id || !form.value.name || !form.value.rawJson) {
    error.value = '请填写所有必填字段';
    return;
  }
  saving.value = true;
  try {
    if (isEdit.value) {
      await updateWorkflow(route.params.id as string, {
        name: form.value.name,
        rawJson: form.value.rawJson,
      });
    } else {
      await createWorkflow(form.value);
    }
    snackbar.value = { show: true, text: '保存成功', color: 'success' };
    setTimeout(() => router.push('/admin'), 500);
  } catch {
    error.value = '保存失败，请检查 ID 是否重复';
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (isEdit.value) {
    try {
      const wf = await getWorkflow(route.params.id as string);
      form.value = { id: wf.id, name: wf.name, rawJson: wf.rawJson };
    } catch {
      error.value = '工作流不存在';
    }
  }
});
</script>
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/pages/WorkflowEditPage.vue
git commit -m "feat: add workflow create/edit page"
```

### Task 12: Workflow Detail Page (Param Alias Management)

**Files:**
- Create: `packages/client/src/pages/WorkflowDetailPage.vue`

- [ ] **Step 1: Create WorkflowDetailPage.vue**

```vue
<template>
  <v-app-bar>
    <v-app-bar-title>{{ workflow?.name ?? '加载中...' }}</v-app-bar-title>
    <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">返回</v-btn>
  </v-app-bar>

  <v-container class="mt-4">
    <v-alert v-if="error" type="error" closable class="mb-4">{{ error }}</v-alert>

    <v-card class="mb-4">
      <v-card-text>
        <div><strong>ID:</strong> {{ workflow?.id }}</div>
        <div><strong>名称:</strong> {{ workflow?.name }}</div>
        <div><strong>创建时间:</strong> {{ workflow?.createdAt }}</div>
      </v-card-text>
      <v-card-actions>
        <v-btn :to="`/admin/workflow/${workflow?.id}/edit`" variant="text" prepend-icon="mdi-pencil">编辑</v-btn>
      </v-card-actions>
    </v-card>

    <v-card>
      <v-card-title>参数别名配置</v-card-title>
      <v-card-text>
        <p class="text-body-2 text-grey mb-4">
          下方列出了工作流 JSON 中所有节点的可配置输入字段。选择需要暴露给外部调用的字段，设置别名。
        </p>

        <v-table v-if="nodes.length > 0">
          <thead>
            <tr>
              <th>节点 ID</th>
              <th>节点标题</th>
              <th>字段名</th>
              <th>当前值</th>
              <th>别名</th>
              <th>标签</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(node, ni) in nodes" :key="ni">
              <td>{{ node.nodeId }}</td>
              <td>{{ node.title }}</td>
              <td>
                <v-select
                  v-model="node.selectedField"
                  :items="node.fields"
                  density="compact"
                  variant="outlined"
                  hide-details
                  @update:model-value="onFieldChange(node)"
                />
              </td>
              <td class="text-caption text-grey" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">
                {{ node.fieldValue }}
              </td>
              <td>
                <v-text-field
                  v-if="node.selectedField"
                  v-model="node.editAlias"
                  density="compact"
                  variant="outlined"
                  placeholder="alias"
                  hide-details
                />
              </td>
              <td>
                <v-text-field
                  v-if="node.selectedField"
                  v-model="node.editLabel"
                  density="compact"
                  variant="outlined"
                  placeholder="标签(可选)"
                  hide-details
                />
              </td>
              <td>
                <v-btn
                  v-if="node.selectedField && node.editAlias"
                  size="small"
                  color="primary"
                  variant="text"
                  :loading="node.saving"
                  :disabled="!node.editAlias"
                  @click="saveParam(node)"
                >
                  {{ node.paramId ? '更新' : '添加' }}
                </v-btn>
                <v-btn
                  v-if="node.paramId"
                  size="small"
                  color="error"
                  variant="text"
                  @click="removeParam(node)"
                >删除</v-btn>
              </td>
            </tr>
          </tbody>
        </v-table>

        <p v-else class="text-grey text-center py-4">无法解析工作流 JSON，请检查原始数据</p>
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">{{ snackbar.text }}</v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { getWorkflow, addParam, updateParam, deleteParam } from '@/api/workflows';
import type { WorkflowDetail, WorkflowParam } from '@/types';

interface NodeField {
  nodeId: string;
  title: string;
  fields: string[];
  selectedField: string;
  fieldValue: string;
  editAlias: string;
  editLabel: string;
  paramId: number | null;
  saving: boolean;
}

const route = useRoute();
const workflow = ref<WorkflowDetail | null>(null);
const nodes = ref<NodeField[]>([]);
const error = ref('');
const snackbar = ref({ show: false, text: '', color: 'success' });

function parseNodes(wf: WorkflowDetail) {
  const result: NodeField[] = [];
  const paramMap = new Map<string, WorkflowParam>();
  for (const p of wf.params) {
    paramMap.set(`${p.nodeId}:${p.fieldName}`, p);
  }

  try {
    const json = JSON.parse(wf.rawJson);
    for (const [nodeId, node] of Object.entries(json)) {
      const n = node as Record<string, unknown>;
      const inputs = n.inputs as Record<string, unknown> ?? {};
      const title = ((n._meta as Record<string, unknown>)?.title as string) ?? nodeId;
      const fields: string[] = [];
      let selectedField = '';
      let fieldValue = '';
      let editAlias = '';
      let editLabel = '';
      let paramId: number | null = null;

      for (const [fieldName, fieldVal] of Object.entries(inputs)) {
        if (Array.isArray(fieldVal)) continue;
        fields.push(fieldName);
        const existing = paramMap.get(`${nodeId}:${fieldName}`);
        if (existing) {
          selectedField = fieldName;
          fieldValue = String(fieldVal);
          editAlias = existing.alias;
          editLabel = existing.label ?? '';
          paramId = existing.id;
        }
      }

      if (fields.length > 0) {
        result.push({
          nodeId,
          title,
          fields,
          selectedField,
          fieldValue,
          editAlias,
          editLabel,
          paramId,
          saving: false,
        });
      }
    }
  } catch {
    // JSON parse failed
  }

  nodes.value = result;
}

function onFieldChange(node: NodeField) {
  if (!node.selectedField) {
    node.editAlias = '';
    node.editLabel = '';
    node.paramId = null;
    return;
  }
  const key = `${node.nodeId}:${node.selectedField}`;
  const existing = workflow.value?.params.find(p => `${p.nodeId}:${p.fieldName}` === key);
  node.editAlias = existing?.alias ?? '';
  node.editLabel = existing?.label ?? '';
  node.paramId = existing?.id ?? null;
}

async function saveParam(node: NodeField) {
  if (!workflow.value || !node.selectedField || !node.editAlias) return;
  node.saving = true;
  try {
    if (node.paramId) {
      await updateParam(workflow.value.id, node.paramId, { alias: node.editAlias, label: node.editLabel });
    } else {
      await addParam(workflow.value.id, {
        nodeId: node.nodeId,
        fieldName: node.selectedField,
        alias: node.editAlias,
        label: node.editLabel,
      });
    }
    snackbar.value = { show: true, text: '保存成功', color: 'success' };
    await load();
  } catch {
    snackbar.value = { show: true, text: '保存失败，别名可能重复', color: 'error' };
  } finally {
    node.saving = false;
  }
}

async function removeParam(node: NodeField) {
  if (!workflow.value || !node.paramId) return;
  try {
    await deleteParam(workflow.value.id, node.paramId);
    snackbar.value = { show: true, text: '已删除', color: 'success' };
    await load();
  } catch {
    snackbar.value = { show: true, text: '删除失败', color: 'error' };
  }
}

async function load() {
  try {
    const wf = await getWorkflow(route.params.id as string);
    workflow.value = wf;
    parseNodes(wf);
  } catch {
    error.value = '工作流不存在';
  }
}

onMounted(load);
</script>
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/pages/WorkflowDetailPage.vue
git commit -m "feat: add workflow detail page with param alias management"
```

### Task 13: Settings Page

**Files:**
- Create: `packages/client/src/pages/SettingsPage.vue`
- Create: `packages/client/src/api/settings.ts`

- [ ] **Step 1: Create settings API module**

```ts
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
```

- [ ] **Step 2: Create SettingsPage.vue**

```vue
<template>
  <v-app-bar>
    <v-app-bar-title>系统设置</v-app-bar-title>
    <v-btn to="/admin" variant="text" prepend-icon="mdi-arrow-left">返回</v-btn>
  </v-app-bar>

  <v-container class="mt-4">
    <v-card>
      <v-card-text>
        <v-alert v-if="error" type="error" closable class="mb-4">{{ error }}</v-alert>

        <v-text-field
          v-model="comfyuiUrl"
          label="ComfyUI 服务地址"
          hint="例如: http://localhost:8188"
          variant="outlined"
          class="mb-4"
          placeholder="http://localhost:8188"
        />

        <v-btn color="primary" :loading="saving" @click="handleSave">保存</v-btn>
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color">{{ snackbar.text }}</v-snackbar>
  </v-container>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getSettings, updateSetting } from '@/api/settings';

const comfyuiUrl = ref('');
const error = ref('');
const saving = ref(false);
const snackbar = ref({ show: false, text: '', color: 'success' });

async function handleSave() {
  saving.value = true;
  error.value = '';
  try {
    await updateSetting('comfyui_base_url', comfyuiUrl.value);
    snackbar.value = { show: true, text: '已保存', color: 'success' };
  } catch {
    error.value = '保存失败';
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    const settings = await getSettings();
    comfyuiUrl.value = settings.comfyui_base_url ?? '';
  } catch {
    error.value = '加载设置失败';
  }
});
</script>
```

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/pages/SettingsPage.vue packages/client/src/api/settings.ts
git commit -m "feat: add settings page"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- Database schema (workflows, workflow_params, settings) — Tasks 2, 3
- Backend layered architecture (routes → controllers → services) — Tasks 4, 6, 7
- Executor service (alias replacement + ComfyUI call) — Task 5
- Auth (JWT + bcrypt, default password 0d000721) — Task 4
- All API endpoints (auth, workflows CRUD, params CRUD, settings, execute) — Tasks 4, 7
- Frontend pages (login, list, create/edit, detail, settings) — Tasks 9-13
- Error handling middleware — Task 7
- Test strategy (vitest + supertest) — Tasks 1-7

**2. Placeholder check:** No TBD, TODO, or placeholder patterns found.

**3. Type consistency:** All type references (Workflow, WorkflowParam, WorkflowDetail, Settings) are consistently used across tasks.
