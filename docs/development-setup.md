# Development Setup: Swara Magical Memories

Everything needed to run the app on localhost from day one. Production-equivalent infrastructure runs in Docker; only the external AI/payment APIs require real accounts (and even those have free/sandbox tiers sufficient for development).

---

## 1. Principles

1. **Localhost-first.** Every component runs locally. No cloud services required to build, test, or iterate.
2. **Production parity in storage.** We use S3-compatible local storage (MinIO), Postgres, and Redis locally so dev mirrors prod.
3. **Mock the expensive, real the cheap.** Use real Stripe test mode and real Anthropic API (cheap with Sonnet); mock Whisper for unit tests but real for integration tests.
4. **One command to start.** `docker compose up` + `npm run dev` should be enough.

---

## 2. External Services — Accounts to Create

Two phases. Both lists belong to MVP 1 — the only difference is when you need each account.

### Phase A — Required Day One (for local development to work end-to-end)

| Service | Used For | Free Tier? | Action |
|---|---|---|---|
| **Supabase** | Postgres for ALL environments (dev, test, prod) | Free tier covers dev easily | Create one project; create three databases: `swara_dev`, `swara_test`, `swara_prd` (see §4) |
| **Anthropic Console** | Claude API (Sonnet 4.6 + Opus 4.7) | Pay-as-you-go from $0 | Create account → get API key → set spend limit ($50/mo for dev) |
| **OpenAI Platform** | Whisper transcription | Pay-as-you-go from $0 | Create account → get API key → set spend limit ($20/mo for dev) |
| **Stripe** | Payments (test mode) + webhooks | Free in test mode forever | Create account → use test mode keys → install Stripe CLI |
| **Resend** | Transactional email | 100/day free, 3000/mo free | Create account → verify a sending domain (use a real one you own) → get API key. **Local dev still uses Mailpit by default; Resend account is created now so domain DNS verification can start (DNS propagation can take 24–48h).** |

**Minimum to start dev today: these five accounts.** All free to create.

**Why Supabase even for localhost:** production parity is more valuable than the speed of a local Postgres. The same connection driver, the same SQL dialect, the same Row Level Security model run in dev and prod. We avoid the class of bugs where "it worked in local Postgres but failed in Supabase." Cost is zero — Supabase free tier handles dev traffic comfortably.

### Phase B — Required Before MVP 1 Production Launch (still MVP 1 scope)

These are MVP 1 — they just don't run on localhost. Sign up when you're 1–2 weeks from launching to give yourself buffer for DNS, billing setup, and free-tier limits.

| Service | Used For | Free Tier? | Why it's MVP 1 |
|---|---|---|---|
| **Cloudflare R2** | Object storage in prod (replaces MinIO) | 10GB storage + zero egress free | MVP 1 stores all submissions and final videos in prod object storage |
| **Upstash Redis** | BullMQ queue backend in prod (replaces local Redis) | 10k commands/day free | MVP 1 prod queue infrastructure |
| **Vercel** | Web app hosting (Next.js) | Free Hobby tier | MVP 1 prod web hosting |
| **Railway** or **Fly.io** | Worker + encoder hosting (long-running Node processes) | Free dev credits + low cost | MVP 1 prod worker hosting; Vercel can't run long-running jobs |
| **Domain registrar** | Production domain (e.g., swaramagical.com) | $10–20/year | MVP 1 prod URL |
| **Stripe** live mode | Real payments in prod | Free (only fees on transactions) | Switch from test mode keys to live mode keys at launch |

### Phase C — Genuinely Deferred to MVP 2+

These are NOT needed for MVP 1 at all — neither dev nor prod.

| Service | Why deferred |
|---|---|
| **WhatsApp Business API / Meta Cloud API** | MVP 1 uses `wa.me` click-to-share URLs (browser-side, no API). MVP 2 adds API send for reminders. |
| **Twilio** | Not used at all — Meta direct is cheaper for WhatsApp in MVP 2. |
| **Stripe Connect** | Editors paid offline by Swara Magical; in-app editor billing is permanently out of scope. |
| **Self-hosted Whisper** | Whisper API is sufficient for MVP 1 volumes. Revisit only if API costs become a real line item. |

### Total Account Sign-up Map

