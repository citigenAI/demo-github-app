# Story 1 — Project Skeleton & Deployment Pipeline

**Epic:** A — Foundation
**Depends on:** None (this is the start)
**Unlocks:** All other stories
**Complexity:** Medium (1–3 days)

---

## 1. Goal

Stand up the smallest possible Swara Magical Memories app that is **production-shaped** — meaning every architectural seam the later stories rely on is already in place. The app does almost nothing user-visible, but its skeleton is correct: typed config, Supabase connection, Prisma migrations, basic auth scaffold (no UI yet), worker process scaffold (no jobs yet), CI green, deployed to Vercel.

By the end of this story, **any subsequent story should be able to add its feature without reshaping the foundation.**

---

## 2. Success Criteria

A reviewer checking out `main` and following the run instructions should be able to:

- [ ] `npm install` succeeds with no warnings about deprecated peer deps
- [ ] `docker compose up -d` starts Redis, MinIO, Mailpit (Postgres is NOT in compose — DB is Supabase)
- [ ] `npm run dev` boots Next.js on http://localhost:3000 with no errors
- [ ] http://localhost:3000 shows a branded landing page (logo + tagline)
- [ ] http://localhost:3000/api/health returns `{ status: "ok", db: "connected", redis: "connected" }`
- [ ] `npm run workers` starts a worker process that registers with Redis and logs "Worker ready"
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` all pass
- [ ] Push to `main` triggers Vercel deploy; deployed URL passes the same `/api/health` check
- [ ] CI (GitHub Actions) runs lint + typecheck + test on every PR

---

## 3. Explicitly Out of Scope

Do not build any of these in Story 1. They belong to later stories.

- ❌ User signup / login / sessions (Story 2)
- ❌ Event creation form (Story 3)
- ❌ Stripe integration (Story 4)
- ❌ Contributor form (Story 5)
- ❌ File uploads (Story 6)
- ❌ Admin dashboard (Story 7)
- ❌ Any AI integration (Stories 9–11, 16)
- ❌ Any actual BullMQ jobs (worker starts and stays idle — Story 9 adds the first real job)
- ❌ Email templates beyond a single test email (Story 2+)
- ❌ Most of the Prisma schema — only `User` model in Story 1, rest added per story

This story is foundation work. It should feel underwhelming to use; that's correct.

---

## 4. Prerequisites

Before starting:

- [ ] `docs/development-setup.md` §2 Phase A accounts created (Supabase, Anthropic, OpenAI, Stripe, Resend) — only Supabase strictly needed for Story 1
- [ ] Supabase databases created: `swara_dev`, `swara_test`, `swara_prd` (§4 of dev-setup)
- [ ] Node.js 20+ installed
- [ ] Docker Desktop installed and running
- [ ] GitHub repo created (empty)
- [ ] Vercel account created and linked to the GitHub repo

---

## 5. Repository Structure (target end-of-story)

```
swara-magical/
├── .github/
│   └── workflows/
│       └── ci.yml                 # lint + typecheck + test on PRs
├── .claude/
│   └── settings.json              # (optional) MCP config — see dev-setup §9
├── docs/                          # already exists
├── prisma/
│   ├── schema.prisma              # only User model in Story 1
│   └── migrations/
│       └── <timestamp>_init/
├── public/
│   └── favicon.svg                # placeholder; branding.md §6
├── src/
│   ├── app/                       # Next.js App Router
│   │   ├── layout.tsx             # root layout with brand colors/fonts
│   │   ├── page.tsx               # landing page
│   │   ├── globals.css            # Tailwind + brand tokens from branding.md
│   │   └── api/
│   │       └── health/
│   │           └── route.ts       # GET /api/health
│   ├── config/
│   │   ├── index.ts               # Zod-validated config object (single source of truth)
│   │   └── env.ts                 # raw env reads — ONLY file outside config/ that touches process.env
│   ├── lib/
│   │   ├── db.ts                  # Prisma client (singleton)
│   │   ├── redis.ts               # Redis client (singleton)
│   │   └── logger.ts              # structured logger
│   └── workers/
│       └── index.ts               # worker entry point; idle in Story 1
├── tests/
│   ├── unit/
│   │   └── config.test.ts         # config module validates env
│   └── integration/
│       └── health.test.ts         # GET /api/health returns ok
├── .env.example                   # from dev-setup §7
├── .env.test                      # gitignored; created from .env.example
├── .gitignore
├── docker-compose.yml             # from dev-setup §3 (no postgres)
├── eslint.config.js
├── next.config.ts
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── vitest.config.ts
```

---

## 6. Implementation Steps

Work in this order. Commit after each numbered step so PR diff stays readable.

### Step 1 — Initialize Next.js + TypeScript + Tailwind

```bash
npx create-next-app@latest swara-magical --typescript --tailwind --app --src-dir --no-eslint
cd swara-magical
```

Then add ESLint via flat config (better tooling than the legacy config Next ships):

```bash
npm install -D eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-config-next
```

Create `eslint.config.js`:

```js
import next from 'eslint-config-next';
export default [
  ...next(),
  {
    rules: {
      // No code outside src/config/ may read process.env directly
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Read env vars only in src/config/env.ts; import { config } from "@/config" elsewhere.',
        },
      ],
    },
  },
];
```

### Step 2 — Add Prisma + Supabase connection

```bash
npm install prisma @prisma/client
npx prisma init
```

Replace `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Story 1: only User model. Other models added per their owning story.
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  role      Role     @default(ORGANIZER)
  createdAt DateTime @default(now())
}

