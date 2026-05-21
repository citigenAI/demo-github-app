# Stories: Incremental Delivery Plan

Break MVP 1 into 20 small, deployable stories. Each story adds **one meaningful capability** and ends in a green build that can be released to production. Build incrementally; ship frequently; never have a half-merged branch sitting for a week.

---

## Principles

1. **Every story is deployable.** If we paused after any story, what's on `main` runs in production without errors. Half-built features hide behind feature flags or stay un-routed.
2. **Vertical slices, not horizontal layers.** A story delivers an end-to-end user-visible (or admin-visible) capability, not "the data model for X."
3. **Dependencies are explicit.** A story lists what must already be on `main` before work starts.
4. **Foundation first, polish last.** Story 1 establishes the production-shaped skeleton. Reminders and lifecycle features come after the happy path works.
5. **Each story owns its tests.** Unit + integration tests written with the story, not in a future "testing story."

---

## Dependency Graph (high level)

```
              ┌──────────────────────────────┐
              │  Story 1: Foundation         │
              │  (skeleton, deployable)      │
              └──────────────┬───────────────┘
                             │
              ┌──────────────▼───────────────┐
              │  Story 2: Organizer auth     │
              └──────────────┬───────────────┘
                             │
              ┌──────────────▼───────────────┐
              │  Story 3: Event creation     │
              │  (free, no payment yet)      │
              └──────────────┬───────────────┘
                             │
        ┌────────────────────┼──────────────────────┐
        │                    │                      │
        ▼                    ▼                      ▼
  ┌──────────┐       ┌──────────────┐       ┌──────────────┐
  │ Story 4: │       │  Story 5:    │       │  Story 7:    │
  │ Stripe   │       │  Contributor │       │  Admin       │
  │ payment  │       │  text submit │       │  dashboard   │
  └──────────┘       └──────┬───────┘       │  (read-only) │
                            │               └──────┬───────┘
                            ▼                      │
                    ┌──────────────┐               ▼
                    │  Story 6:    │       ┌──────────────┐
                    │  Media       │       │  Story 8:    │
                    │  uploads     │       │  Approve /   │
                    └──────┬───────┘       │  reject      │
                           │               └──────────────┘
                           ▼
                    ┌──────────────┐
                    │  Story 9:    │
                    │  Workers +   │
                    │  quality     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Story 10:   │
                    │  Whisper     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Story 11:   │
                    │  Claude      │
                    │  analysis    │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Story 12:   │
                    │  Routing     │
                    │  analyzer +  │
                    │  approval    │
                    └──┬────────┬──┘
                       │        │
              ┌────────┘        └────────┐
              ▼                          ▼
       ┌──────────────┐           ┌──────────────┐
       │  Story 13:   │           │  Story 16:   │
       │  Manual:     │           │  AI:         │
       │  brief +     │           │  storyboard  │
       │  editor      │           │  + script    │
       │  email       │           └──────┬───────┘
       └──────┬───────┘                  │
              │                          ▼
              ▼                   ┌──────────────┐
       ┌──────────────┐           │  Story 17:   │
       │  Story 14:   │           │  AI video    │
       │  Editor      │           │  assembly +  │
       │  upload      │           │  encoding    │
       │  back        │           └──────┬───────┘
       └──────┬───────┘                  │
              │                          │
              └────────────┬─────────────┘
                           │
                    ┌──────▼───────┐
                    │  Story 15:   │
                    │  Delivery:   │
                    │  share page  │
                    │  + email     │
                    └──────────────┘

         (Lifecycle, can land in parallel after Story 6)
              ┌──────────────┐
              │  Story 18:   │   ┌──────────────┐
              │  Reminders   │   │  Story 19:   │
              │  cron        │   │  Data        │
              └──────────────┘   │  retention   │
              ┌──────────────┐   └──────────────┘
              │  Story 20:   │
              │  Right to    │
              │  delete      │
              └──────────────┘
```

---

## Story List

### Epic A — Foundation

| # | Title | Adds | Depends On | Complexity |
|---|---|---|---|---|
| 1 | **Project skeleton & deployment pipeline** | Deployable Next.js app, Supabase connection, config module, CI, health endpoint, landing page | — | M |

### Epic B — Event Creation

| # | Title | Adds | Depends On | Complexity |
|---|---|---|---|---|
| 2 | **Organizer authentication** | NextAuth magic-link login; organizer accounts persist in DB | 1 | S |
| 3 | **Event creation (free, no payment)** | Event creation wizard, slug generation, "My Events" list, QR code, share text generation | 2 | M |
| 4 | **Stripe payment + event activation** | Single MVP 1 package; Stripe Checkout; webhook activates event (DRAFT → ACTIVE) | 3 | M |

### Epic C — Submission Collection

| # | Title | Adds | Depends On | Complexity |
|---|---|---|---|---|
| 5 | **Contributor text-only submission** | Public form at `/contribute/[slug]`, name/relationship/text fields, consent, deadline enforcement, one-per-email | 3 | M |
| 6 | **Media uploads (video/voice/photo)** | Direct-to-storage presigned uploads via MinIO/R2; multiple media per submission; per-file metadata persisted | 5 | M |

### Epic D — Admin Operations (Basic)