```
Day 1 of dev:           Anthropic, OpenAI, Stripe (test), Resend
                              ↓ (build for 4–8 weeks)
1–2 weeks before launch: Cloudflare R2, Neon/Supabase, Upstash, Vercel,
                          Railway/Fly, domain registrar
                              ↓
At launch:               Flip Stripe to live mode
                              ↓ (post-launch)
MVP 2:                    WhatsApp Business API
```

---

## 3. Local Infrastructure — Docker Compose

Database lives in Supabase (see §4). The Docker stack runs only the services that benefit from being fully local (zero latency, no quota, fast restart).

Create `docker-compose.yml` at repo root:

```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

  minio:
    # S3-compatible local object storage
    image: minio/minio:latest
    ports:
      - "9000:9000"    # S3 API
      - "9001:9001"    # MinIO console
    environment:
      MINIO_ROOT_USER: swara
      MINIO_ROOT_PASSWORD: swara_dev_secret
    command: server /data --console-address ":9001"
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s

  minio-init:
    # Create the bucket on first start
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      sh -c "
      mc alias set local http://minio:9000 swara swara_dev_secret &&
      mc mb --ignore-existing local/swara-magical &&
      mc anonymous set none local/swara-magical
      "

  mailpit:
    # Catches all outbound SMTP for local dev; web UI to view emails
    image: axllent/mailpit:latest
    ports:
      - "1025:1025"    # SMTP
      - "8025:8025"    # Web UI

volumes:
  miniodata:
```

**What this gives you:**
- `localhost:6379` — Redis (BullMQ queues).
- `localhost:9000` — MinIO S3 API (same protocol as R2/S3).
- `localhost:9001` — MinIO web console (browse uploads).
- `localhost:1025` — SMTP server (Mailpit catches outbound email in dev).
- `localhost:8025` — Mailpit web UI (view emails sent during dev).

**Database is NOT in this stack** — it lives in Supabase. See §4.

**Start it all:** `docker compose up -d`

**Tear down:** `docker compose down` (preserves data) or `docker compose down -v` (wipes data).

---

## 4. Database — Supabase Across All Environments

Single Supabase project hosts all three environments as separate databases. Connection strings differ only in the database name.

### Naming convention

| Environment | Database name | Connection string env var |
|---|---|---|
| Local development | `swara_dev` | `DATABASE_URL` in `.env.development.local` |
| Automated tests | `swara_test` | `DATABASE_URL` in `.env.test` |
| Production | `swara_prd` | `DATABASE_URL` in production env (Vercel + workers) |

### One-time Supabase setup

1. Create a Supabase project (region closest to your team for dev latency).
2. In the SQL editor, create the three databases:
   ```sql
   CREATE DATABASE swara_dev;
   CREATE DATABASE swara_test;
   CREATE DATABASE swara_prd;
   ```
3. Copy the connection pooler URL from Supabase (Settings → Database → Connection pooling). Substitute `swara_dev` / `swara_test` / `swara_prd` for the database name when setting each env's `DATABASE_URL`.

   ```
   postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/swara_dev
   ```

4. Run Prisma migrations against each:
   ```bash
   DATABASE_URL="...swara_dev" npx prisma migrate dev
   DATABASE_URL="...swara_test" npx prisma migrate deploy
   # swara_prd migrated at deploy time, not from a dev machine
   ```

### Test database isolation

`swara_test` is wiped and re-seeded by Vitest's `globalSetup` before each test run. Never share data with `swara_dev`. Never run tests against `swara_prd`.

---

## 4. AI Services in Dev — Strategy

### Anthropic (Claude)

Use the real API in dev with deliberate cost controls:

- **Default to Sonnet 4.6** for everything during day-to-day dev. ~$0.003 per 1k input tokens — pennies per test event.
- **Disable Opus 4.7 in dev by default.** Set `OPUS_MODEL=claude-sonnet-4-6` in `.env.development.local`. Opt-in to real Opus only when testing storyboard quality (`OPUS_MODEL=claude-opus-4-7`).
- **Spending limit:** $50/mo cap in Anthropic Console.
- **Prompt caching ON** even in dev — same cost behavior as prod.

### OpenAI Whisper

- Real API in dev for integration tests (cheap: ~$0.006/min).
- **Unit tests use a mock.** Create `__mocks__/openai.ts` that returns canned transcripts for known fixture audio files.
- $20/mo cap.

### Mocking switch

Add a single `NODE_ENV=test` or `AI_MOCK_MODE=true` flag that routes all AI calls through deterministic mocks. Use for CI and rapid unit testing.