enum Role {
  ORGANIZER
  ADMIN
}
```

Set `DATABASE_URL` in `.env.development.local` to the Supabase `swara_dev` pooler URL.

Run migration:
```bash
npx prisma migrate dev --name init
```

### Step 3 — Build the config module

Create `src/config/env.ts` — the **only** file allowed to touch `process.env`:

```ts
/* eslint-disable no-restricted-syntax */
// This file is the single source of raw env reads.
export const rawEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  // ... add the rest as stories need them, but keep this file small
};
```

Create `src/config/index.ts`:

```ts
import { z } from 'zod';
import { rawEnv } from './env';

const ConfigSchema = z.object({
  env: z.enum(['development', 'test', 'production']),
  database: z.object({ url: z.string().url() }),
  redis: z.object({ url: z.string().url() }),
  app: z.object({ publicUrl: z.string().url() }),
});

export const config = ConfigSchema.parse({
  env: rawEnv.NODE_ENV ?? 'development',
  database: { url: rawEnv.DATABASE_URL },
  redis: { url: rawEnv.REDIS_URL },
  app: { publicUrl: rawEnv.NEXT_PUBLIC_APP_URL },
});

export type Config = z.infer<typeof ConfigSchema>;
```

Install Zod: `npm install zod`.

### Step 4 — DB and Redis clients

`src/lib/db.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { config } from '@/config';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({ datasources: { db: { url: config.database.url } } });

if (config.env !== 'production') globalForPrisma.prisma = db;
```

`src/lib/redis.ts`:

```ts
import IORedis from 'ioredis';
import { config } from '@/config';

const globalForRedis = globalThis as unknown as { redis?: IORedis };

export const redis = globalForRedis.redis ?? new IORedis(config.redis.url, { maxRetriesPerRequest: null });

if (config.env !== 'production') globalForRedis.redis = redis;
```

Install: `npm install ioredis`.

### Step 5 — Logger

`src/lib/logger.ts`:

```ts
import pino from 'pino';
import { config } from '@/config';

export const logger = pino({
  level: config.env === 'production' ? 'info' : 'debug',
  transport: config.env === 'development' ? { target: 'pino-pretty' } : undefined,
});
```

Install: `npm install pino pino-pretty`.

### Step 6 — Health endpoint

`src/app/api/health/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { redis } from '@/lib/redis';

export async function GET() {
  const checks = await Promise.allSettled([
    db.$queryRaw`SELECT 1`,
    redis.ping(),
  ]);
  return NextResponse.json({
    status: checks.every(c => c.status === 'fulfilled') ? 'ok' : 'degraded',
    db: checks[0].status === 'fulfilled' ? 'connected' : 'down',
    redis: checks[1].status === 'fulfilled' ? 'connected' : 'down',
  });
}
```

### Step 7 — Landing page with brand styling

Apply brand tokens from `docs/branding.md` §4. Update `src/app/globals.css` to define CSS variables for the palette and load Fraunces + Inter from Google Fonts. Replace `src/app/page.tsx` with a minimal landing page:

```tsx
export default function Home() {
  return (
    <main className="min-h-screen bg-brand-ivory flex items-center justify-center px-6">
      <div className="text-center">
        <h1 className="font-display text-5xl text-brand-deep-saffron font-semibold">
          Swara
        </h1>
        <p className="font-display text-2xl text-brand-ink mt-2 font-light">
          Magical Memories
        </p>
        <p className="font-body text-sm text-brand-ink/60 mt-8">
          Every wish, every memory, one magical moment.
        </p>
        <p className="font-body text-xs text-brand-ink/40 mt-12">
          by Swara Media
        </p>
      </div>
    </main>
  );
}
```

### Step 8 — Worker entry point (idle)

`src/workers/index.ts`:

```ts
import { redis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { config } from '@/config';

async function main() {
  // Touch Redis so failure is visible at boot
  await redis.ping();
  logger.info({ env: config.env }, 'Worker ready (no queues registered yet)');
  // Stay alive; future stories register BullMQ workers here
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker boot failed');
  process.exit(1);
});
```

Add npm script: `"workers": "tsx src/workers/index.ts"`. Install: `npm install -D tsx`.

### Step 9 — Tests

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
  },
});
```

