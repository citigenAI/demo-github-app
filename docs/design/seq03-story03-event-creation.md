# Story 3 — Event Creation (Free, No Payment Yet)

**Sequence:** 3
**Epic:** B — Event Creation
**Depends on:** Story 2 (Organizer authentication)
**Unlocks:** Story 4 (Stripe payment + activation), Story 5 (Contributor submission), Story 7 (Admin dashboard)
**Complexity:** Medium (1–3 days)
**Type:** Implementation Design Document (design-level only — NO CODE). A later code-generation step implements exactly this.

> Sources of truth honored: `docs/requirements.md` §3, §4, §5.1, §6, §8; `docs/architecture.md` §6.1, §7.1, §10, §14; `docs/stories.md`; `docs/branding.md`; `docs/stories/story-01-foundation.md`; `CLAUDE.md`; `prisma/schema.prisma`.

---

## 1. Story Summary

### Goal
Let a logged-in organizer create a tribute event through a guided wizard, persist it as a `DRAFT` (no payment yet), and immediately give them everything they need to start inviting contributors: a unique public event slug (`/event/{slug}` style), a QR code that points at the contributor form URL, and pre-written WhatsApp (`wa.me`) and email share messages. The organizer can also see all of their own events in a "My Events" list and open any one to view its detail/share artifacts.

This story implements the **free part of `docs/architecture.md` §6.1 that happens BEFORE payment**: the organizer fills the wizard, the system creates the draft event and generates the slug + share artifacts. Payment, Stripe Checkout, and the `DRAFT → ACTIVE` transition are explicitly Story 4. The contributor form itself is Story 5 — but the contributor URL (derived from the slug) is generated and displayed here.

### Success criteria
- [ ] A logged-in organizer can open the creation wizard, complete every field from `docs/requirements.md` §5.1 (except Payment), and submit.
- [ ] On submit, an `Event` row is created with `status = DRAFT`, `paymentStatus = PENDING`, owned by the current organizer (`organizerId = session user id`).
- [ ] A unique, URL-safe slug is generated and stored; collisions never produce a duplicate (`slug` is `@unique`).
- [ ] The event detail page shows: the public event URL, a scannable QR code linking to the contributor form URL, a pre-written WhatsApp share link (`wa.me/?text=...`), and a pre-written email share subject + body. All copy uses the honoree's name exactly as entered and is occasion-aware.
- [ ] "My Events" lists only the current organizer's events with status badges; it never shows another organizer's events.
- [ ] Validation rejects bad input (missing required fields, illogical date ordering, out-of-range contributor count) with clear, branded inline errors and no row is written.
- [ ] All new env vars are added in BOTH `src/config/env.ts` and `src/config/index.ts`.
- [ ] Unit + integration tests pass (see §9); `npm run lint`, `npm run typecheck`, `npm run test` stay green.

### What it unlocks
- **Story 4** consumes the `DRAFT` event + `packageId` to create a Stripe Checkout session and flip `DRAFT → ACTIVE` on webhook.
- **Story 5** mounts the public contributor form at the contributor URL generated here.
- **Story 7** (admin dashboard) lists events created through this flow.

---

## 2. Scope

### In scope (this story)
- Authenticated organizer creation wizard with all §5.1 fields except Payment.
- `create event` server action / route → writes `Event` as `DRAFT`.
- Slug generation (unique, deterministic format, collision-safe).
- "My Events" list scoped to the logged-in organizer.
- Event detail page (single event, organizer-owned) showing slug URL, QR code, WhatsApp share link, email share text.
- `list my events` and `get event` reads (organizer-scoped, ownership-enforced).
- Server-side QR code generation as a capability (data URL or SVG).
- Pre-written WhatsApp + email share-text generation (pure, testable functions).
- Minimal Prisma schema growth: `Event` model subset, `OccasionType` + `EventStatus` + `PaymentStatus` enums, minimal `Package` representation, `User ↔ Event` relation, unique index on `slug`.
- Seed: one MVP 1 `Package` row, occasion enum values, a sample organizer + a couple sample events.
- `AuditLog` write for `event.created` (minimal `AuditLog` model added if not already present).

### Out of scope (deferred — with owners)
| Deferred item | Owner story |
|---|---|
| Payment (Stripe Checkout session, redirect, webhook) | Story 4 |
| Event activation `DRAFT → ACTIVE`; `stripeSessionId` population | Story 4 |
| Full payment/Stripe fields beyond the minimum needed to reach `DRAFT` | Story 4 |
| Tiered packages / multiple packages / per-tier UI | MVP 2 (this story ships **one** package row) |
| The contributor form page + submission logic at the contributor URL | Story 5 |
| Editing or deleting an existing event from the dashboard | Story 20 (right to delete); editing not in MVP 1 unless separately scoped |
| Admin dashboard / admin view of events | Story 7 |
| Reminders, notifications dispatch, email *sending* | Stories 18 / 5 onward (this story only **generates** share text; it does not send it) |
| WhatsApp Business API send | MVP 2 (MVP 1 = manual `wa.me` click-to-share only) |
| Honoree-facing communication of any kind | Permanently out (surprise integrity, `docs/architecture.md` §10) |
| Routing analyzer fields (`routingRecommendation`, etc.) | Story 12 |
| `honoreeEmail` capture | **Assumption A1** — see §13. Default: do NOT collect it this story. |

---

## 3. Dependencies & Sequence