```typescript
// /services/ai.ts
const aiClient = process.env.AI_MOCK_MODE === 'true'
  ? new MockAiClient()   // returns canned outputs
  : new AnthropicClient();
```

---

## 5. Stripe — Local Webhook Testing

The Stripe webhook is critical (event activation depends on it). Test it locally with the Stripe CLI:

```bash
# Install (one-time)
# macOS:    brew install stripe/stripe-cli/stripe
# Windows:  scoop install stripe
# Linux:    https://docs.stripe.com/stripe-cli

stripe login

# Forward webhooks to local app
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

The CLI prints a webhook signing secret. Put it in `.env.development.local` as `STRIPE_WEBHOOK_SECRET`.

**Trigger a test payment:**
```bash
stripe trigger checkout.session.completed
```

This fires a realistic webhook payload at your local server. Use Stripe's test card `4242 4242 4242 4242` for end-to-end checkout flow testing.

---

## 6. WhatsApp in MVP 1 — No Configuration Needed

MVP 1 generates `wa.me` URLs in the browser:

```typescript
const message = encodeURIComponent(
  `You're invited to contribute to ${event.honoreeName}'s tribute video! ${eventUrl}`
);
const whatsappLink = `https://wa.me/?text=${message}`;
```

No API key, no opt-in flow, no Meta account, no template approval. The organizer clicks the link → WhatsApp opens with the message pre-filled → they choose who to send it to.

MVP 2 adds the WhatsApp Business API behind the `Channel` interface (see architecture.md §18). Configuration deferred until then.

---

## 7. Environment Configuration

**Single source of truth principle:** No file outside `src/config/` reads `process.env` directly. All environment values flow through one typed config object. Changing where the database lives is a one-line change in `src/config/index.ts`, not a grep-and-replace across the codebase.

### The config module (`src/config/index.ts`)

```typescript
import { z } from 'zod';

const ConfigSchema = z.object({
  env: z.enum(['development', 'test', 'production']),

  database: z.object({
    url: z.string().url(),
  }),

  storage: z.object({
    endpoint: z.string().url(),     // MinIO in dev, R2 in prod
    bucket: z.string(),
    region: z.string(),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
    forcePathStyle: z.boolean(),    // true for MinIO, false for R2
  }),

  redis: z.object({ url: z.string().url() }),

  auth: z.object({
    secret: z.string().min(32),
    url: z.string().url(),
    adminEmailDomains: z.array(z.string()),
  }),

  stripe: z.object({
    secretKey: z.string(),
    publishableKey: z.string(),
    webhookSecret: z.string(),
  }),

  ai: z.object({
    anthropicApiKey: z.string(),
    openaiApiKey: z.string(),
    sonnetModel: z.string(),
    opusModel: z.string(),
    whisperModel: z.string(),
    mockMode: z.boolean(),
  }),

  email: z.object({
    smtpHost: z.string(),
    smtpPort: z.number(),
    fromAddress: z.string(),
    resendApiKey: z.string().optional(),
  }),

  editor: z.object({
    tokenSecret: z.string().min(64),
  }),

  app: z.object({
    publicUrl: z.string().url(),
    shareDomain: z.string().url(),
  }),
});

export const config = ConfigSchema.parse({
  env: process.env.NODE_ENV,
  database: { url: process.env.DATABASE_URL },
  storage: {
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  },
  redis: { url: process.env.REDIS_URL },
  auth: {
    secret: process.env.NEXTAUTH_SECRET,
    url: process.env.NEXTAUTH_URL,
    adminEmailDomains: (process.env.ADMIN_EMAIL_DOMAINS ?? '').split(','),
  },
  // ... rest mapped the same way
});

export type Config = z.infer<typeof ConfigSchema>;
```

**The config is parsed at boot.** If any required env var is missing or malformed, the app fails to start with a clear Zod error — no silent runtime failures.

**Everywhere else in the app:**

```typescript
import { config } from '@/config';

