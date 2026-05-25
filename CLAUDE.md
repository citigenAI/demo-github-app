# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Swara Magical Memories** — an AI-assisted tribute-video platform (by Swara Media). Organizers create an event, contributors upload any mix of video/voice/photo/text, an AI pipeline analyzes submissions, and an admin routes each event to either an automated AI render or a human editor before delivering a final video.

The repo is built **incrementally as 20 deployable stories** (`docs/stories.md`). **Stories 1–5 are shipped:** foundation (landing page, `/api/health`, config/db/redis/logger libs), organizer auth (NextAuth email magic-link), event-creation wizard + My Events dashboard, Stripe checkout + webhook activation, and the public contributor text-submission form. The Prisma schema currently has `User`/`Account`/`Session`/`VerificationToken`, `Event`, `Package`, `Submission`, `AuditLog`, and `NotificationLog`. Everything beyond Story 5 (media uploads, AI pipeline, routing, delivery) is still *target* design — check the code before assuming a feature exists.

Read these for depth (don't duplicate them here):
- `docs/requirements.md` — product spec, roles, workflows, data model
- `docs/architecture.md` — system design, deployment, schema, AI tiers (load-bearing decisions)
- `docs/development-setup.md` — full local setup, external accounts, env vars
- `docs/stories.md` — the incremental delivery plan (the 20-story map + dependency graph)
- `docs/design/seqNN-storyNN-*.md` — **per-story design specs (read before implementing a story).** No-code, design-level specifications (exact field names, routes, contracts, validation, behavior) for stories 2–20, so a story can be built without re-deriving decisions. Story 1's original build guide is `docs/stories/story-01-foundation.md`.

## External Operations — Composio MCP (not CLI tools)

`gh` CLI, `vercel` CLI, and similar service CLIs are **not installed**. For all GitHub, Vercel, Supabase, and Resend operations use the **Composio MCP tools** (`mcp__claude_ai_composio__*`):

1. `COMPOSIO_SEARCH_TOOLS` — find the right tool slug for an operation
2. `COMPOSIO_MULTI_EXECUTE_TOOL` — run the tool, passing `account_id`
3. `COMPOSIO_MANAGE_CONNECTIONS` with `action: "list"` — refresh account IDs if stale

| Service | Access method | Default `account_id` / notes |
|---|---|---|
| GitHub | Composio | `github_molary-harem` (alias: swara-magical, user: swaramedia) |
| Vercel | Composio | `vercel_dyak-sleck` (alias: innovise-vercel) |
| Supabase | Composio | `supabase_lamel-recook` (alias: swara-magical, ref: kjzrjaaqendbdyelixkj) |
| Resend | Composio | `resend_yince-snick` (alias: innovise-resend2) |
| Stripe | Composio **+** dedicated `mcp__claude_ai_Stripe__*` tools | Composio: `stripe_ancone-exes`; prefer the dedicated Stripe MCP tools for Stripe ops |

`git push` to `swaramedia/*` authenticates via the system Git Credential Manager — use that for pushing branches. Use Composio/MCP for everything else (PRs, merges, Vercel deploys, Supabase API, Resend sends, Stripe setup).

**Stripe MCP note:** The `mcp__claude_ai_Stripe__*` tools (e.g. `stripe_api_execute`, `create_product`, `create_price`, `list_prices`) can manage Stripe resources directly. The app's runtime still needs `STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in `.env.development.local` — these cannot be retrieved via API and must be provided by the user.

## Commands

```bash
npm run dev          # Next.js dev server on :3000 (auto-loads .env.development.local)
npm run workers      # Worker process (idle until BullMQ queues land in Story 9)
npm run build        # Production build  — see env caveat below
npm run start        # Serve production build — see env caveat below
npm run lint         # ESLint (src + tests)
npm run typecheck    # tsc --noEmit
npm run test         # Vitest, single run
npm run test:watch   # Vitest, watch mode
npm run prisma:generate   # Regenerate Prisma client (also run after editing schema.prisma)
npm run prisma:migrate    # prisma migrate dev (uses DIRECT_URL)
npm run prisma:studio     # Browse the DB
npm run seed              # prisma/seed.ts — seeds the MVP1 Package (needed for event creation/checkout) + dev users & sample events (skipped when NODE_ENV=production)

# Run one test file / one test by name:
npx vitest run tests/unit/config.test.ts
npx vitest run -t "loads valid config"

# Local infra (Redis, MinIO, Mailpit) — needed for integration tests & the queue/storage stories:
docker compose up -d          # start;  add -v to `docker compose down -v` to wipe volumes
```

**Prisma client must be generated before `build`, `typecheck`, or `test`** (CI runs `npx prisma generate` first). The generated client is gitignored.

### Build/run env caveat (important, non-obvious)

`next dev` loads `.env.development.local`, but **`next build` and `next start` run in production mode and do NOT load it**. Because the config module validates env at import time (see below), `npm run build`/`npm run start` will throw `Invalid configuration` unless you supply the required vars yourself, e.g.:

```bash
DATABASE_URL='...' REDIS_URL='...' NEXT_PUBLIC_APP_URL='...' \
  NEXTAUTH_SECRET='<32+ chars>' NEXTAUTH_URL='...' RESEND_FROM_ADDRESS='...' npm run build
```

(The required set grows as stories add config — the authoritative list is whatever `src/config/index.ts` marks non-optional. Stripe keys are optional; the app degrades gracefully when they're absent.)

For ordinary local work prefer `npm run dev`.

## Architecture (big picture)

**Modular monolith, not microservices.** One Next.js 15 (App Router) deployable serves all three UIs (organizer, contributor, admin) and the API routes. Long-running work (AI pipeline, FFmpeg encoding, brief-ZIP assembly, notifications) runs in **separate worker processes** (`src/workers/`) because Vercel functions cap at ~60s. Contexts are enforced by folder boundaries + service interfaces, not network calls.

Target deployment topology (`architecture.md` §4): web/API → Vercel · workers + encoder → Railway/Fly · Postgres → Supabase · Redis/BullMQ → Upstash · object storage → Cloudflare R2. Locally these are Docker (Redis, MinIO, Mailpit) + Supabase.

Things worth knowing before you build a feature:
- **Async pipeline = BullMQ on Redis** (Story 9+). Today Redis is only pinged by `/api/health` and the idle worker — nothing depends on it functionally yet.
- **Two Claude tiers, deliberately:** Sonnet 4.6 per-submission (cheap, runs often), Opus 4.7 once per event for the storyboard. Don't collapse them.
- **Routing analyzer is deterministic rules + an admin approval gate** — the system never auto-routes AI vs Manual without human sign-off (`requirements.md` §5.6).
- **Surprise integrity is a hard constraint:** the honoree is an excluded actor — never wire `Event.honoreeEmail` to any notification; share pages are token-only + `noindex`. (`architecture.md` §10.)
- **Packages/features must be data-driven.** Check `package.features[]`; never branch on a tier name like `tier === 'premium'`. MVP 1 ships one package but the seam must stay open.

## Conventions (project-specific, enforced)

- **Never read `process.env` outside `src/config/env.ts`.** An ESLint `no-restricted-syntax` rule blocks it everywhere else. All code imports the typed, Zod-validated `config` from `@/config`. **Adding an env var means editing two files:** add the raw read in `src/config/env.ts` *and* the schema + mapping in `src/config/index.ts`.
- **Config is validated at boot.** Missing/malformed env fails fast with a clear Zod error rather than a silent runtime bug (this is the root of the build caveat above).
- **Import alias:** `@/*` → `src/*` (tsconfig + vite-tsconfig-paths for Vitest).
- **Prisma uses two URLs:** `DATABASE_URL` is the pooled connection for app runtime; `DIRECT_URL` is the direct connection for migrations. Environments are isolated by **Postgres schema** (`swara_dev`/`swara_test`/`swara_prd`) on a single Supabase project, not by separate databases, because the Supabase pooler only routes to the `postgres` database.
- **Schema grows per story.** `prisma/schema.prisma` intentionally has only the models shipped stories need (currently the nine models listed in "What this is"). The full target schema lives in `architecture.md` §7.1 — add models in their owning story, not ahead of time.
- **Auth config is split for the Edge runtime.** `src/auth.config.ts` is the edge-safe `NextAuthConfig` (JWT strategy, no Prisma, no Nodemailer) and is imported by `src/middleware.ts` (Edge) *and* by `src/lib/auth.ts`, which layers on the Prisma adapter + Nodemailer provider for the Node runtime. Don't import `@/lib/auth` from middleware. The user `role` rides on the JWT as a custom claim (set in the `jwt`/`session` callbacks), so it's readable without a DB hit — `@ts-expect-error` accompanies those reads until the session type is augmented.
- **Server Actions are the write path** (`(organizer)/events/actions.ts`, `contribute/[slug]/actions.ts`): co-located `actions.ts` + `schema.ts` (Zod), `'use server'`, gated by a `requireOrganizer()`-style auth check, validating with `safeParse`. They **return** a discriminated result (`{ id, slug }` on success, `{ error, fields }` on failure) rather than throwing — callers branch on the shape.
- **Stripe webhook is the source of truth for activation** (`api/stripe/webhook/route.ts`, `runtime = 'nodejs'`): it reads the raw body via `req.text()`, verifies the signature, and is idempotent (no-ops if already `ACTIVE`/`PAID`). It updates the event, writes an `AuditLog`, and enqueues a `NotificationLog` row in one `$transaction`. The checkout success page does **not** activate. The `stripe` client is `null` when keys are absent — guard before use.
- **Side effects are recorded, not fired (yet).** Privileged actions write `AuditLog` entries, and notifications are written as `NotificationLog` rows with `status: 'queued'` (the actual sender lands with the worker stories). The IP rate limiter (`src/lib/ratelimit.ts`) **fails open** when Redis is unavailable.

## Testing

- Vitest, `node` environment. `tests/setup.ts` provides default env stubs so config loads.
- **Integration tests are gated by `SKIP_INTEGRATION=true`** (they need real Redis from Docker + the Supabase `swara_test` schema). CI sets `SKIP_INTEGRATION=true` and runs unit tests only; lint + typecheck + test all run on every PR/push to `main` (`.github/workflows/ci.yml`).
- Each story owns its tests — write them with the story, not later.

---

The remaining guidelines reduce common LLM coding mistakes. They bias toward caution over speed; use judgment on trivial tasks.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