### Must already be on `main` (from Story 1 + Story 2)
- Typed config module (`src/config/index.ts` + `src/config/env.ts`), `@/` path alias.
- Prisma client singleton (`src/lib/db.ts`), structured logger (`src/lib/logger.ts`).
- `User` model with `role` (`ORGANIZER` | `ADMIN`).
- **Story 2:** NextAuth magic-link auth; an authenticated server-side session helper that resolves the current `User` (id, email, role). This story assumes a way to read the current organizer session on the server (the exact helper name/signature is Story 2's; this doc refers to it abstractly as "the session helper").

### Sequence within this story
```
1. Schema: add Event + enums + Package (minimal) + AuditLog → verify: prisma migrate runs, prisma generate clean
2. Config: add NEXT_PUBLIC_APP_URL usage confirmation; add any new env vars in env.ts + index.ts → verify: config parses
3. Seed: one Package row + sample organizer + sample events → verify: seed script idempotent
4. Backend: slug gen, share-text gen, QR gen helpers (pure where possible) → verify: unit tests
5. Backend: createEvent action, listMyEvents, getEvent → verify: integration test create+list
6. Frontend: wizard, My Events list, event detail → verify: validation + render states
7. Tests + DoD checklist → verify: lint/typecheck/test green
```

---

## 4. Frontend / UI Design

All UI honors `docs/branding.md`: voice is **warm, confident, clear, quietly magical**; **no exclamation marks in transactional copy**; **honoree name spelled exactly as entered**; **occasion-aware language** ("graduation tribute", not "your video"); title case for headings, sentence case for buttons/labels; Lucide outline icons (20px default); palette tokens already defined in `src/app/globals.css` (`--color-brand-*`) and Tailwind classes (`bg-brand-ivory`, `text-brand-ink`, `text-brand-deep-saffron`, etc.); fonts Fraunces (display) + Inter (body) already wired in `src/app/layout.tsx`.

### 4.1 Routes & pages (App Router, organizer-only)
All routes below sit behind an authenticated organizer guard (redirect unauthenticated users to the Story 2 sign-in route).

| Route (path) | Type | Purpose |
|---|---|---|
| `/dashboard` (or `/events`) | Server Component page | "My Events" list — the organizer's home after login. **Assumption A2:** path is `/dashboard`. |
| `/events/new` | Server Component shell + Client wizard | Event creation wizard. |
| `/events/[id]` | Server Component page | Event detail: slug URL, QR, share text. `[id]` is the internal `Event.id` (cuid), not the public slug. |

> The **public** contributor URL uses the slug and lives at the contributor form route owned by Story 5 (planned: `/contribute/[slug]`, per `docs/stories.md` Story 5). This story does NOT mount that route; it only computes and displays the URL. The contributor URL string is the single source the QR and share text point at.

### 4.2 The creation wizard — every field + validation

The wizard collects the §5.1 fields. It MAY be a single scrollable form or a stepped wizard; either is acceptable. Recommended grouping into 3 visual steps for warmth and reduced cognitive load (**Assumption A3** — single page is acceptable if simpler):

- **Step 1 — Who & what:** Honoree name, Occasion type.
- **Step 2 — Dates & expectations:** Event date, Submission deadline (date + time), Delivery date, Expected contributors.
- **Step 3 — Style & package:** Theme, Music mood, Package selection.

Each field's exact contract:

| # | Field | UI control | Type submitted | Required | Validation rules | Error copy (branded, no "!") |
|---|---|---|---|---|---|---|
| 1 | Honoree name | Text input | string | Yes | Trimmed length 1–120; preserve exact casing/spelling (do NOT auto-capitalize/correct — `branding.md` §10). | "Please enter the honoree's name." |
| 2 | Occasion type | Select / radio cards | enum `OccasionType` | Yes | Must be one of: `GRADUATION`, `BIRTHDAY`, `WEDDING`, `ANNIVERSARY`, `RETIREMENT`, `BUSINESS_EVENT`. | "Please choose an occasion." |
| 3 | Event date | Date picker | date (ISO date) | Yes | Valid date. SHOULD be today or future (warn, not hard-block on past — **Assumption A4**: soft-warn past event dates). | "Please pick the event date." |
| 4 | Submission deadline | Date + time picker | datetime (ISO, with TZ) | Yes | Valid datetime; MUST be in the future (after now); MUST be **on or before** event date end-of-day OR before delivery date (see ordering rules below). | "The submission deadline must be in the future." |
| 5 | Delivery date | Date picker | date (ISO date) | Yes | Valid date; MUST be **on or after** submission deadline date. | "Delivery can't be before the submission deadline." |
| 6 | Theme | Select | string | Yes | One of curated options: `Classic`, `Cinematic`, `Vibrant`, `Minimal` (free-text NOT allowed in MVP 1 to keep editor briefs clean — **Assumption A5**). | "Please choose a theme." |
| 7 | Music mood | Select | string | Yes | One of: `Emotional`, `Upbeat`, `Inspirational`, `Nostalgic`. | "Please choose a music mood." |
| 8 | Expected contributors | Number input | int | Yes | Integer ≥ 1 and ≤ 500 (cap matches abuse/sanity bound; aligns with analyzer "high count >40" later but does not enforce it). | "Enter how many people you expect (1–500)." |
| 9 | Package selection | Radio card(s) | string (`packageId`) | Yes | Must reference an existing active `Package`. In MVP 1 exactly one package exists and is **pre-selected**; selection is data-driven (render from `Package` rows + `features[]`), never hardcoded by tier name. | "Please select a package." |
| — | Payment | — | — | **N/A this story** | Wizard ends at "Create event" → DRAFT. No payment UI. |

**Cross-field date ordering (validated client AND server):**
1. `submissionDeadline` > now (future).
2. `deliveryDate` ≥ date(`submissionDeadline`).
3. Recommended (soft warn, not block): `submissionDeadline` ≤ end-of-day(`eventDate`) — contributions usually close around/by the event. If violated, show a non-blocking notice; do not reject.
4. `eventDate` in the past → soft warn only.

**Package rendering (data-driven):** the package card renders `Package.name`, formatted `priceCents`, `features[]` as a checklist, `deliverySlaDays`, `includedRevisions`. The UI must read these from the row — no `if (tier === 'premium')`. Price is shown for context only; **no charge happens this story.**

**Submit button label:** "Create event" (sentence case). On success, redirect to `/events/[id]` (the detail page). Copy near the button clarifies the free-draft nature, e.g.: "Creating your event is free. You'll set up payment in the next step." (Story 4 is "next step".)

**Honoree-email field:** NOT present (Assumption A1 — surprise integrity; we never collect a honoree contact this story).

### 4.3 My Events list (`/dashboard`)
- **Heading:** "My Events" (title case).
- **Primary CTA:** "Create event" button → `/events/new`.
- **Empty state** (branded, no "!"): heading "No events yet." + body "Create your first tribute to start collecting wishes." + the Create event button. (Mirrors `branding.md` §11 empty-state tone.)
- **List/grid of cards**, one per owned event, each showing:
  - Honoree name (exact casing) + occasion label (human-readable: "Graduation", "Business Event").
  - Status badge: `Draft` (this story only ever produces Draft). Use functional colors — Draft = neutral/warning tone (`--warning` saffron family is acceptable for "needs payment"); reserve success/gold for later states.
  - Key dates in short functional form ("Submissions close May 17, 6:00 PM"; `branding.md` §10).
  - Expected contributors count.
  - Link to the event detail page.
- **Scoping:** server-side query filters by `organizerId = session user id`. Never render events the user doesn't own.
- **Sort:** most recent first (`createdAt desc`).

### 4.4 Event detail page (`/events/[id]`) — share artifacts
Server Component; loads the event by `id`, enforces ownership (404/redirect if not owner). Sections:

1. **Header:** "{HonoreeName}'s {Occasion} tribute" using exact name + occasion-aware noun (e.g., "Riya's Graduation tribute", "Acme's Business Event tribute"). Status badge `Draft`. A gentle note that payment is the next step (links forward to Story 4 once it exists; until then a disabled/placeholder "Set up payment" affordance is acceptable — **Assumption A6**).
2. **Public event link card:** the contributor URL displayed as selectable text with a copy-to-clipboard button. Format: `{NEXT_PUBLIC_APP_URL}/contribute/{slug}` (the contributor form route owned by Story 5). Label: "Your event link".
3. **QR code card:** rendered QR image (data URL or inline SVG) that encodes the **contributor URL** (same string as the link card). Caption: "Scan to open the contributor form." A "Download QR" affordance (downloads the PNG/SVG) is nice-to-have.
4. **Share via WhatsApp card:** a button "Share on WhatsApp" linking to the generated `https://wa.me/?text=<url-encoded message>` (opens in new tab). Below it, the message text shown read-only with a copy button. (Manual share only — no API; `requirements.md` §5.4.)
5. **Share via email card:** read-only **subject** + **body** fields, each with a copy button, plus an optional `mailto:?subject=...&body=...` "Open in email" affordance. The body contains the contributor URL.
6. **Details summary (read-only):** the wizard values echoed back (occasion, dates, theme, music mood, expected contributors, selected package name + features) so the organizer can confirm what they entered.

All share strings are produced by the backend share-text generators (§5.5) and passed to the page; the page does not assemble them ad hoc (keeps them testable and consistent).

### 4.5 States (every page)
- **Loading:** skeleton cards (quietly purposeful motion, `branding.md` §9; 200ms state changes).
- **Empty:** My Events empty state (above).
- **Error:** if event not found or not owned → render a calm not-found ("We couldn't find that event.") and a link back to My Events. Do not leak whether the event exists for another owner.
- **Validation error (wizard):** inline per-field messages (functional `--error` color), field focus moves to first error, submit disabled or re-enabled on correction; no row written.
- **Success (wizard):** redirect to detail page; optionally a one-time gentle confirmation banner ("Your event is ready to share.").

### 4.6 Responsive + branding
- Mobile-first; wizard is single-column on small screens; cards stack. The contributor link and QR must be easily shareable on a phone (organizers will often do this on mobile).
- Fonts: Fraunces for headings, Inter for body (already configured). Buttons sentence case; headings title case.
- Use Lucide outline icons (QR/scan, link, share, calendar, users) at 20px.
- Signature gradient/gold reserved for celebratory moments only — the Draft detail page is functional, not a "magical reveal"; keep it warm but restrained.

---

## 5. Backend / API Design

Prefer **Next.js Server Actions** (the project standard per `docs/architecture.md` §5 — "Server Actions handle form submissions without writing API routes"). Equivalent route handlers are acceptable if a story-2 pattern dictates; this doc specifies contracts, not transport, where it doesn't matter. Every operation is **organizer-only** and **ownership-enforced**.

### 5.1 Create event
- **Operation:** `createEvent` (Server Action) — or `POST /api/events`.
- **Auth:** required; resolve current user via the Story 2 session helper. Reject if no session or `role !== ORGANIZER` → unauthorized.
- **Input payload (validated with Zod):**
  | Field | Type | Required | Notes |
  |---|---|---|---|
  | `honoreeName` | string (1–120, trimmed) | yes | exact casing preserved |
  | `occasionType` | enum `OccasionType` | yes | |
  | `eventDate` | ISO date string | yes | |
  | `submissionDeadline` | ISO datetime string | yes | future |
  | `deliveryDate` | ISO date string | yes | ≥ deadline date |
  | `theme` | string (allowed set) | yes | |
  | `musicMood` | string (allowed set) | yes | |
  | `expectedContributors` | int (1–500) | yes | |
  | `packageId` | string | yes | must reference existing active `Package` |
- **Server-side validation** (mirror client rules — never trust client):
  - All required present and typed.
  - `submissionDeadline` strictly in the future relative to server `now`.
  - `deliveryDate` (as date) ≥ date(`submissionDeadline`).
  - `expectedContributors` integer in `[1, 500]`.
  - `packageId` resolves to an existing, active `Package`; otherwise reject.
  - Enum values within allowed sets; theme/music-mood within allowed sets.
- **Steps (pseudo, language-agnostic):**
  1. Authenticate + authorize (organizer).
  2. Parse + validate payload; on failure return field-level errors (no write).
  3. Generate unique `slug` (see §5.4) inside the same transaction or with retry-on-unique-violation.
  4. Insert `Event` with: `organizerId = session.userId`, all wizard fields, `packageId`, `status = DRAFT`, `paymentStatus = PENDING`, `slug`, timestamps default.
  5. Write `AuditLog` entry `action = "event.created"`, `actorId = session.userId`, `eventId = new id`, `metadata = { occasionType, packageId, slug }` (no honoree PII beyond name omitted — see §11).
  6. Return the created event's `id` (+ `slug`) so the UI can redirect to `/events/[id]`.
- **Output (success):** `{ id, slug }` (Server Action) → UI redirects. Status stays `DRAFT`.
- **Errors:**
  | Case | Result |
  |---|---|
  | Not authenticated | Unauthorized (redirect to sign-in) |
  | Authenticated non-organizer (e.g., admin) | Forbidden (**Assumption A7**: admins do not create events here) |
  | Validation failure | 400-equivalent with field error map; no row written |
  | `packageId` not found/inactive | Validation error on `packageId` |
  | Slug collision after N retries (see §5.4) | 500-equivalent; logged; user sees generic "Something went wrong, please try again." (extremely unlikely) |

### 5.2 List my events
- **Operation:** `listMyEvents` (server query used by `/dashboard`) — or `GET /api/events`.
- **Auth:** organizer session required.
- **Behavior:** return events where `organizerId = session.userId`, ordered `createdAt desc`. Select only fields the list needs (`id, slug, honoreeName, occasionType, status, submissionDeadline, deliveryDate, eventDate, expectedContributors, createdAt`).
- **Errors:** unauthenticated → unauthorized. Never returns other users' events.

### 5.3 Get event (detail)
- **Operation:** `getEvent(id)` (server query used by `/events/[id]`) — or `GET /api/events/[id]`.
- **Auth:** organizer session required.
- **Behavior:** fetch event by `id`; **enforce `event.organizerId === session.userId`**. If not found OR not owned → return "not found" (do not distinguish, to avoid existence leakage). Include the related `Package` (for the details summary). Compute and attach derived share artifacts (contributor URL, QR data, WhatsApp link, email subject/body) via the generators in §5.4/§5.5 — or compute them in the page from the returned event; either is fine as long as generation logic is the shared, tested helper.
- **Errors:** unauthenticated → unauthorized; not owned/not found → not-found result.

### 5.4 Slug generation
- **Goal:** a short, human-friendly, URL-safe, **globally unique** slug used in the public contributor URL.
- **Format rules:**
  - Base = slugified honoree name + occasion hint, e.g. honoree "Riya Sharma" + `GRADUATION` → base `riya-sharma-graduation`. (Occasion suffix is optional but recommended for readability — **Assumption A8**.)
  - Slugify: lowercase; transliterate/normalize accents to ASCII where feasible; replace any run of non-alphanumeric chars with a single hyphen; trim leading/trailing hyphens; collapse repeats.
  - Enforce max base length (e.g., 60 chars) before adding uniqueness suffix.
  - **Uniqueness:** append a short random suffix to guarantee uniqueness and to avoid leaking sequence/guessability — e.g., `-{6 char base36 random}` (e.g., `riya-sharma-graduation-k3p9zq`). Random suffix is preferred over incrementing counters (no enumeration, no race on read-then-write).
  - If the honoree name slugifies to empty (e.g., all non-Latin script that doesn't transliterate), fall back to base = occasion slug (e.g., `graduation`) + random suffix, or a neutral `event` base.
- **Collision handling:** insert with `slug` `@unique`; on unique-constraint violation, regenerate the random suffix and retry up to N times (e.g., 5). With 6 char base36 (~2.1B space) collisions are vanishingly rare; retry is a safety net.
- **Stability:** slug is generated once at creation and never changes (it backs the public URL, QR, and share links).
- **Validation/format guarantees (testable):** matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`; length ≤ ~80; always ends in the random suffix segment.

### 5.5 QR code generation
- **Capability (not code):** a server-side function `generateContributorQr(contributorUrl)` returns either a PNG data URL or an inline SVG string encoding the contributor URL. Use a small, dependency-light QR library (e.g., a `qrcode`-style package) — chosen by the implementer; treat as a capability. Generated server-side and passed to the detail page (no client-side library needed).
- **Encoded value:** exactly the contributor URL string (`{NEXT_PUBLIC_APP_URL}/contribute/{slug}`).
- **Error correction / size:** medium error correction, a size legible on a phone screen and printable (e.g., ~256–512px). Quiet zone preserved. (Implementer detail; not load-bearing.)
- **No caching/storage required this story** — generate on render. (Persisting the QR to object storage is unnecessary; the slug fully determines it.)

### 5.6 Share-text generation (pure, testable)
Two pure functions consume `{ honoreeName, occasionType, contributorUrl, submissionDeadline }` and produce branded copy. Copy follows `branding.md`: warm, no exclamation marks, exact honoree name, occasion-aware noun, short functional date for the deadline.

- **`buildWhatsAppShare(input)` →**
  - `message`: a single-line-friendly invite, e.g.:
    `Hi — I'm putting together a {occasionNoun} tribute for {honoreeName}. Add your wish, photo, or message here before {shortDeadline}: {contributorUrl}`
  - `waLink`: `https://wa.me/?text={encodeURIComponent(message)}` (no phone number — opens WhatsApp share with text prefilled; `requirements.md` §5.4).
  - **Test contract:** `waLink` starts with `https://wa.me/?text=`; decoding `text` yields `message`; `message` contains `honoreeName` verbatim and `contributorUrl` verbatim and contains NO exclamation mark.
- **`buildEmailShare(input)` →**
  - `subject`: e.g. `Add to {honoreeName}'s {occasionNoun} tribute`.
  - `body`: a short warm paragraph with the link and deadline, ending with the brand sign-off line "— Swara Magical Memories / by Swara Media" (per `branding.md` §11 examples). Plain text (UI may also offer `mailto:`).
  - **Test contract:** `subject` and `body` contain `honoreeName` verbatim; `body` contains `contributorUrl`; no exclamation marks; occasion noun matches the occasion.
- **Occasion noun mapping** (occasion-aware language, `branding.md` §10): `GRADUATION→"graduation"`, `BIRTHDAY→"birthday"`, `WEDDING→"wedding"`, `ANNIVERSARY→"anniversary"`, `RETIREMENT→"retirement"`, `BUSINESS_EVENT→"business event"`. For `BUSINESS_EVENT` / `ANNIVERSARY`, copy may use slightly more formal phrasing (e.g., "contribution" rather than "wish") — **Assumption A9**; keep it simple and data-driven off occasion.

### 5.7 Contributor URL construction
- Single helper `buildContributorUrl(slug)` → `{config.app.publicUrl}/contribute/{slug}` using the typed config (`NEXT_PUBLIC_APP_URL`, already in config). The path segment `contribute` must match the route Story 5 will mount; documented here as the contract so QR + share links + Story 5 agree. (**Assumption A10**: contributor base path is `/contribute/`.)

---

## 6. Database Design

Grow the schema by the **minimum** needed to reach a `DRAFT` event. Payment-related fields are included only as far as needed to represent a draft awaiting payment (`paymentStatus`, `stripeSessionId` nullable); full Stripe wiring is Story 4. Field names match `docs/architecture.md` §7.1 so later stories add fields without renames.

### 6.1 `Event` model — fields added this story
| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | String (cuid) | no | `cuid()` | PK |
| `slug` | String | no | — | `@unique`; public URL key; immutable after create |
| `organizerId` | String | no | — | FK → `User.id` |
| `organizer` | `User` relation | — | — | `@relation(fields: [organizerId], references: [id])` |
| `honoreeName` | String | no | — | exact casing |
| `occasionType` | `OccasionType` | no | — | enum |
| `eventDate` | DateTime | no | — | |
| `submissionDeadline` | DateTime | no | — | date+time |
| `deliveryDate` | DateTime | no | — | |
| `theme` | String | no | — | from allowed set (enforced in app, stored as string per §7.1) |
| `musicMood` | String | no | — | from allowed set (enforced in app) |
| `expectedContributors` | Int | no | — | 1–500 (app-enforced) |
| `packageId` | String | no | — | FK-by-id → `Package.id` (relation optional this story — see §6.4 note) |
| `paymentStatus` | `PaymentStatus` | no | `PENDING` | included now; transitions in Story 4 |
| `stripeSessionId` | String | yes | `null` | populated in Story 4 only |
| `status` | `EventStatus` | no | `DRAFT` | this story only ever writes `DRAFT` |
| `createdAt` | DateTime | no | `now()` | |
| `updatedAt` | DateTime | no | `@updatedAt` | |

**Indexes:**
- `@@unique([slug])` (via `@unique` on `slug`).
- `@@index([organizerId])` — for the My Events query.
- Do **not** add `@@index([status, submissionDeadline])` yet (that index is for the reminder cron, Story 18); add it in its owning story to keep this migration minimal. (Mentioned so it isn't duplicated later.)

**Fields intentionally deferred (NOT added this story):** `honoreeEmail` (Assumption A1), all `routing*` fields (Story 12), retention fields (`retentionReminderSentAt`, etc. — Story 19), and the relations `submissions`, `aiArtifact`, `editorAssignment`, `finalVideos`, `notifications` (added by their owning stories). The `auditLog` back-relation is added with `AuditLog` (§6.5).

### 6.2 `OccasionType` enum
Values (exact, from `requirements.md` §3 / `architecture.md` §7.1):
`GRADUATION`, `BIRTHDAY`, `WEDDING`, `ANNIVERSARY`, `RETIREMENT`, `BUSINESS_EVENT`.

### 6.3 `EventStatus` enum
Add the **full** enum value set from `architecture.md` §7.1 so later stories don't have to migrate the enum repeatedly (enum value additions are cheap, but defining the canonical set once avoids churn). Must include `DRAFT` first:
`DRAFT`, `ACTIVE`, `DEADLINE_PASSED`, `AWAITING_ROUTING_APPROVAL`, `AI_ROUTED`, `MANUAL_ROUTED`, `EDITOR_ASSIGNED`, `EDITING_IN_PROGRESS`, `FINAL_VIDEO_UPLOADED`, `IN_REVIEW`, `DELIVERED`.
> **Decision (note in migration):** This story only ever *writes* `DRAFT`. Defining the full enum now is a deliberate, low-risk choice to avoid repeated enum migrations. If the team prefers strictly minimal growth, the alternative is to add only `DRAFT`, `ACTIVE`, `DEADLINE_PASSED` now — see Open Question Q1.

### 6.4 `PaymentStatus` enum + `Package` representation
- **`PaymentStatus` enum:** `PENDING`, `PAID`, `REFUNDED`, `FAILED` (from §7.1). Only `PENDING` is written this story; full set defined once (Story 4 writes the others).
- **`Package` model (minimal, first-class, data-driven per `requirements.md` §4):**
  | Field | Type | Nullable | Default | Notes |
  |---|---|---|---|---|
  | `id` | String (cuid) | no | `cuid()` | PK; referenced by `Event.packageId` |
  | `name` | String | no | — | display name (final name set at launch) |
  | `priceCents` | Int | no | — | price for display/checkout (no charge this story) |
  | `currency` | String | no | `"usd"` | **Assumption A11**: currency stored on package for Story 4 |
  | `features` | String[] | no | `[]` | feature flags, e.g. `["video_master","reel","youtube","auto_thumbnail","download","share_page"]`; code checks membership, never tier name |
  | `deliverySlaDays` | Int | no | — | from §4 logical model |
  | `includedRevisions` | Int | no | `0` | from §4 logical model |
  | `active` | Boolean | no | `true` | only active packages are selectable |
  | `createdAt` | DateTime | no | `now()` | |
  > **Relation note:** A formal Prisma relation `Event.package Package @relation(...)` MAY be added now for typed joins in the detail summary, OR `Event.packageId` may remain a plain string FK-by-id (matching `architecture.md` §7.1, which lists `packageId String` with no explicit relation). **Recommended:** add the relation for ergonomics; it is additive and harmless. Implementer's choice — both satisfy the contract. If a relation is added, also add `events Event[]` back-relation on `Package`.

### 6.5 `User` relation + `AuditLog`
- **`User`:** add `events Event[]` back-relation (the `User` model already exists; this is the only change to it). No other `User` changes.
- **`AuditLog` (minimal, for §11):** if not already present, add:
  | Field | Type | Nullable | Default | Notes |
  |---|---|---|---|---|
  | `id` | String (cuid) | no | `cuid()` | PK |
  | `eventId` | String | yes | `null` | FK → `Event.id` (`onDelete: SetNull` per §7.1) |
  | `actorId` | String | yes | `null` | user id; null for system events |
  | `action` | String | no | — | e.g. `"event.created"` |
  | `metadata` | Json | yes | `null` | structured context (no sensitive PII) |
  | `createdAt` | DateTime | no | `now()` | |
  - Add `auditLog AuditLog[]` back-relation on `Event`.
  > If the team prefers to defer `AuditLog` to a later story, the `event.created` audit write becomes a logger-only line (see §11 / Open Question Q2). Recommended: add the minimal `AuditLog` now since multiple later stories need it and the audit requirement is explicit in `architecture.md`.

### 6.6 Migration notes
- New migration (e.g., `add_event_package_auditlog`) adds: `Event` table, `Package` table, `AuditLog` table, enums `OccasionType` / `EventStatus` / `PaymentStatus`, the `slug` unique index, the `organizerId` index, and the `User.events` relation (no column change on `User`; relations are virtual).
- Run with the project's pooled/direct URL convention (`DATABASE_URL` pooled at runtime, `DIRECT_URL` for `prisma migrate`, per `prisma/schema.prisma` and Story 1 §11).
- Verify `prisma generate` is clean and `npm run typecheck` passes after schema change.
- No data backfill needed (new tables). Seed (§8) populates the Package row.

---

## 7. External Services / Integrations / Config

### 7.1 New external services
**None ideally.** QR generation is an in-process library capability (no network call, no new account). No Stripe, no email send, no WhatsApp API this story.

### 7.2 Config / env vars
- **`NEXT_PUBLIC_APP_URL`** is already present in `src/config/env.ts` and `src/config/index.ts` (`config.app.publicUrl`). This story **uses** it to build the contributor URL, QR target, and share links. No new env var is strictly required.
- **If** the team chooses to make the contributor base path or a separate share/QR domain configurable (e.g., `NEXT_PUBLIC_SHARE_DOMAIN` exists in `architecture.md` §14 for share pages), then per project convention the new var MUST be added in **BOTH** `src/config/env.ts` (raw read) **AND** `src/config/index.ts` (Zod-validated, typed). **Recommendation:** do NOT add `NEXT_PUBLIC_SHARE_DOMAIN` this story — the contributor URL lives on the app domain (`NEXT_PUBLIC_APP_URL`); the separate share domain is for the delivery share page (Story 15). Keep config growth at zero this story.
- **Convention reminder (must be honored if any var is added):** every new env var → add to `src/config/env.ts` `rawEnv` object AND to the `ConfigSchema` + `loadConfig()` mapping in `src/config/index.ts`. Update `.env.example` accordingly. The ESLint `no-restricted-syntax` rule forbids reading `process.env` outside `src/config/env.ts`.

---

## 8. Seed Data

Seed must be **idempotent** (safe to re-run; upsert by stable key).

1. **Occasion types:** these are a Prisma `enum` (`OccasionType`), not table rows — nothing to seed; they exist by virtue of the enum.
2. **MVP 1 Package (one row):** upsert a single active package, e.g.:
   - `name`: placeholder e.g. "Magical Memories — Tribute Video" (final name TBD at launch, `requirements.md` §4 / `architecture.md` §17).
   - `priceCents`: placeholder (e.g., `9900`) — actual price set at launch (open question in `architecture.md` §17).
   - `currency`: `"usd"`.
   - `features`: `["video_master", "reel", "youtube", "auto_thumbnail", "download", "share_page"]` (maps to the MVP 1 feature list in `requirements.md` §4).
   - `deliverySlaDays`: placeholder (e.g., `7`).
   - `includedRevisions`: `0`.
   - `active`: `true`.
   - Use a stable upsert key (e.g., a known seed `id` or a unique `name`) so re-seeding doesn't duplicate.
3. **Sample organizer (dev/test only):** upsert a `User` with `role = ORGANIZER` (e.g., `organizer@example.com`).
4. **Sample events (dev/test only):** create 1–2 `Event` rows owned by the sample organizer, `status = DRAFT`, referencing the seeded Package, with realistic dates (future deadline, sensible ordering) and varied occasions (e.g., one `GRADUATION`, one `BUSINESS_EVENT`) so the My Events list and occasion-aware copy can be visually verified. Generate slugs via the same slug helper for realism.
- Seed should run only in non-production (guard on `config.env`), or at minimum the sample organizer/events should be dev/test-only while the Package row may be seeded in all environments (the real package must exist in prod for Story 4). **Assumption A12:** the Package row is environment-seeded (prod gets it too, with launch values); sample users/events are dev/test only.

---

## 9. Testing

Follow Story 1's pattern: Vitest, `tests/unit` + `tests/integration`, `vite-tsconfig-paths`. Each story owns its tests (`stories.md` principle 5).

### 9.1 Unit tests (pure logic, no DB)
- **Slug generation:**
  - Produces the documented format (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), lowercase, hyphen-normalized.
  - Strips/transliterates accents and removes illegal chars; collapses repeated separators; trims hyphens.
  - Empty/non-Latin honoree name falls back to occasion/`event` base.
  - Always appends a random suffix segment; two calls for the same name yield different slugs (suffix differs).
  - Respects max length cap.
- **Share-text / wa.me generation:**
  - `buildWhatsAppShare`: `waLink` starts with `https://wa.me/?text=`; URL-decoding `text` reproduces `message`; `message` contains honoree name verbatim + contributor URL verbatim; contains no `!`.
  - `buildEmailShare`: subject + body contain honoree name verbatim; body contains contributor URL + brand sign-off; no `!`.
  - Occasion noun mapping correct for all six occasions.
- **Contributor URL builder:** `buildContributorUrl(slug)` equals `{publicUrl}/contribute/{slug}` for given config.
- **QR generation:** returns a non-empty data URL/SVG; encodes the exact contributor URL (assert via library decode if feasible, else assert it was called with the URL — keep it light).
- **Wizard validation (schema-level):** the Zod input schema rejects: missing required fields; past `submissionDeadline`; `deliveryDate` before deadline; `expectedContributors` < 1 or > 500; out-of-set theme/musicMood; unknown `occasionType`. Accepts a fully valid payload.
- **Occasion-specific behavior:** business occasions (`BUSINESS_EVENT`, `ANNIVERSARY`) produce the slightly more formal share noun/phrasing (Assumption A9) while non-business produce the warmer "wish" phrasing — assert the difference deterministically.

### 9.2 Integration tests (with DB)
- **Create + list:** authenticated organizer creates an event via the action → row exists with `status = DRAFT`, `paymentStatus = PENDING`, correct `organizerId`, a unique slug; then `listMyEvents` returns it.
- **Ownership isolation:** organizer A's `listMyEvents` does NOT include organizer B's event; `getEvent(B's id)` as A returns not-found.
- **Slug uniqueness under collision:** creating two events that slugify to the same base both succeed with distinct slugs (forces the random-suffix/retry path; can be tested by stubbing the random source to collide once then differ).
- **Audit:** creating an event writes an `AuditLog` row with `action = "event.created"` and the new `eventId` (skip if AuditLog deferred per Q2).
- **Auth gate:** create/list/get without a session → unauthorized; non-organizer role → forbidden on create.
- **SKIP_INTEGRATION note:** integration tests require a reachable test DB (`swara_test`). Gate them so they are skipped when the DB env is absent (e.g., honor a `SKIP_INTEGRATION` env flag / skip when `DATABASE_URL` for test is unset), consistent with Story 1's integration test approach. Unit tests must run without any DB.

---

## 10. Security & Surprise Integrity

- **Organizer-only authorization:** all three operations (create, list, get) require an authenticated session resolved server-side (Story 2 helper). Create additionally requires `role = ORGANIZER` (admins use a different surface — Assumption A7).
- **Ownership checks on every read:** `listMyEvents` filters by `organizerId`; `getEvent` verifies `event.organizerId === session.userId` and returns an indistinguishable not-found otherwise (no existence leak across organizers).
- **No honoree contact wired to anything:** this story does NOT collect `honoreeEmail` (Assumption A1) and sends **no** communications at all (it only *generates* share text the organizer manually sends). There is therefore no path by which the honoree could be notified — satisfying `architecture.md` §10.1 surprise integrity by construction.
- **Slug is non-enumerable:** the random suffix prevents guessing other events' public URLs from a known one. The public URL is meant to be shared by the organizer; it is unguessable but not secret-grade (it is the contributor entry point). It does NOT expose the honoree's name beyond what the organizer chose (the honoree name appears in the slug only because the organizer is sharing it widely to contributors — acceptable; the *honoree* is excluded, not the contributors).
- **Input sanitization:** honoree name and all free-ish strings are stored as-is but rendered safely (React escaping) and never interpolated into HTML/SQL unsafely. URL-encode all values placed into `wa.me`/`mailto` query strings.
- **No secrets in client:** only `NEXT_PUBLIC_APP_URL` (already public) reaches the client; no server-only config is exposed.

---

## 11. Observability / Audit

- **Audit:** on successful create, write an `AuditLog` entry: `action = "event.created"`, `actorId = organizer user id`, `eventId = new event id`, `metadata = { occasionType, packageId, slug }`. Do not store honoree PII in `metadata` beyond what is operationally necessary (slug already contains the name as shared publicly; keep metadata lean). This satisfies the audit expectation in `architecture.md` §10/§13.
- **Structured logs:** use the existing `src/lib/logger.ts`. Log create attempts/outcomes at info level with `eventId` (post-insert) and `organizerId`; log validation failures at debug; log slug-collision retries at warn. Do not log full honoree name at info in production beyond the audit row. Never log raw share URLs in a way that could leak (low risk here, but keep consistent with the redaction posture in `architecture.md` §10.3).
- **Metrics (light, optional):** "events created" is a business metric (`architecture.md` §13). No new metrics infra required this story; the audit log is sufficient as the source for a future daily snapshot.

---

## 12. Definition of Done

- [ ] §2 success criteria all pass locally.
- [ ] Prisma migration adds `Event`, `Package`, `AuditLog`, the three enums, `slug` unique + `organizerId` index, and `User.events` relation; `prisma generate` clean.
- [ ] Any new env var (ideally none) added in BOTH `src/config/env.ts` and `src/config/index.ts` (+ `.env.example`); `process.env` not read outside `src/config/env.ts`.
- [ ] Wizard collects every §5.1 field (minus Payment) with client + server validation; bad input never writes a row.
- [ ] `createEvent` writes `status = DRAFT`, `paymentStatus = PENDING`, correct owner, unique slug; writes `event.created` audit row.
- [ ] My Events shows only the organizer's own events with Draft badges + empty state; event detail shows public URL, working QR (encodes contributor URL), `wa.me` share link + copyable message, email subject/body, and a read-only details summary.
- [ ] Share copy honors branding voice (warm, no `!`, exact honoree name, occasion-aware) and is produced by the shared tested generators.
- [ ] Package selection is data-driven (renders from `Package.features[]`); no tier-name hardcoding.
- [ ] Unit + integration tests in §9 pass; integration tests skip cleanly without a test DB.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green on the PR.
- [ ] PR references this design doc and `docs/stories.md` Story 3.
- [ ] No TODO comments left in committed code (planned work lives in the story plan).

---

## 13. Open Questions / Assumptions

### Assumptions (proceed unless told otherwise)
- **A1 — No `honoreeEmail` this story.** We do not collect a honoree contact field. It exists in the §7.1 target schema "for reference only," but capturing it now adds a surprise-integrity liability with no consumer this story. Defer the field (and its UI) to whenever a clear, safe use exists.
- **A2 — My Events lives at `/dashboard`.** (Alternative: `/events`.) Pick one; doc assumes `/dashboard`.
- **A3 — Wizard may be single-page** if simpler than a 3-step flow; both satisfy the field/validation contract.
- **A4 — Past `eventDate` is a soft warning, not a hard block** (organizers may back-date or test).
- **A5 — Theme & Music mood are fixed select sets** (Theme: Classic/Cinematic/Vibrant/Minimal; Mood: Emotional/Upbeat/Inspirational/Nostalgic) stored as strings. Free text disallowed in MVP 1 for clean editor briefs.
- **A6 — A forward-looking "Set up payment" affordance** may appear on the detail page as disabled/placeholder until Story 4 wires it.
- **A7 — Admins do not create events** via this organizer surface (create is organizer-only). Adjust if admins need to create on behalf of organizers.
- **A8 — Slug includes an occasion hint** (`{name}-{occasion}-{random}`) for readability; name-only + random is acceptable if preferred.
- **A9 — Business occasions get slightly more formal share phrasing** ("contribution" vs "wish"); minor, data-driven off occasion.
- **A10 — Contributor base path is `/contribute/`** to match Story 5's planned route in `docs/stories.md`. Story 5 must mount exactly this path so QR + share links resolve.
- **A11 — `Package.currency` stored on the package** (default `"usd"`) for Story 4's checkout.
- **A12 — Package row seeded in all environments** (prod included, with launch values); sample organizer/events seeded in dev/test only.

### Open questions (decide before/with build)
- **Q1 — `EventStatus` enum scope now:** define the full canonical value set (recommended, avoids repeated enum migrations) vs. add only `DRAFT`/`ACTIVE`/`DEADLINE_PASSED` and grow per story? (Doc recommends full set.)
- **Q2 — Add `AuditLog` now vs. defer:** recommended to add the minimal `AuditLog` table this story (multiple later stories need it; audit is an explicit architectural requirement). If deferred, `event.created` becomes a logger-only line until its owning story.
- **Q3 — Slug random suffix length/charset:** 6-char base36 proposed (~2.1B space). Confirm acceptable, or prefer a longer/shorter suffix or a different alphabet.
- **Q4 — Package–Event Prisma relation:** add a formal `@relation` (ergonomic typed joins) vs. keep `packageId` as a plain string FK matching §7.1 verbatim? (Doc recommends adding the relation; both satisfy the contract.)
- **Q5 — Final package name & price:** placeholders only this story (real values are `architecture.md` §17 open items, finalized for Story 4). Confirm seed placeholders are acceptable for now.
- **Q6 — Can an organizer edit a DRAFT event** after creation (e.g., fix a typo in honoree name before paying)? Editing UI is currently out of scope; confirm whether a minimal edit is desired in Story 3 or deferred. (Doc assumes deferred.)