const db = new PrismaClient({ datasources: { db: { url: config.database.url } } });
const s3 = new S3Client({ endpoint: config.storage.endpoint, ... });
```

No `process.env.DATABASE_URL` outside `src/config/`. Lint rule enforces this.

### Env files (loaded by Next.js + dotenv-cli for workers)

| File | Purpose | Committed? |
|---|---|---|
| `.env.example` | Documents every variable; placeholder values | ✓ committed |
| `.env.development.local` | Real values for local dev (Supabase `swara_dev`, Stripe test, etc.) | ✗ gitignored |
| `.env.test` | Test values (Supabase `swara_test`, AI mock mode) | ✗ gitignored |
| Vercel/Railway env vars | Production values (Supabase `swara_prd`, Stripe live) | (in hosting platform UI) |

### `.env.example` (committed to repo)

```bash
# === Environment ===
NODE_ENV=development

# === Database (Supabase, across all environments) ===
# Dev:  postgresql://...@...supabase.com:6543/swara_dev
# Test: postgresql://...@...supabase.com:6543/swara_test
# Prod: postgresql://...@...supabase.com:6543/swara_prd
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/swara_dev

# === Object Storage (MinIO locally, R2 in prod) ===
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=swara-magical
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=swara
S3_SECRET_ACCESS_KEY=swara_dev_secret
S3_FORCE_PATH_STYLE=true     # true for MinIO, false for R2/S3

# === Redis / BullMQ (local Docker in dev, Upstash in prod) ===
REDIS_URL=redis://localhost:6379

# === Auth ===
NEXTAUTH_SECRET=__generate_with_openssl_rand_base64_32__
NEXTAUTH_URL=http://localhost:3000
ADMIN_EMAIL_DOMAINS=swaramagical.com,yourdomain.com

# === Stripe (test mode in dev, live mode in prod) ===
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...   # from `stripe listen`

# === AI ===
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
SONNET_MODEL=claude-sonnet-4-6
OPUS_MODEL=claude-sonnet-4-6      # downgrade in dev; use claude-opus-4-7 only when testing storyboard quality
WHISPER_MODEL=whisper-1
AI_MOCK_MODE=false                # set true for offline / CI

# === Email ===
# Dev: Mailpit (no real sends); Prod: Resend
SMTP_HOST=localhost
SMTP_PORT=1025
RESEND_API_KEY=                   # leave blank in dev; required in prod
RESEND_FROM_ADDRESS=hello@swaramagical.com

# === Editor tokens ===
EDITOR_TOKEN_SECRET=__generate_with_openssl_rand_base64_64__

# === App ===
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SHARE_DOMAIN=http://localhost:3000
```

### `.env.development.local`

Copy `.env.example` → fill in real keys. Set `DATABASE_URL` to the `swara_dev` Supabase URL.

### `.env.test`

```bash
NODE_ENV=test
DATABASE_URL=postgresql://...@...supabase.com:6543/swara_test
AI_MOCK_MODE=true
S3_BUCKET=swara-magical-test
```

---

## 8. First-Run Checklist

```bash
# 1. Clone + install
git clone <repo>
cd swara-magical
npm install

# 2. Create Supabase databases (one-time, see §4)
#    In Supabase SQL editor, create swara_dev, swara_test, swara_prd

# 3. Start local infra (Redis, MinIO, Mailpit)
docker compose up -d

# 4. Set up environment
cp .env.example .env.development.local
# Fill in:
#   - DATABASE_URL: Supabase pooler URL with /swara_dev
#   - ANTHROPIC_API_KEY, OPENAI_API_KEY, Stripe test keys
#   - Generate NEXTAUTH_SECRET and EDITOR_TOKEN_SECRET

# 5. Run Prisma migrations against swara_dev
npx prisma migrate dev

# 6. Seed dev data (admin user, sample event, fake submissions)
npm run seed

# 7. Start app
npm run dev               # Next.js on :3000

# 8. Start workers (separate terminal)
npm run workers           # AI pipeline + encoder workers

# 9. Stripe webhook forwarding (separate terminal)
stripe listen --forward-to localhost:3000/api/stripe/webhook

