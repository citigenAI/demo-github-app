# Swara Magical Memories

AI-assisted tribute video platform. By Swara Media.

## Documentation

- `docs/requirements.md` — product requirements
- `docs/architecture.md` — system design
- `docs/development-setup.md` — how to run locally
- `docs/stories.md` — incremental delivery plan
- `docs/stories/` — per-story implementation guides
- `docs/branding.md` — visual + voice brand reference

## Quick Start

1. Create Supabase databases (`swara_dev`, `swara_test`, `swara_prd`) — see `docs/development-setup.md` §4.
2. Copy `.env.example` to `.env.development.local` and fill in your Supabase `swara_dev` URL.
3. Install + start:
   ```bash
   npm install
   docker compose up -d
   npx prisma migrate dev
   npm run dev
   ```
4. In a second terminal: `npm run workers`
5. Visit http://localhost:3000 — landing page.
6. Visit http://localhost:3000/api/health — confirms DB + Redis are connected.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js dev server on :3000 |
| `npm run workers` | Idle worker process (BullMQ wires up in Story 9) |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript no-emit check |
| `npm run test` | Vitest (unit + integration) |
| `npm run build` | Production build |
| `npm run prisma:studio` | Browse the database |