| # | Title | Adds | Depends On | Complexity |
|---|---|---|---|---|
| 7 | **Admin dashboard — read-only** | Admin role gating (Google OAuth), event list, per-event detail with submission view | 5 | M |
| 8 | **Submission approval (approve/reject)** | Per-submission status changes by admin with optional note | 7 | S |

### Epic E — AI Pipeline

| # | Title | Adds | Depends On | Complexity |
|---|---|---|---|---|
| 9 | **Worker infrastructure + quality scoring** | BullMQ + Redis; first job: FFprobe quality scoring; idempotency pattern established | 6 | L |
| 10 | **Whisper transcription** | Per-media transcription job; transcripts persisted; skip when no audio/video | 9 | M |
| 11 | **Claude analysis (sentiment, quotes, tags)** | AI service wrapper with mock mode; sentiment + quote extraction per submission | 10 | M |

### Epic F — Routing

| # | Title | Adds | Depends On | Complexity |
|---|---|---|---|---|
| 12 | **Routing analyzer + admin approval gate** | Rule-based analyzer; approval card in dashboard with supporting/opposing signals; status transitions to AI_ROUTED or MANUAL_ROUTED | 11 | M |

### Epic G — Manual Path

| # | Title | Adds | Depends On | Complexity |
|---|---|---|---|---|
| 13 | **Manual workflow: brief ZIP + editor assignment** | Streaming brief ZIP assembly; editor JWT links; email send to editor with brief + upload link | 12 | L |
| 14 | **Editor upload back + admin review** | Token-gated upload page; validation; admin reviews and approves or requests revision | 13 | M |

### Epic H — Delivery

| # | Title | Adds | Depends On | Complexity |
|---|---|---|---|---|
| 15 | **Share page + download link + delivery email** | Token-based share page (no password in MVP 1); presigned download link; delivery email to organizer | 14 (or 17) | M |

### Epic I — AI Path

| # | Title | Adds | Depends On | Complexity |
|---|---|---|---|---|
| 16 | **AI storyboard + narration script generation** | Claude Opus storyboard; Claude Sonnet narration script; admin-editable | 12 | L |
| 17 | **AI video assembly + encoding variants** | FFmpeg encoder worker; assemble video from storyboard; produce master + Reel + YouTube + thumbnail | 16 | XL |

### Epic J — Lifecycle (can land in parallel late in development)

| # | Title | Adds | Depends On | Complexity |
|---|---|---|---|---|
| 18 | **Reminder automation (cron)** | Hourly cron sweep; 48h/24h contributor reminders; organizer milestone notifications | 6 | S |
| 19 | **Data retention — 30-day deletion** | Cron sweep for event_date + 30d; reminder email; organizer extension; hard delete at +37d | 15 | M |
| 20 | **Right to delete (user-initiated)** | Organizer event deletion + contributor self-service submission deletion; soft-delete + 72h grace + hard delete | 5, 7 | M |

**Complexity legend:** S = Small (0.5–1 day), M = Medium (1–3 days), L = Large (3–5 days), XL = Extra Large (5–8 days).

---

## Suggested Sprint Plan

| Sprint | Stories | Goal |
|---|---|---|
| **Sprint 0** | 1 | Deployable skeleton on Vercel |
| **Sprint 1** | 2, 3, 4 | Organizer can create & pay for an event |
| **Sprint 2** | 5, 6 | Contributors can submit media |
| **Sprint 3** | 7, 8 | Admin can see and approve submissions |
| **Sprint 4** | 9, 10, 11 | AI pipeline analyzes submissions |
| **Sprint 5** | 12 | Admin sees routing recommendation & approves |
| **Sprint 6** | 13, 14, 15 | **Manual path end-to-end shippable** |
| **Sprint 7** | 16, 17 | AI auto-rendering path |
| **Sprint 8** | 18, 19, 20 | Lifecycle features |
| **Sprint 9** | Polish, prod launch checklist (development-setup.md §10) | **MVP 1 launch** |

### Where to ship early

After **Sprint 6** (Story 15), MVP 1 is functionally complete via the manual path — every event routes through a human editor. This is shippable for graduation season. AI auto-rendering (Sprint 7) is a scaling improvement, not a launch blocker. If timeline is tight, ship after Sprint 6 + the lifecycle work in Sprint 8.

---

## Branching & Release Strategy

- One branch per story: `story-NN-short-name` (e.g., `story-01-foundation`).
- PR merges into `main`. Merging triggers production deploy.
- Each story PR description references the story file (e.g., "Closes Story 3 — see `docs/stories/story-03-event-creation.md`").
- Feature flags only when a story spans multiple PRs (rare); prefer making the smaller change first.

---

## Story Documentation Pattern

Each story gets its own file in `docs/stories/story-NN-*.md` with:
1. Goal & success criteria
2. Out of scope (what NOT to build in this story)
3. Prerequisites (dependencies from this plan)
4. Implementation steps (concrete)
5. File changes expected
6. Testing approach
7. Definition of done (deployment-ready checklist)
8. What unlocks next

**Story 1's full instructions live in `docs/stories/story-01-foundation.md`.** Subsequent stories' instructions are written when we agree this plan works.