# 10. Smoke test
# Visit http://localhost:3000
# Create event, pay with 4242 4242 4242 4242
# Submit a contribution from incognito window
# Watch pipeline run in worker terminal
# Inspect data in Supabase Studio (Table Editor)
# View transcoded files in MinIO console (http://localhost:9001)
# View emails in Mailpit (http://localhost:8025)
```

**You should be able to run this flow on your laptop with only Supabase + 4 API keys (Anthropic, OpenAI, Stripe test, Resend) as external dependencies.**

---

## 9. Claude Code MCPs — Composio Is Already Wired

**Composio MCP is already configured** in this Claude Code workspace. It bundles connections to Stripe, GitHub, Vercel, and Resend, so Claude can perform real operations against those services during development without separate MCP server installs.

### What Composio gives Claude (dev-time, not runtime)

| Service | What Claude can do via Composio |
|---|---|
| **Stripe** | Inspect products/prices, list test customers/events, trigger test webhooks, verify webhook payloads land correctly |
| **GitHub** | Open PRs, read/comment on issues, inspect commit history, run `gh` operations |
| **Vercel** | List deployments, check build logs, inspect env var configuration, trigger redeploys |
| **Resend** | Inspect email logs, check delivery status, verify domain DNS records |

### How Composio is invoked

The Composio MCP exposes a unified tool surface:

- `COMPOSIO_GET_TOOL_SCHEMAS` — discover available actions for a connected service
- `COMPOSIO_MANAGE_CONNECTIONS` — view/refresh the connections
- `COMPOSIO_MULTI_EXECUTE_TOOL` — execute one or more actions
- `COMPOSIO_REMOTE_BASH_TOOL` / `COMPOSIO_REMOTE_WORKBENCH` — sandboxed execution

Claude reaches for these tools when a task naturally calls for them (e.g., "create the Stripe product for the MVP 1 package" → Claude uses Composio to call Stripe directly rather than asking the user to do it manually).

### What this means for the dev workflow

- **No separate MCP server installs needed** for Stripe / GitHub / Vercel / Resend. Composio covers all four.
- **Real API keys still live in `.env.development.local`** for the *running app* — Composio is a Claude tool, not a runtime SDK replacement. The app itself still imports `stripe`, `resend`, etc. directly.
- **For Postgres/database access during dev**, the codebase's Prisma client is the path. If you want Claude to inspect the dev DB directly without going through application code, add the standalone Postgres MCP server pointed at the `swara_dev` Supabase connection string.

### Optional: additional MCP servers beyond Composio

| MCP Server | When to add it |
|---|---|
| **postgres** (standalone) | If you want Claude to run ad-hoc SQL against `swara_dev` to debug data shape |
| **playwright** | If you want Claude to drive a browser for UI E2E debugging |

Add to `~/.claude/settings.json` or `.claude/settings.json`:

```json
{
  "mcpServers": {
    "postgres-dev": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres",
               "postgresql://...@...supabase.com:6543/swara_dev"]
    }
  }
}
```

### Safety rules for Composio in dev

- **Never connect Composio to `swara_prd`.** The Postgres MCP, if added, must point at `swara_dev` only.
- **Stripe operations via Composio must be test-mode-only** in dev. If Claude is asked to do anything with Stripe live mode, refuse and surface to user.
- **Vercel operations via Composio should be read-only by default** (list deployments, check logs). Triggering deploys is an explicit user request, not a side effect of other work.
- **Resend reads only in dev.** Local dev sends through Mailpit; we don't generate real outbound email traffic from a dev machine.

---

## 10. MVP 1 Production Launch Checklist

When the app is feature-complete and ready to ship for graduation season. Allow **1–2 weeks of buffer** for DNS propagation, billing setup, and Stripe live-mode review.

### Infrastructure setup

- [ ] Register production domain (swaramagical.com or chosen name)
- [ ] **Cloudflare R2:** create bucket `swara-magical-prod`; create API token scoped to that bucket; set up custom domain for CDN delivery (e.g., `media.swaramagical.com`)
- [ ] **Supabase `swara_prd` database:** already exists from §4; run `DATABASE_URL=...swara_prd npx prisma migrate deploy` from a controlled environment; consider upgrading Supabase project tier if production volume exceeds free
- [ ] **Upstash:** create prod Redis instance; note connection string
- [ ] **Vercel:** create project; link to repo; configure all env vars from §7; set production branch
- [ ] **Railway or Fly.io:** create two services — `workers` (AI pipeline) and `encoder` (FFmpeg); deploy from same repo with different start commands; configure env vars and autoscaling on queue depth

### External account upgrades

- [ ] **Stripe:** complete business verification; switch from test to live mode; create the MVP 1 single product/price; set live webhook endpoint to `https://swaramagical.com/api/stripe/webhook`
- [ ] **Resend:** verify production sending domain (SPF, DKIM, DMARC records on the domain); test deliverability
- [ ] **Anthropic / OpenAI:** raise monthly spend limits to expected production levels; ensure billing is on file