`tests/unit/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('config', () => {
  it('parses env successfully when DATABASE_URL is set', async () => {
    process.env.DATABASE_URL = 'postgresql://test';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    const { config } = await import('@/config');
    expect(config.database.url).toBe('postgresql://test');
  });
});
```

`tests/integration/health.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  it('returns ok when db and redis are reachable', async () => {
    const response = await GET();
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
    expect(body.redis).toBe('connected');
  });
});
```

Install: `npm install -D vitest vite-tsconfig-paths`.

### Step 10 — CI

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
    env:
      DATABASE_URL: ${{ secrets.SUPABASE_TEST_URL }}
      REDIS_URL: redis://localhost:6379
      NEXT_PUBLIC_APP_URL: http://localhost:3000
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
```

Add GitHub repo secret `SUPABASE_TEST_URL` pointing at the `swara_test` Supabase database.

### Step 11 — Deploy to Vercel

- Connect the GitHub repo to Vercel.
- Set env vars in Vercel project settings:
  - `DATABASE_URL` → Supabase `swara_prd` pooler URL
  - `REDIS_URL` → leave a placeholder for now (`redis://localhost:6379`) or use a free Upstash instance early
  - `NEXT_PUBLIC_APP_URL` → the Vercel-assigned URL
- Push to `main` → confirm deploy succeeds → hit `/api/health` on the deployed URL.

**Workers do not deploy to Vercel.** Worker hosting (Railway/Fly) is set up in Story 9 when the first real job exists. For Story 1, workers are only run locally.

### Step 12 — README

Minimal README pointing at `docs/`:

```md
# Swara Magical Memories

AI-assisted tribute video platform. By Swara Media.

## Documentation
- `docs/requirements.md` — product requirements
- `docs/architecture.md` — system design
- `docs/development-setup.md` — how to run locally
- `docs/stories.md` — incremental delivery plan
- `docs/branding.md` — visual + voice brand reference

## Quick start
See `docs/development-setup.md` §8.
```

---

## 7. Package Scripts

`package.json` scripts section after Story 1:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "workers": "tsx src/workers/index.ts",
    "lint": "eslint src tests",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "prisma:migrate": "prisma migrate dev",
    "prisma:studio": "prisma studio"
  }
}
```

---

## 8. Testing Strategy for This Story

| Test | Layer | Why |
|---|---|---|
| Config parses required env vars | Unit | Catches misconfiguration at boot, not at runtime |
| Health endpoint returns ok | Integration | Proves DB + Redis connectivity end-to-end |
| Lint rule blocks `process.env` outside config | Lint config | Enforces the single-source-of-truth rule for future stories |

No E2E browser tests yet — nothing user-facing to test beyond the landing page render, which the type system covers.

---

## 9. Definition of Done

Story 1 is **done** only when ALL of these are true:

- [ ] All success criteria in §2 pass locally
- [ ] All CI checks green on the PR
- [ ] PR merged to `main`
- [ ] Vercel auto-deploy succeeds
- [ ] `/api/health` on the deployed URL returns 200 with db + redis = connected
- [ ] `docs/stories.md` Story 1 row updated with a ✅ and the deployed URL
- [ ] No TODO comments left in committed code (planned future work belongs in the story plan, not in comments)

---

## 10. What Unlocks After This

Story 1 done enables:
- **Story 2** (Organizer auth) — needs the User model, NextAuth setup, deployable app
- All subsequent stories — every later story assumes the config module, db/redis clients, worker process, and CI pipeline exist

We will write `story-02-organizer-auth.md` once Story 1 is merged and you've confirmed the foundation feels right. Adjust this plan as needed based on what we learn from Story 1.

---

## 11. Known Risks / Watch For

| Risk | Mitigation |
|---|---|
| Supabase pooler URL format differs from direct URL | Use the **transaction pooler** URL (port 6543) for the app; direct URL only for `prisma migrate dev` |
| Prisma + Supabase pooler quirk: prepared statements | Set `?pgbouncer=true&connection_limit=1` on the pooler URL; documented in Prisma + Supabase docs |
| Vercel can't reach localhost Redis | For Story 1, leave Redis check in `/api/health` allowed to fail in production — or sign up for free Upstash now and use it for `swara_prd`. The health endpoint reports `degraded` rather than crashing, so this is safe. |
| ESLint flat config + Next.js compatibility | If `eslint-config-next` doesn't ship a flat-config export when Story 1 starts, fall back to legacy `.eslintrc.json` — the env-var lint rule still works |