### Application configuration

- [ ] Generate fresh `NEXTAUTH_SECRET` and `EDITOR_TOKEN_SECRET` for prod (never reuse dev secrets)
- [ ] Set `OPUS_MODEL=claude-opus-4-7` in prod (was downgraded in dev)
- [ ] Set `AI_MOCK_MODE=false`
- [ ] Confirm `ADMIN_EMAIL_DOMAINS` includes the real admin team's domain
- [ ] Confirm `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SHARE_DOMAIN` use the production domain

### Operational readiness

- [ ] Postgres backups enabled (Neon/Supabase have this on by default; verify schedule)
- [ ] R2 versioning enabled on `final/` and `submissions/` prefixes
- [ ] Honeycomb/Axiom workspace created; OTel exporter configured
- [ ] Alert routing set up for the critical alerts in architecture.md §13 (Stripe webhook failures, sustained AI 5xx, near-miss delivery dates, honoree-email suppression)
- [ ] Seed first admin user in prod DB (Google OAuth + manual role flip)
- [ ] Run one full event end-to-end in production with a friendly test user before announcing launch

### Pre-launch smoke test

- [ ] Create real event with $0.50 test payment in Stripe live mode
- [ ] Submit from 2–3 contributors
- [ ] Verify pipeline runs in prod workers (check Honeycomb traces)
- [ ] Verify approval gate appears in admin dashboard
- [ ] Approve AI routing → verify final video generated
- [ ] Verify delivery email arrives to organizer
- [ ] Verify share page loads and video plays
- [ ] Refund the test payment in Stripe

---

## 11. Test Strategy — Localhost from Day One

| Test Layer | Tools | Runs On |
|---|---|---|
| Unit | Vitest | Pure JS, no infra needed |
| Integration | Vitest + Docker Compose | Real Postgres, Redis, MinIO; mocked AI APIs |
| End-to-end | Playwright | Full stack on localhost; Stripe CLI + test cards; real Anthropic Sonnet (cheap) |
| Manual smoke | Browser | The flow in §8 |

**Pre-merge CI** runs unit + integration with `AI_MOCK_MODE=true`. E2E runs nightly with real (capped) AI.

---

## 12. Service Dependency Status — At-a-Glance

All MVP 1 services in one table. "Local Dev" and "MVP 1 Prod" are both MVP 1 — different environments.

| Service | Local Dev | MVP 1 Prod | MVP 2+ | Local Implementation | Prod Implementation |
|---|---|---|---|---|---|
| Postgres | ✓ | ✓ | — | Supabase `swara_dev` | Supabase `swara_prd` |
| Redis | ✓ | ✓ | — | Docker (redis:7) | Upstash |
| Object Storage | ✓ | ✓ | — | MinIO (Docker) | Cloudflare R2 |
| SMTP / Email | ✓ | ✓ | — | Mailpit (Docker) | Resend (live mode) |
| Web Hosting | ✓ | ✓ | — | `npm run dev` | Vercel |
| Worker Hosting | ✓ | ✓ | — | `npm run workers` | Railway or Fly.io |
| Anthropic Claude | ✓ | ✓ | — | Real API, Sonnet only | Real API, Sonnet + Opus |
| OpenAI Whisper | ✓ | ✓ | — | Real API or mocked | Real API |
| Stripe | ✓ | ✓ | — | Test mode + CLI | Live mode + webhook on prod URL |
| Domain + DNS | — | ✓ | — | localhost:3000 | swaramagical.com (registrar TBD) |
| WhatsApp Send API | — | — | ✓ | `wa.me` URLs only | `wa.me` URLs only | Meta Cloud API |
| Twilio | — | — | — | — | — | Not used (Meta direct) |
| Stripe Connect | — | — | — | — | — | Editors paid offline; out of scope |

### Cost Summary

| Phase | Monthly Cost |
|---|---|
| Local dev only | ~$5–10 (Anthropic + OpenAI usage) |
| MVP 1 prod launch (low traffic) | ~$15–30 (mostly free tiers + AI API usage) |
| MVP 1 prod at meaningful volume | ~$50–150 (AI dominates; storage/compute small) |

Hosting (Vercel/Railway/Neon/Upstash/R2) all have free tiers that cover early MVP 1 traffic. AI API usage is the dominant cost line.
