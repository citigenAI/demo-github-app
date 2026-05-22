# Sequence 05 / Story 7 — Admin Dashboard (Read-Only)

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (routes, authorization rules, query/data shapes shown in the UI, field lists, states,
error cases) so later code generation is unambiguous. Where a value is a proposal awaiting
confirmation it is flagged in §13 (Open Questions / Assumptions), not silently chosen.

| Field | Value |
|---|---|
| Story number / title | Story 7 — Admin dashboard (read-only) |
| Epic | D — Admin Operations (Basic) |
| Sequence number | 5 (this is the 5th in build order; parallel with Story 6) |
| Depends on | Story 5 (Contributor text submission — `Submission` model + `Event` collecting state) |
| Parallel with | Story 6 (Media uploads — `MediaItem` model) |
| Unlocks | Story 8 (Submission approval / reject) |
| Complexity | M (1–3 days) |

> **Sources of truth honored:** `docs/requirements.md` §2 (roles), §5.5 (Admin Dashboard), §8
> (access control); `docs/architecture.md` §10.2 (Auth model — Admin = NextAuth Google OAuth,
> allowlisted domains, `role=ADMIN`), §11.2 (SLA tracking — red/amber/green, red to top),
> §7.1 (schema: `Event`, `Submission`, `MediaItem`, enums), §13 (observability); `docs/stories.md`;
> `docs/branding.md` (admin UI tone); `docs/stories/story-01-foundation.md` (doc style);
> `CLAUDE.md` (conventions); `prisma/schema.prisma` (current: `User` + `Role`);
> `docs/design/seq02-story02-organizer-auth.md` (NextAuth foundation — admin OAuth is **additive**
> to it); `docs/design/seq03-story03-event-creation.md`, `seq04-story05-...`, `seq05-story06-...`
> (Event / Submission / MediaItem field consistency).

---

## 1. Story Summary

Build the first **admin-facing** surface in the product: a read-only operations console for the
**Swara Admin** role. It has two screens:

1. **Event list** (`/admin`) — every event in the system (across all organizers), with status,
   submitted-vs-expected submission counts, a delivery-date countdown, and an SLA risk indicator
   (red / amber / green). **Red (at-risk) events sort to the top** so the admin's attention lands
   where it matters first (`architecture.md` §11.2).
2. **Per-event detail** (`/admin/events/[id]`) — a contributors table (name, relationship,
   submission date, files submitted), a per-contributor submission-status badge, and a read-only
   media/asset list for the event.

Access is gated by a **new authentication path**: NextAuth **Google OAuth**, restricted to email
addresses on an allowlist of domains (`ADMIN_EMAIL_DOMAINS`) **and** carrying `role = ADMIN` in the
database. This is **additive** to the NextAuth installation Story 2 already shipped (magic-link for
organizers); it adds a second provider and the admin-gating logic at the `signIn` callback seam
Story 2 deliberately left open.

This story is **strictly READ-ONLY**. It performs **no mutations**: no approve/reject (Story 8), no
status changes, no AI artifact generation, no editor routing. It only authenticates admins and
reads + presents existing `Event` / `Submission` / `MediaItem` data.

### Success criteria

A reviewer checking out `main` and following run instructions can:

- [ ] Visit `/admin` while unauthenticated → be redirected to an admin sign-in path (never see data).
- [ ] Sign in with a Google account whose email domain is on `ADMIN_EMAIL_DOMAINS` **and** whose
      `User.role = ADMIN` → land on the event list.
- [ ] Sign in with a Google account on a **non-allowlisted** domain → be denied (no session, no data).
- [ ] Sign in with a Google account on an allowlisted domain but **without** `role = ADMIN` → be denied.
- [ ] See the event list with: honoree/event, status, submitted vs expected count, delivery
      countdown, and an SLA risk color, with **red events sorted to the top**.
- [ ] Open an event's detail and see a contributors table (name, relationship, submission date,
      files submitted), per-contributor status badges, and a read-only media/asset list.
- [ ] Find **no** approve/reject or any other write control anywhere in this story.
- [ ] Confirm an authenticated **organizer** (magic-link, `role = ORGANIZER`) cannot reach `/admin`
      (redirected/blocked).
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` pass; CI green; deploys; Google OAuth
      works in prod with prod env vars.

### What it unlocks

- **Story 8 (approve/reject)** reuses this story's admin auth gate, event-detail layout, and the
  per-submission status badge to add mutation controls (approve / reject with optional note).

---

## 2. Scope

### In scope (this story)

- **Admin authentication path:** NextAuth **Google OAuth** provider added to the existing
  installation; admin gating = `email` domain ∈ `ADMIN_EMAIL_DOMAINS` allowlist **AND**
  `User.role = ADMIN`. Enforced at the `signIn` callback seam from Story 2.
- **Authorization guard for all `/admin/*` routes and every admin data fetch** — non-admins
  (unauthenticated, organizers, wrong-domain Google users, allowlisted-domain-but-not-ADMIN users)
  are blocked/redirected and never receive event data.
- **Admin event list** (`/admin`): all events, with computed submitted-vs-expected counts, delivery
  countdown, and SLA risk (red/amber/green); red sorted to top.
- **Admin per-event detail** (`/admin/events/[id]`): contributors table, per-contributor status
  badges, read-only media/asset list.
- Read queries for the list (with computed counts + SLA risk) and detail (event + submissions +
  media). **No mutations.**
- Empty / loading / error / not-found states for both screens; responsive + brand styling; a11y.
- Config: wire `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` in **both**
  `src/config/env.ts` and `src/config/index.ts`; **use** the already-present `ADMIN_EMAIL_DOMAINS`
  (added for the seam in Story 2) and `NEXTAUTH_*` (added in Story 2) — see §7.
- Seed: an `ADMIN` user; events across statuses with varied submission counts + delivery dates to
  exercise SLA colors.
- Admin access logging + (light) metrics; admin route access audit (§11).

### Out of scope (deferred — with owners)

| Deferred item | Owner story |
|---|---|
| **Approve / reject** submissions, status changes, `adminNote` writes | Story 8 |
| Any mutation at all (this story never writes domain data) | Story 8+ |
| AI artifacts shown in detail (script, storyboard, quality scores, sentiment, quotes, tags) | Stories 9–11, 16; **routing card** Story 12 |
| Routing approval card / "Approve AI Routing" / "Switch to Manual" | Story 12 |
| Editor assignment panel, final-video upload panel, export package | Stories 13–15 |
| Admin **downloading** media (presigned GET) / playing media inline | Story 8 (or whenever download is needed); this story shows the asset **list** only — see §13 Q4 |
| Transcript / FTS search inside admin | Later (architecture §5 Search) |
| Reminders / notifications surfaced in admin | Stories 18 |
| Pagination/virtualization of very large event lists | §13 Q6 (default: simple list, capped) — revisit at scale |
| Organizer self-service surfaces (`/dashboard`, `/events/*`) — those are Story 3 and unchanged here | Story 3 |

**Surprise-integrity note:** the admin sees honoree **names** (the admin is an internal operator who
must, per requirements §5.5). The admin surface never exposes a honoree **contact** (no
`honoreeEmail` is collected at all yet — Story 3 A1), never sends any communication, and never leaks
share-page tokens (no `SharePage` exists until Story 15, and even then admin views must redact the
token — see §10).

---

## 3. Dependencies & Sequence

### Must already be on `main`

- **Story 1 (Foundation):** typed `config` module (`src/config/env.ts` raw read + `src/config/index.ts`
  Zod), Prisma client singleton `src/lib/db.ts`, structured `src/lib/logger.ts`, `@/` alias, ESLint
  rule banning `process.env` outside `src/config/env.ts`, Vitest unit + integration folders, brand
  tokens/fonts in `src/app/layout.tsx` + `globals.css`.
- **Story 2 (Organizer auth):** the **NextAuth installation** — route handler
  `/api/auth/[...nextauth]`, Prisma Adapter, **database sessions**, the `Account` / `Session` /
  `VerificationToken` tables, `User.emailVerified` + relations, the `session` callback that attaches
  `user.id` and `user.role` to the session, and the **`signIn` callback seam** (returns `true` for
  Email; documented as the place admin/domain gating is added here). `ADMIN_EMAIL_DOMAINS` already
  parsed into `config.auth.adminEmailDomains` (string[]) in Story 2 **but not enforced** — this story
  enforces it. `NEXTAUTH_SECRET` / `NEXTAUTH_URL` already in config.
- **Story 3 (Event creation):** `Event` model (`id`, `slug`, `organizerId`, `honoreeName`,
  `occasionType`, `eventDate`, `submissionDeadline`, `deliveryDate`, `theme`, `musicMood`,
  `expectedContributors`, `packageId`, `paymentStatus`, `status: EventStatus`, timestamps),
  `OccasionType` / `EventStatus` / `PaymentStatus` enums, `Package`, `AuditLog`, `User.events`
  relation.
- **Story 5 (Contributor submission):** `Submission` model (`id`, `eventId`, `contributorName`,
  `relationship`, `email?`, text fields, `consentGiven`, `consentAt`, `status: SubmissionStatus`,
  `adminNote?`, `submittedAt`, `ipAddress?`), `SubmissionStatus` enum, `@@index([eventId, status])`.

### Parallel with

- **Story 6 (Media uploads)** adds the `MediaItem` model + `MediaType` enum. Story 7's detail view
  **reads** `MediaItem` to render the "files submitted" count and the asset list. Per
  `seq05-story06` §3, the `MediaItem` schema is the **contract Story 7 consumes** — finalize Story 6
  §6 before Story 7's detail view is built. **Graceful degradation:** if Story 6 has not merged when
  Story 7 is implemented, the detail view renders "files submitted = 0 / no media yet" cleanly and
  the asset list shows its empty state (see §4.5, §13 Q3). The list/count code must not assume the
  relation exists; it reads media defensively.

### Sequence within this story

```
1. Config: add GOOGLE_OAUTH_CLIENT_ID/SECRET in env.ts + index.ts; confirm ADMIN_EMAIL_DOMAINS
   + NEXTAUTH_* present  → verify: config parses; prod refinement requires Google creds
2. Auth: add Google provider to NextAuth; enforce allowlist + role=ADMIN at signIn callback
   → verify: unit tests for the gate (allow/deny matrix)
3. Authz guard: admin-only middleware + server-side requireAdmin helper for /admin routes/fetches
   → verify: redirect/forbid tests
4. Read queries: listAllEvents (counts + SLA risk), getEventForAdmin (submissions + media)
   → verify: integration tests with DB
5. SLA risk function: pure, deterministic; red→top sort  → verify: unit tests at thresholds
6. Frontend: /admin list + /admin/events/[id] detail; all states  → verify: render states
7. Seed: ADMIN user + events spanning statuses/counts/dates  → verify: SLA colors visible
8. Tests + DoD  → verify: lint/typecheck/test green
```

---

## 4. Frontend / UI Design

All UI honors `docs/branding.md`: voice is **warm, confident, clear** but the admin console is an
**operational** surface — favor clarity and density over celebration; **no exclamation marks**;
**honoree name spelled exactly as entered** (branding §10 "honoree's name is sacred"); occasion-aware
nouns; title case for headings, sentence case for buttons/labels; Lucide outline icons (20px
default); palette tokens from `globals.css`; Fraunces (display) + Inter (body) already wired. The
signature gradient/gold is **not** used here (reserved for celebratory/delivery moments). SLA colors
reuse the functional palette: **green = `--success` (#15803D)**, **amber = `--warning` (#D97706)**,
**red = `--error` (#B91C1C)** — chosen so risk reads at a glance and meets WCAG AA against ivory.

### 4.1 Routes & pages (App Router, admin-only)

All routes below sit behind the admin authorization guard (§5.2). Unauthenticated or non-admin
requests are redirected to the admin sign-in path; they never render data.

| Route (path) | Type | Purpose |
|---|---|---|
| `/admin` | Server Component page | **Event list** — all events, statuses, counts, countdown, SLA risk (red→top). The admin landing page. |
| `/admin/events/[id]` | Server Component page | **Per-event detail** — contributors table, status badges, read-only media/asset list. `[id]` is the internal `Event.id` (cuid), not the slug. |
| `/admin/signin` (or reuse a NextAuth sign-in page with a Google button) | Page | Admin sign-in entry showing a single "Sign in with Google" action. **Assumption A2** — admins use a *separate* sign-in affordance from the organizer magic-link `/login`, per Story 2 Q4. |

> The organizer routes (`/login`, `/dashboard`, `/events/*`) are untouched. The admin console is a
> distinct namespace (`/admin/*`) so the two auth experiences never collide.

### 4.2 Event list (`/admin`)

**Heading:** "Events" (title case). A short subhead line in brand voice, e.g. "All tributes across
organizers. At-risk events appear first."

**Table (or responsive card list on small screens)** — one row per event, columns:

| Column | Source / computation | Display |
|---|---|---|
| **Honoree / event** | `Event.honoreeName` (exact casing) + occasion-aware noun from `occasionType` | e.g. "Riya's Graduation" / "Acme's Business Event". Links to `/admin/events/[id]`. |
| **Status** | `Event.status` (`EventStatus`) | Humanized label (see §4.6 status map): "Active", "Deadline Passed", "Awaiting Routing Approval", "In Review", "Delivered", etc. Neutral badge styling (status is informational, not the risk signal). |
| **Submitted / expected** | computed `submittedCount` (count of `Submission` for the event — see §5.4 for which statuses count) vs `Event.expectedContributors` | e.g. "12 / 14". Optionally a thin progress meter. |
| **Delivery countdown** | `Event.deliveryDate` vs server now | e.g. "in 3 days", "in 11 hours", "due today", or "overdue by 2 days" (past). Short functional date form per branding §10; relative phrasing for the countdown. |
| **SLA risk** | computed `slaRisk` ∈ {`GREEN`, `AMBER`, `RED`} (see §6.3 rule) | A colored pill/dot + text label ("On track" / "At risk" / "Critical"). **Color is never the only signal** — always paired with text + icon (a11y, §4.7). |

**Sort order (load-bearing, `architecture.md` §11.2):**
1. **`RED` events first** (most at risk to the top), regardless of recency.
2. Then `AMBER`, then `GREEN`.
3. Within each risk bucket, sort by **soonest `deliveryDate` ascending** (closest deadline first);
   tiebreak by `submissionDeadline` ascending, then `createdAt` descending.

> Terminal/parked statuses (e.g. `DELIVERED`) are computed as `GREEN`/not-at-risk by the SLA rule
> (§6.3) so they naturally fall below active at-risk work. **Assumption A5** — `DELIVERED` and
> `DRAFT` are never `RED`.

**Row affordance:** the whole row (or the honoree cell) is a link to the detail page. No inline
actions in this story (no menus, no buttons that mutate).

### 4.3 Per-event detail (`/admin/events/[id]`)

Server Component; loads the event by `id` via the admin guard + `getEventForAdmin` (§5.5). Sections:

1. **Header:** "{HonoreeName}'s {Occasion} tribute" (exact name, occasion-aware noun). Status badge
   (humanized). A compact meta row echoing read-only event facts the admin needs for context:
   occasion, event date, submission deadline (long form), delivery date + countdown, SLA risk pill,
   submitted/expected count, theme, music mood, package name. **No edit controls.**
2. **Contributors table** — one row per `Submission`:

   | Column | Source | Notes |
   |---|---|---|
   | **Name** | `Submission.contributorName` | exact as stored |
   | **Relationship** | `Submission.relationship` | exact as stored (label may have been business-adapted at capture; the **stored value** is shown) |
   | **Submission date** | `Submission.submittedAt` | short functional date+time (branding §10) |
   | **Files submitted** | count of related `MediaItem` rows, optionally broken down by type (e.g. "2 video, 1 photo") | "0" / "None" when no media (text-only submission, or Story 6 not merged — §3) |
   | **Status** | `Submission.status` (`SubmissionStatus`) badge | Pending / Approved / Rejected / Flagged (see §4.6) — **display only this story** |

   - Sort default: `submittedAt` descending (most recent first). **Assumption A6.**
   - The table shows **all** submissions for the event regardless of status (admin needs the full
     picture). No filtering controls required this story (a status filter is a nice-to-have — §13 Q5).
3. **Submission status summary (optional, light):** small count chips — "Pending 4 · Approved 6 ·
   Flagged 1 · Rejected 0" — derived from the same submissions. Read-only.
4. **Media / asset list (read-only):** a flat list (or grouped-by-contributor) of every `MediaItem`
   in the event, each showing: type icon (video/voice/photo), original file name (truncated),
   human-readable size, and (when present, post-Story 9) a quality flag indicator — but quality
   scores themselves are **out of scope** (Stories 9+). **No download/play affordance this story**
   (Assumption A4 / §13 Q4): the list proves "what was submitted" without exposing object bytes.
   Empty state when the event has no media.

> Explicitly **absent** from detail this story (all deferred): AI script, storyboard, quality
> scores, sentiment, quotes, routing recommendation/approval card, editor panel, export, approve/
> reject buttons. The layout should leave room for these (Story 8 adds approve/reject inline in the
> contributors table; Story 12 adds the routing card to the header) but ship none of them.

### 4.4 Components

| Component | Responsibility |
|---|---|
| `AdminShell` / `AdminHeader` (server) | Admin-namespace chrome: wordmark, "Events" nav, signed-in admin email, Sign-out. Distinct from the organizer `AuthHeader`. |
| `AdminSignInButton` (client) | Calls NextAuth `signIn("google", { callbackUrl: "/admin" })`. |
| `SignOutButton` (client) | Reuse Story 2's sign-out (`signOut({ callbackUrl: "/admin/signin" })`). |
| `EventListTable` (server) | Renders the event list rows from the `listAllEvents` result (already sorted by the query/service). |
| `SlaRiskBadge` (server/pure) | Maps `slaRisk` → color + label + icon; text always present. |
| `StatusBadge` (server/pure) | Maps `EventStatus` / `SubmissionStatus` → humanized label + neutral styling. |
| `DeliveryCountdown` (server/pure) | Maps `deliveryDate` + now → relative phrase ("in 3 days" / "overdue by 2 days"). |
| `ContributorsTable` (server) | Renders submissions for the detail page. |
| `MediaAssetList` (server) | Renders the read-only media list. |

All "badge"/"countdown" components are **pure presentational** so their mapping logic is unit-testable
(see §9) without rendering.

### 4.5 States (every page)

| State | Event list (`/admin`) | Event detail (`/admin/events/[id]`) |
|---|---|---|
| **Loading** | Skeleton table rows (quietly purposeful, 200ms; branding §9) | Skeleton header + table |
| **Empty** | No events anywhere: heading "No events yet." + body "When organizers create their first tribute, it'll appear here." (branding §11 admin empty-state copy, verbatim tone) | Event with no submissions: contributors table shows "No submissions yet." Media list shows "No files submitted yet." |
| **Error** | Calm inline error: "We couldn't load events right now. Please try again." + retry affordance | Same pattern |
| **Not found** | N/A | Unknown/invalid `id` → calm "We couldn't find that event." + link back to `/admin`. (Admins may see any event, so "not found" means genuinely no such row — no ownership leak concern as with organizers, but copy stays generic.) |
| **Unauthorized** | Never rendered — the guard redirects to `/admin/signin` before the page runs | Same |

Media-not-yet-available (Story 6 unmerged) is **not** an error: render the empty media list and
"files submitted = 0" gracefully (§3).

### 4.6 Status & label maps (exact)

**`EventStatus` → humanized label** (sentence/title per branding; used in badges):

| Enum value | Label |
|---|---|
| `DRAFT` | Draft |
| `ACTIVE` | Active |
| `DEADLINE_PASSED` | Deadline Passed |
| `AWAITING_ROUTING_APPROVAL` | Awaiting Routing Approval |
| `AI_ROUTED` | AI Routed |
| `MANUAL_ROUTED` | Manual Routed |
| `EDITOR_ASSIGNED` | Editor Assigned |
| `EDITING_IN_PROGRESS` | Editing In Progress |
| `FINAL_VIDEO_UPLOADED` | Final Video Uploaded |
| `IN_REVIEW` | In Review |
| `DELIVERED` | Delivered |

> Requirements §5.5's stated list (Active, Deadline Passed, In Review, Exported) is a **subset**;
> the architecture's `EventStatus` enum is the canonical superset. The list view humanizes whatever
> value the row holds. "Exported" has no enum value — treated as covered by later statuses; flagged
> §13 Q1.

**`SubmissionStatus` → badge** (display only this story; mutation is Story 8):

| Enum value | Label | Tone |
|---|---|---|
| `PENDING` | Pending | neutral |
| `APPROVED` | Approved | success |
| `REJECTED` | Rejected | error (muted) |
| `FLAGGED` | Flagged | warning |

**`OccasionType` → noun** (occasion-aware copy; same map as Story 3 §5.6):
`GRADUATION→"graduation"`, `BIRTHDAY→"birthday"`, `WEDDING→"wedding"`, `ANNIVERSARY→"anniversary"`,
`RETIREMENT→"retirement"`, `BUSINESS_EVENT→"business event"`.

### 4.7 Accessibility

- SLA risk and all status badges convey meaning via **text + icon + color**, never color alone
  (color-blind safe; branding §8 iconography). Each badge has an accessible name.
- Tables use proper `<table>` semantics with `<th scope="col">` headers; the event list's sort is
  conveyed in the column header context ("At-risk first").
- All interactive targets (row links, sign-in/out, retry) are keyboard-operable with visible focus
  rings; contrast meets WCAG AA (functional palette + ink on ivory).
- Loading regions announce via `aria-busy`; error/empty states use `role="status"`/`role="alert"`
  appropriately.
- The countdown's relative phrasing is real text (not only a visual bar) so it is read by AT.

### 4.8 Responsive + branding

- The event list table collapses to stacked cards on small screens (each card shows honoree, status,
  count, countdown, SLA pill). Admins may triage on a phone.
- Fraunces headings, Inter body; Lucide outline icons (calendar, users, video, image, mic, alert,
  clock) at 20px. Buttons sentence case; headings title case. No exclamation marks. Restrained,
  operational tone — not a "magical" surface.

---

## 5. Backend / API Design

Prefer **Next.js Server Components + server-side data functions** (the project standard;
`architecture.md` §5 — "Server Components for admin dashboard reduce client bundle"). Reads run on
the server inside the page (or a server data module). **No REST routes are required** for the reads;
optional thin route handlers may exist but are not specified. **Every** admin read is behind the
admin authorization guard (§5.2). **This story performs no mutations.**

### 5.1 Admin authentication — Google OAuth (additive to Story 2)

| Item | Value |
|---|---|
| Provider | **Google** OAuth, added to the existing NextAuth config from Story 2. Provider id: `google`. |
| Handler | The existing `/api/auth/[...nextauth]` route — no new auth route; the Google provider is added to the same `authOptions` / Auth.js config. |
| Adapter / session | Reuse Story 2's Prisma Adapter + **database sessions**. The `Account` table (already present from Story 2) now actually gets populated for the Google provider. |
| Credentials | `config.auth.googleClientId` (`GOOGLE_OAUTH_CLIENT_ID`), `config.auth.googleClientSecret` (`GOOGLE_OAUTH_CLIENT_SECRET`) — see §7. |
| Scopes | Minimal: `openid email profile` (we need verified email + name only). |
| Allowlist | `config.auth.adminEmailDomains` (string[]) — already parsed in Story 2; **enforced here**. |

**Admin gate at the `signIn` callback (the Story 2 seam):** when the provider is `google`, allow the
sign-in **only if both** conditions hold:

1. **Domain allowlist:** the lowercased domain part of the verified Google `email` (substring after
   the last `@`) is a member of `config.auth.adminEmailDomains`. Empty allowlist → deny all Google
   sign-ins (fail closed). Comparison is case-insensitive; exact domain match (not suffix match — so
   `evil-swaramagical.com` does not match `swaramagical.com`). **Assumption A3.**
2. **Role:** the corresponding `User` row has `role = ADMIN`.

If either fails → the `signIn` callback returns `false` (or redirects to an access-denied state),
NextAuth surfaces `AccessDenied`, and **no session is established**. The Email provider's `signIn`
behavior (organizers always allowed) is unchanged.

**The role question — how `role = ADMIN` is established (load-bearing, see §13 Q2):**

- The Prisma Adapter's `createUser` defaults new users to `role = ORGANIZER` (schema default). A
  brand-new Google user is therefore **not** an admin by default — correct fail-closed behavior.
- Admins are provisioned **out of band**: their `User` row is created/elevated to `role = ADMIN`
  via **seed** (dev/test) or a one-time DB operation / migration (prod). This story does **not**
  build an admin-management UI (no self-elevation, no "make admin" button — that would be a
  privilege-escalation surface).
- **Gate ordering to avoid creating junk users:** the domain-allowlist check should run **before**
  any user is persisted where possible (reject off-domain Google emails up front so we don't create
  `ORGANIZER` rows for random Google accounts). For an allowlisted-domain user who is not yet
  `ADMIN`, the sign-in is still denied (role check fails); whether that user row is created is an
  adapter-timing detail — **Assumption A4:** prefer denying before persistence; if the adapter
  creates the row first, the role check still blocks the session and no admin access is granted.
  (Document the chosen library's exact `signIn`/adapter ordering at code time.)

**`session` callback:** unchanged from Story 2 (already attaches `user.id` + `user.role`). Admin code
reads `session.user.role === "ADMIN"`.

### 5.2 Authorization guard (every `/admin` route + every admin fetch)

Two layers, defense in depth:

| Layer | Mechanism | Behavior |
|---|---|---|
| **Edge middleware** (coarse) | Extend Story 2's `src/middleware.ts` matcher to include `["/admin/:path*"]`. Reads the session cookie at the edge. | No valid session → redirect to `/admin/signin?callbackUrl=<path>`. Session present → continue (fine-grained role check happens server-side). |
| **Server-side `requireAdmin()` helper** (authoritative) | A single server helper that resolves the session via the Story 2 auth accessor and asserts `session.user.role === "ADMIN"`. Called at the top of **every** `/admin` page render **and** inside **every** admin read function. | No session or `role !== ADMIN` → redirect to `/admin/signin` (unauthenticated) or render a forbidden state / redirect (authenticated non-admin, e.g. an organizer). Never returns data. |

> **Why both:** middleware is a fast gate but, with database sessions, the authoritative
> role/user lookup happens server-side. The `requireAdmin()` helper is the real boundary — the read
> functions themselves refuse to run for non-admins, so even a missed middleware matcher cannot leak
> data. This satisfies requirements §8 ("Admin: authenticated only") and the "authz on every data
> fetch" hard constraint.

An authenticated **organizer** hitting `/admin` passes the middleware (they have a valid session) but
fails `requireAdmin()` (role is `ORGANIZER`) → blocked. **Assumption A1:** a blocked organizer is
redirected to their own `/dashboard` (or shown a calm "You don't have access to this area." page) —
not bounced into a Google sign-in loop.

### 5.3 No mutations (explicit)

This story exposes **zero** write operations. No Server Action, route handler, or query in this story
performs `create` / `update` / `delete` on any domain table. The only writes that occur are
NextAuth's own session/account rows (managed by the adapter during sign-in) and the access-log/audit
lines in §11. Approve/reject and all status changes are **Story 8**.

### 5.4 Read: list all events (with counts + SLA risk)

- **Operation:** `listAllEvents()` — server data function used by `/admin`. (Optional `GET /api/admin/events`
  not required.)
- **Auth:** `requireAdmin()` first; otherwise no data.
- **Behavior:** fetch **all** `Event` rows (across all organizers). For each event compute:
  - `submittedCount` — count of related `Submission` rows. **Counting rule (Assumption A7):** count
    **all** submissions regardless of `SubmissionStatus` (the contributor "submitted"; approval is a
    later admin action). Display is "submittedCount / expectedContributors". (If the team prefers
    "approved vs expected", that is a one-line change — §13 Q7.)
  - `slaRisk` — `GREEN | AMBER | RED` from the §6.3 rule, using `deliveryDate`, `submissionDeadline`,
    `status`, `submittedCount`, `expectedContributors`, and server `now`.
  - `deliveryCountdown` — derived relative phrase (may be computed in the presentational component
    instead; either is fine as long as the value driving sort is consistent).
- **Efficiency:** compute `submittedCount` with a grouped count (e.g. Prisma `groupBy` on
  `Submission.eventId`, or `_count` on the relation) — **avoid N+1** per-event queries. The SLA risk
  is then computed in-process per event from the already-fetched counts + dates.
- **Sort:** apply the §4.2 ordering (RED→AMBER→GREEN, then soonest delivery). Because SLA risk is
  computed in-process, the final sort is applied **after** computing risk (in the service), not in
  raw SQL. **Assumption A8** — for MVP volumes (tens/hundreds of events) in-process sort is fine;
  revisit with pagination at scale (§13 Q6).
- **Selected fields per row:** `id`, `slug`, `honoreeName`, `occasionType`, `status`,
  `submissionDeadline`, `deliveryDate`, `eventDate`, `expectedContributors`, plus computed
  `submittedCount`, `slaRisk`. (Do **not** select `honoreeEmail` — it does not exist yet, and must
  never be surfaced even when it does; §10.)
- **Errors:** unauthenticated/non-admin → blocked (§5.2). DB error → page renders the error state
  (§4.5); the function surfaces the failure to the page, which shows a calm retry.

### 5.5 Read: get event for admin (detail)

- **Operation:** `getEventForAdmin(id)` — server data function used by `/admin/events/[id]`.
- **Auth:** `requireAdmin()` first. **No ownership filter** — an admin may view any event (unlike the
  organizer `getEvent`, which is ownership-scoped). This is the deliberate difference between admin
  and organizer reads.
- **Behavior:** fetch the `Event` by `id` with:
  - related `Submission` rows (all statuses), selecting `id`, `contributorName`, `relationship`,
    `submittedAt`, `status` (and the related `MediaItem` count / list per submission);
  - related `MediaItem` rows (via submissions) for the asset list, selecting `id`, `type`,
    `originalName`, `sizeBytes`, `submissionId`, and (if present) `qualityFlags` — **but not**
    `qualityScore` exposure beyond a flag indicator this story;
  - the `Package` (for the header's package name) and any read-only event facts the header shows.
  - Compute the same `slaRisk` + `submittedCount` for the header.
- **Media defensiveness:** if `MediaItem` is not yet in the schema (Story 6 unmerged, §3), the media
  selection is skipped/empty and counts are 0 — no error.
- **Selected fields:** **never** select `Submission.ipAddress` for display (abuse-detection only;
  §10), **never** select `honoreeEmail`, **never** select share tokens (none exist yet). `email` on a
  submission is **not shown in the contributors table** in this story (the columns are name,
  relationship, date, files, status) — see §10 / §13 Q8.
- **Errors:** unauthenticated/non-admin → blocked. Unknown `id` → not-found state (§4.5). DB error →
  error state.

### 5.6 Endpoints summary

| Method | Path | Auth | Request | Response | Status codes (conceptual) |
|---|---|---|---|---|---|
| GET/POST | `/api/auth/[...nextauth]` | public (NextAuth) | NextAuth-managed (now incl. Google OAuth callback) | NextAuth-managed | 200; 302; 403 (CSRF); `AccessDenied` redirect on gate failure |
| GET | `/admin` | **admin session** | — | HTML (event list) | 200; 302 → `/admin/signin` (unauth) or `/dashboard` (organizer) |
| GET | `/admin/events/[id]` | **admin session** | path `id` | HTML (detail) | 200; 302 (non-admin); 404-equivalent (unknown id) |
| GET | `/admin/signin` | public (redirects authed admin → `/admin`) | query `callbackUrl?`, `error?` | HTML (Google sign-in) | 200; 302 |

No bespoke read REST endpoints are mandated; the reads are server functions consumed by the Server
Components. Sign-in/out go through NextAuth client methods hitting `/api/auth/*`.

### 5.7 Error handling

- Gate failure (off-domain or non-admin Google user) → NextAuth `AccessDenied`; the admin sign-in
  page maps it to a calm message: "This account doesn't have admin access." (no enumeration of *why*
  — domain vs role — beyond a generic line; §10).
- Unauthenticated `/admin/*` → redirect to `/admin/signin?callbackUrl=<same-origin path>`
  (off-origin callbackUrl rejected, reusing Story 2's open-redirect protection).
- DB/read failure → page error state; logged at error level (§11) with `eventId` where applicable.
- Misconfiguration (missing Google creds in prod) → config Zod parse fails fast at boot (§7),
  consistent with Story 1/2 config behavior.

---

## 6. Database Design

This story is **read-only over existing tables** and adds **no new core domain models**. The
`Event` (Story 3), `Submission` (Story 5), and `MediaItem` (Story 6) models, with their enums, are
the data this story reads. The NextAuth `Account` / `Session` / `VerificationToken` tables and the
`User.role` field already exist from Story 2. Therefore the only schema considerations are
(a) confirming the auth tables exist (they do — Story 2) and (b) optional **indexes** to keep the
admin list/detail queries efficient.

### 6.1 Auth tables — already present (reference Story 2)

No additions. `Account` (with `@@unique([provider, providerAccountId])`, `@@index([userId])`),
`Session`, `VerificationToken`, and `User.role: Role { ORGANIZER ADMIN }` were all added by Story 2
(`seq02-story02-organizer-auth.md` §6). The Google provider populates `Account` rows; nothing new is
needed for OAuth persistence.

### 6.2 Indexes for admin queries (additive, optional but recommended)

| Index | Table | Reason | Status |
|---|---|---|---|
| `@@index([status, submissionDeadline])` | `Event` | Listed in `architecture.md` §7.1 (originally "for reminder cron sweeps", Story 18). It also helps admin list filtering/sorting by status + deadline. **Decision:** add it **if not already added by Story 18**; if Story 18 hasn't landed, this story may add it (it's the canonical architecture index). Avoid duplicate migrations — coordinate with Story 18 (§13 Q9). | recommended / coordinate |
| `@@index([eventId, status])` | `Submission` | Already added by Story 5 — used here for per-event submission grouping/counts. | exists (Story 5) |
| `@@index([submissionId])` | `MediaItem` | Already added by Story 6 — used here to fetch media per submission. | exists (Story 6) |
| `@@index([organizerId])` | `Event` | Exists from Story 3 (My Events). Not needed by admin (admin lists all), but harmless. | exists (Story 3) |

> **No new tables. No new columns. No enum changes.** If the only schema change this story makes is
> adding `Event @@index([status, submissionDeadline])` (and only if Story 18 hasn't), it is a single
> additive, non-destructive migration (`add_event_status_deadline_index`). If that index already
> exists on `main`, this story makes **zero** schema changes — the cleanest outcome. **Assumption A9.**

### 6.3 SLA risk computation — the rule (define it)

`architecture.md` §11.2 specifies the *factors* ("time remaining vs. work remaining") and the
*display* (red/amber/green, red to top) but not exact thresholds. This story defines a **pure,
deterministic** rule. Thresholds are **proposals, flagged in §13 Q10** for tuning.

**Inputs (per event):** `deliveryDate`, `submissionDeadline`, `status`, `submittedCount`,
`expectedContributors`, server `now`.

**Definitions:**
- `hoursToDelivery = (deliveryDate - now)` in hours (negative if overdue).
- `submissionProgress = expectedContributors > 0 ? submittedCount / expectedContributors : 1`
  (treat 0 expected as fully satisfied to avoid divide-by-zero / false RED). **Assumption A11.**
- `pastSubmissionDeadline = now >= submissionDeadline`.

**Rule (evaluate top to bottom; first match wins):**

| # | Condition | Result |
|---|---|---|
| 1 | `status ∈ { DELIVERED }` | **GREEN** (work is done) |
| 2 | `status ∈ { DRAFT }` | **GREEN** (not yet activated; not Swara's clock yet) — **Assumption A5** |
| 3 | `hoursToDelivery < 0` (delivery date already past) and not delivered | **RED** (overdue) |
| 4 | `hoursToDelivery <= RED_HOURS` (default **48h**) and not delivered | **RED** (critical window) |
| 5 | Past submission deadline AND `submissionProgress < LOW_PROGRESS` (default **0.5**) AND not delivered | **RED** (deadline closed but too little material to make the date) |
| 6 | `hoursToDelivery <= AMBER_HOURS` (default **120h / 5 days**) and not delivered | **AMBER** (approaching) |
| 7 | Past submission deadline AND `submissionProgress < MID_PROGRESS` (default **0.8**) AND not delivered | **AMBER** (light material) |
| 8 | otherwise | **GREEN** |

**Threshold constants (proposed defaults — §13 Q10):**

| Constant | Default | Meaning |
|---|---|---|
| `RED_HOURS` | 48 | within 2 days of delivery (or overdue) → critical |
| `AMBER_HOURS` | 120 | within 5 days of delivery → approaching |
| `LOW_PROGRESS` | 0.5 | <50% of expected submitted (post-deadline) is critical |
| `MID_PROGRESS` | 0.8 | <80% of expected submitted (post-deadline) is a warning |

These constants live as **named constants in code** (not magic numbers); whether they become config
vars is §13 Q10 (default: in-code constants, no new env var — keeps config growth at zero this story).
The function is **pure** (`(eventInputs, now) → slaRisk`) so §9 unit tests pin every threshold
boundary. This is the rule that also drives the red→top sort (§4.2 / §5.4).

### 6.4 Migration notes

- If the `Event @@index([status, submissionDeadline])` is needed (Story 18 hasn't added it),
  create one additive migration `add_event_status_deadline_index`. Non-destructive; no backfill;
  safe to `prisma migrate deploy` against `swara_prd`.
- Otherwise: **no migration** this story.
- Run `prisma generate` only if a schema change is made.

---

## 7. External Services / Integrations / Config

### 7.1 Google OAuth setup (external)

- A **Google Cloud OAuth 2.0 Client (Web application)** must be created (Google Cloud Console →
  APIs & Services → Credentials). It yields the client id + secret used below.
- **Authorized redirect URI** = `${NEXTAUTH_URL}/api/auth/callback/google` for each environment
  (dev `http://localhost:3000/...`, staging, prod). The OAuth consent screen must list the
  `openid email profile` scopes. **This is an ops/setup step, not code** — flagged in DoD.
- We rely on Google's **verified email**; the allowlist domain check uses that email's domain.

### 7.2 Env vars — add in BOTH config files (project convention)

Add to **`src/config/env.ts`** (raw read — the only file allowed to touch `process.env`) **and**
`src/config/index.ts` (typed Zod schema + `loadConfig` mapping). Update `.env.example`.

| Env var | Purpose | Config path (typed) | Zod rule |
|---|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client id (admin sign-in) | `auth.googleClientId` | `string()` — required in prod (refinement below); optional in dev/test |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret | `auth.googleClientSecret` | `string()` — required in prod; optional in dev/test |

**Already present (Story 2) — this story USES, does not re-add:**

| Env var | Config path | Used for |
|---|---|---|
| `ADMIN_EMAIL_DOMAINS` | `auth.adminEmailDomains` (string[]) | The admin domain allowlist — **enforced** here (Story 2 parsed but did not enforce). Parsing rule below. |
| `NEXTAUTH_SECRET` | `auth.secret` | NextAuth cookie/CSRF signing |
| `NEXTAUTH_URL` | `auth.url` | Builds the Google callback URL |

**`ADMIN_EMAIL_DOMAINS` parsing (confirm Story 2's behavior, relied on here):** comma-separated;
split on `,`; trim each; lowercase each; drop empties; result is a `string[]`. Empty/unset →
`[]` → **all Google sign-ins denied** (fail closed). Each entry is a bare domain (e.g.
`swaramagical.com`, `swara.media`) compared by **exact, case-insensitive** equality against the
email's domain part (no leading `@`, no wildcard, no suffix match — §5.1 A3).

**Config refinement (prod fail-fast):** in `env === "production"`, both `auth.googleClientId` and
`auth.googleClientSecret` must be present and non-empty, **and** `auth.adminEmailDomains` must be
non-empty (an empty allowlist in prod means no one can ever sign in as admin — fail fast at boot
rather than silently lock everyone out). In dev/test these may be empty (admin sign-in simply won't
work locally without Google creds — acceptable; seed + tests cover the gate logic without live
Google). Add via Zod `superRefine`, consistent with Story 2's Resend refinement. **Assumption A10.**

> Add **only** the two Google vars this story needs. Do not introduce storage/Stripe/AI/editor vars
> here. Reading `process.env` anywhere except `src/config/env.ts` is forbidden (ESLint-enforced).

### 7.3 New runtime dependencies

- **None new** beyond what Story 2 installed. The Google provider ships within `next-auth` /
  `@auth/core` — no extra package. (Confirm at code time for the chosen NextAuth version.)

---

## 8. Seed Data

Extend the existing idempotent seed (Story 2/3/5). Seed must be **idempotent** (upsert by stable key)
and **never run against `swara_prd`** for sample users/events. The real prod `ADMIN` user is
provisioned out of band (§5.1 Q2), not by this dev seed.

### 8.1 Admin user

| Record | Fields | Why |
|---|---|---|
| Dev admin | `email = admin@swaramagical.com` (domain must be on dev `ADMIN_EMAIL_DOMAINS`), `name = "Dev Admin"`, `role = ADMIN` | Already seeded as a seam in Story 2 §8; this story confirms it and ensures the email domain matches the dev allowlist so the gate passes. Lets a developer reach `/admin`. (Live Google sign-in still requires Google creds; integration/unit tests cover the gate without Google — §9.) |

`.env.example` (dev) should set `ADMIN_EMAIL_DOMAINS=swaramagical.com` so the seeded admin's domain is
allowlisted. **Assumption A12.**

### 8.2 Events spanning statuses, counts, and delivery dates (to exercise SLA colors)

Seed (dev/test only) a spread of events owned by the seeded organizer(s), referencing the seeded
`Package`, so all three SLA colors and the red→top sort are visibly verifiable:

| # | Honoree / occasion | status | expected | submitted (seed N submissions) | deliveryDate | submissionDeadline | Expected SLA |
|---|---|---|---|---|---|---|---|
| 1 | Riya / GRADUATION | `ACTIVE` | 14 | 12 | now + 9 days | now + 2 days | **GREEN** (on track) |
| 2 | Arjun / BIRTHDAY | `DEADLINE_PASSED` | 20 | 8 | now + 4 days | now − 1 day | **RED** (post-deadline, <50%) |
| 3 | Acme / BUSINESS_EVENT | `IN_REVIEW` | 30 | 27 | now + 1 day | now − 3 days | **RED** (≤48h to delivery) |
| 4 | Meera / WEDDING | `ACTIVE` | 25 | 18 | now + 4 days | now + 1 day | **AMBER** (≤120h to delivery) |
| 5 | Sam / RETIREMENT | `DELIVERED` | 10 | 10 | now − 2 days | now − 10 days | **GREEN** (done; not RED despite overdue date) |
| 6 | (no submissions) Dev / GRADUATION | `ACTIVE` | 12 | 0 | now + 7 days | now + 5 days | **GREEN** (verifies empty-detail + 0/expected) |

- For events with submissions, seed `Submission` rows across `SubmissionStatus` (Pending/Approved/
  Flagged/Rejected) reusing Story 5's seed pattern so the detail status badges render varied.
- If Story 6 has merged, attach a few `MediaItem` rows to some submissions (reusing Story 6's seed
  with dummy objects) so "files submitted" and the asset list show non-zero data; if not, leave media
  empty (the views handle 0 gracefully).
- Use distinct slugs/emails to respect unique constraints; upsert by stable key for idempotency.
- Dates are computed relative to seed-run `now` so the SLA colors stay correct whenever the seed runs.

---

## 9. Testing

Follow the Story 1 pattern: Vitest, `tests/unit` + `tests/integration`, `vite-tsconfig-paths`.
Integration tests that need a DB use `swara_test` and honor the **`SKIP_INTEGRATION`** guard (skip
with a clear message when infra/DB is unavailable). Unit tests run without any DB or Google.

### 9.1 Unit tests (pure logic, no DB, no Google)

| Test | Asserts | Edge cases |
|---|---|---|
| **Admin allowlist gate — domain** | Given an allowlist and a Google email, the gate allows only exact, case-insensitive domain matches | `Admin@Swaramagical.com` allowed when `swaramagical.com` listed; `x@evil-swaramagical.com` **denied**; `x@sub.swaramagical.com` denied (no suffix match); empty allowlist → **deny all** |
| **Admin gate — role** | Allowlisted-domain user with `role = ADMIN` → allowed; with `role = ORGANIZER` → denied; both conditions required (AND) | domain ok + role ok = allow; domain ok + role wrong = deny; domain wrong + role admin = deny |
| **Allowlist parsing** | `ADMIN_EMAIL_DOMAINS` "swaramagical.com, swara.media" → `["swaramagical.com","swara.media"]`; trims, lowercases, drops empties; unset → `[]` | trailing comma, mixed case, spaces |
| **Config prod refinement** | In `production` with missing Google creds OR empty allowlist → config parse throws; in `development` it succeeds with empties | each missing var individually |
| **SLA risk computation** | Each branch of the §6.3 rule fires at its boundary | `hoursToDelivery` at exactly `RED_HOURS`/`AMBER_HOURS` (inclusive); overdue → RED; `DELIVERED` overdue → GREEN; `DRAFT` → GREEN; `expectedContributors = 0` → no divide-by-zero, GREEN; progress exactly at `LOW_PROGRESS`/`MID_PROGRESS` |
| **Red-to-top sort** | A mixed list sorts RED→AMBER→GREEN, then soonest `deliveryDate` ascending within bucket; ties broken deterministically | two RED events ordered by delivery; DELIVERED never above an active RED |
| **Count aggregation shape** | Given grouped submission counts, each event row gets the correct `submittedCount`; events with no submissions get `0` | event with 0 submissions; event missing from the group map → 0 |
| **EventStatus / SubmissionStatus / occasion label maps** | Each enum value maps to its exact §4.6 label/noun | all enum values covered; no exclamation marks in any label |
| **Delivery countdown phrasing** | `deliveryDate` vs now → "in 3 days" / "due today" / "overdue by 2 days" at boundaries | exactly now, +1h, −1h, +/− whole days |
| **No-mutation guarantee (static/contract)** | The admin read functions' contracts return data only; (lightweight) assert no write client method is invoked in the read path | — |

### 9.2 Integration tests (DB; skipped under `SKIP_INTEGRATION`)

| Test | Infra | Asserts |
|---|---|---|
| **List query — counts + risk** | `swara_test` seeded with the §8.2 spread | `listAllEvents` returns every event with correct `submittedCount` and the expected `slaRisk` per row; result is sorted red→top |
| **List query — no N+1** | seeded DB | counts are produced via a single grouped query (assert via query count / instrumentation, or at least that all rows resolve without per-event loops) |
| **Detail query** | seeded event with submissions (+ media if Story 6 merged) | `getEventForAdmin(id)` returns the event, all its submissions (name/relationship/date/status), media list/counts; **does not** include `ipAddress`, `honoreeEmail`, or any share token field |
| **Detail — admin sees any event** | two organizers' events | an admin can fetch an event regardless of `organizerId` (no ownership filter) |
| **Detail — not found** | — | unknown `id` → not-found result, no throw |
| **Authz — unauthenticated** | app route + middleware | GET `/admin` and `/admin/events/[id]` without a session → redirect to `/admin/signin` |
| **Authz — organizer blocked** | authenticated `ORGANIZER` session | GET `/admin/*` → blocked/redirected (not data); the read functions refuse for non-admin role |
| **Authz — admin allowed** | authenticated `ADMIN` session | GET `/admin` → 200 with the list |
| **Gate end-to-end (mocked Google)** | NextAuth handler with Google provider, profile mocked | allowlisted-domain + `ADMIN` user → session established; off-domain → `AccessDenied`, no session; allowlisted-domain non-admin → `AccessDenied`, no session |

> The only external boundary mocked is the **Google OAuth profile** (so tests don't hit Google). The
> DB and NextAuth gate logic are exercised for real against `swara_test`. No Stripe/Whisper/Claude
> mocks are relevant here.

### 9.3 Tests ↔ success criteria mapping

- Unauthenticated/organizer/off-domain/non-admin blocked → §9.1 gate tests + §9.2 authz tests.
- List columns (counts, countdown, SLA, red→top) → SLA + sort + count unit tests + list integration.
- Detail (contributors, badges, media list) → detail integration test.
- No write controls → no-mutation contract test + the absence of any mutation in §5.

---

## 10. Security & Surprise Integrity

| Control | Design |
|---|---|
| **Admin-only authz on every route AND every data fetch** | Edge middleware on `/admin/*` + authoritative `requireAdmin()` inside every page and every read function (§5.2). A non-admin never receives event data, even if a route matcher is missed. |
| **Domain allowlist (fail closed)** | Google sign-in allowed only for exact, case-insensitive `ADMIN_EMAIL_DOMAINS` matches; empty allowlist denies all; prod refinement requires a non-empty allowlist (§7.2). No suffix/wildcard matching (prevents look-alike domains). |
| **Role gate (defense in depth)** | Even an allowlisted-domain Google user is denied unless `User.role = ADMIN`. Role is provisioned out of band (seed/DB), never self-assignable — no admin-management UI in this story (no privilege-escalation surface). |
| **No new mutation surface** | This story writes no domain data; there is no approve/reject/route control to abuse. Smallest possible attack surface for the first admin screen. |
| **No honoree exposure** | Honoree **name** is shown (admin needs it; requirements §5.5) but **no honoree contact** is ever surfaced. `honoreeEmail` is not selected/displayed (it doesn't exist yet and must stay excluded when it does, per architecture §10.1). No communication is sent from this surface. |
| **No share-token leakage** | No `SharePage` exists until Story 15; this story never queries or renders any share token. When share pages arrive, admin views must show `/share/[redacted]`, never the raw token (architecture §10.1 #3) — noted as a forward constraint for whoever surfaces it. |
| **No contributor PII over-exposure** | `Submission.ipAddress` (abuse-detection only) is **never** selected for display. `Submission.email` is **not shown** in the contributors table this story (columns are name/relationship/date/files/status) — §13 Q8. Media object **bytes** are not exposed (list only, no presigned GET this story — §13 Q4). |
| **Generic gate-failure messaging** | The access-denied state says "This account doesn't have admin access." without disclosing whether the failure was domain vs role (avoids probing the allowlist). |
| **Open-redirect protection** | `/admin/signin?callbackUrl=` accepts same-origin/relative only (reuse Story 2's sanitizer); off-origin falls back to `/admin`. |
| **Cookie/session hardening** | Reuses Story 2's database sessions, `httpOnly`/`sameSite=lax`/`secure`-in-prod cookies, server-side revocation on sign-out, `NEXTAUTH_SECRET ≥ 32`. |
| **Secrets handling** | Google client id/secret read only via `config`; never logged; never shipped to the client. Only server components/functions read admin data. |
| **Indexing/referrer** | `/admin/*` are authenticated app pages; they should not be indexable. (No special surprise-page handling needed here since admin pages are gated, but ensure no admin route emits a public OG/share preview.) |

---

## 11. Observability / Audit

- **Admin access logging (structured, via `src/lib/logger.ts`):**
  - `info` on admin sign-in success: trigger `admin.signin.success`, with the admin **user id** (never
    full email in plaintext at info; redact/hash if email is logged).
  - `warn` on admin gate denial: trigger `admin.signin.denied`, with the **reason class** (`off_domain`
    or `not_admin`) and a redacted/hashed email — useful to detect probing. Do not log the raw email.
  - `info` on admin sign-out (user id only).
  - `info` on admin page access (optional, low-volume): `admin.view.event_list` and
    `admin.view.event_detail` with the admin user id and (for detail) the `eventId` — supports an
    "who looked at what" trail for an internal-operator surface.
  - `error` on read failures with `eventId` where applicable; never log PII (no honoree email, no
    contributor email/IP) in plaintext.
- **AuditLog (`AuditLog` table exists from Story 3):** this story is **read-only**, so there is no
  domain mutation to audit. **Decision (Assumption A13):** optionally write a lightweight `AuditLog`
  entry for **admin sign-in** (`action = "admin.signin"`, `actorId = admin user id`, `eventId = null`)
  to give compliance an in-DB record of admin authentication, since the admin console exposes all
  events. Reads themselves are logged (above) but **not** written to `AuditLog` to avoid noise — the
  structured logs cover view auditing. If even sign-in audit is unwanted, drop to logs-only (§13 Q11).
- **Metrics (light, per architecture §13):** counts worth emitting once observability lands —
  admin sign-in success/denial rate (by reason), event-list loads, count of events by SLA risk
  (a business signal: how many RED events at any time). No new metrics infra required this story; the
  logs are the source for a future daily snapshot.
- **No URL/token logging.** No share tokens or presigned URLs are produced or logged here.

---

## 12. Definition of Done

Story 7 is done only when all are true:

- [ ] §1 success criteria all pass locally.
- [ ] Google OAuth provider added to the existing NextAuth config (Story 2); the `signIn` callback
      enforces **exact-domain allowlist (`ADMIN_EMAIL_DOMAINS`) AND `role = ADMIN`**; Email/organizer
      sign-in unchanged.
- [ ] `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` added in **both** `src/config/env.ts`
      and `src/config/index.ts` with the prod refinement (creds + non-empty allowlist required in
      prod); `.env.example` updated; no `process.env` read outside `src/config/env.ts` (ESLint passes).
- [ ] Edge middleware protects `/admin/*`; the authoritative `requireAdmin()` helper gates every
      `/admin` page render and every admin read function; unauthenticated → `/admin/signin`,
      organizer → blocked/redirected to `/dashboard`.
- [ ] `/admin` lists **all** events with honoree/event, humanized status, submitted/expected count,
      delivery countdown, and SLA risk (red/amber/green), with **red events sorted to the top**;
      counts computed without N+1.
- [ ] SLA risk is computed by a pure, unit-tested function per the §6.3 rule (thresholds as named
      constants).
- [ ] `/admin/events/[id]` shows the contributors table (name, relationship, submission date, files
      submitted), per-contributor status badges, and a read-only media/asset list; admin can open any
      event (no ownership filter); media/0-submission cases render gracefully.
- [ ] **No mutation** exists anywhere in the story (no approve/reject, no status change, no write to
      domain tables); reads never select `ipAddress`, `honoreeEmail`, or any share token.
- [ ] Empty / loading / error / not-found states render on-brand (no exclamation marks, exact honoree
      names) with a11y (text+icon+color badges, table semantics, focus, contrast).
- [ ] Schema change is **at most** the additive `Event @@index([status, submissionDeadline])` (only
      if Story 18 hasn't added it), or **zero** schema changes; `prisma generate` clean if changed.
- [ ] Seed creates a `role = ADMIN` user (domain on dev allowlist) and events spanning statuses /
      counts / delivery dates that exercise all three SLA colors and the red→top sort; seed is
      idempotent and dev/test-only for sample data.
- [ ] Admin access logging in place (sign-in success/denial-with-reason, view access); no PII in
      plaintext logs.
- [ ] Unit + integration tests (§9) pass; integration tests skip cleanly under `SKIP_INTEGRATION`;
      Google profile mocked in the gate end-to-end test.
- [ ] Google Cloud OAuth client configured with the correct redirect URI(s) for each env (ops step).
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; PR merged; Vercel deploy
      succeeds; admin Google sign-in works on the deployed URL with prod env vars + allowlist set.
- [ ] PR references this design doc and `docs/stories.md` Story 7; `docs/stories.md` Story 7 row marked done.
- [ ] No TODO comments left in committed code (planned work lives in the story plan).

---

## 13. Open Questions / Assumptions

### Assumptions (proceed unless told otherwise)

- **A1 — Blocked organizer destination.** An authenticated organizer hitting `/admin` is redirected
  to `/dashboard` (or shown a calm "no access" page), not into a Google sign-in loop.
- **A2 — Separate admin sign-in affordance.** Admins sign in via a distinct Google button
  (`/admin/signin`), separate from the organizer magic-link `/login` (matches Story 2 Q4). The two
  auth experiences never mix on one page.
- **A3 — Exact-domain allowlist match.** `ADMIN_EMAIL_DOMAINS` entries are matched by exact,
  case-insensitive equality on the email's domain part — no wildcard, no suffix match (so look-alike
  domains and subdomains are not silently allowed).
- **A4 — Gate ordering.** Domain check runs before persisting a user where the chosen NextAuth
  version allows; regardless of adapter timing, a non-`ADMIN` user gets no session. No admin access
  is ever granted to a non-admin.
- **A5 — `DELIVERED` and `DRAFT` are never RED.** Terminal/pre-activation statuses are GREEN in the
  SLA rule so they never crowd the top of the list.
- **A6 — Contributors table default sort** is `submittedAt` descending (most recent first).
- **A7 — Count rule = all submissions** (any status) for "submitted vs expected." (Alternative:
  approved-vs-expected — Q7.)
- **A8 / A6(volume) — In-process sort + simple list.** SLA risk is computed in-process and the list
  is sorted in the service; acceptable for MVP volumes. Pagination/virtualization deferred (Q6).
- **A9 — Minimal/zero schema change.** Only the canonical `Event @@index([status, submissionDeadline])`
  may be added, and only if Story 18 hasn't; otherwise no schema change.
- **A10 — Prod config refinement.** In production, Google creds **and** a non-empty allowlist are
  required at boot (fail fast); dev/test may leave them empty.
- **A11 — Zero expected contributors → progress = 1** (treated as satisfied) to avoid false RED /
  divide-by-zero.
- **A12 — Dev allowlist** `ADMIN_EMAIL_DOMAINS=swaramagical.com` so the seeded admin's domain passes.
- **A13 — Optional admin-signin AuditLog row** in addition to structured logs; reads are logged but
  not written to `AuditLog`.

### Open questions (decide before/with build)

- **Q1 — Status values shown.** Requirements §5.5 names a small set (Active, Deadline Passed, In
  Review, **Exported**); the architecture enum is the larger canonical set with **no `EXPORTED`
  value**. Confirm the list humanizes the full `EventStatus` enum (this doc's default) and that
  "Exported" maps to a later status (e.g. `DELIVERED`) or is intentionally absent in MVP 1.
- **Q2 — Admin provisioning mechanism.** How is `role = ADMIN` set in **production**? (Seed is
  dev/test only.) Options: a one-time SQL/migration to elevate known emails, or a tiny CLI. This
  story builds **no** admin-management UI. Confirm the prod provisioning path.
- **Q3 — Story 6 merge timing.** If `MediaItem` isn't on `main` when Story 7 is implemented, the
  detail view degrades to "0 files / no media." Confirm acceptable, or sequence Story 6 before Story 7.
- **Q4 — Media download/play in detail.** Default: **list only**, no presigned GET this story
  (smaller surface; bytes not exposed). Confirm whether admins need to view/download media now or in
  Story 8.
- **Q5 — Submission status filter on detail.** Default: show all submissions, no filter control.
  Confirm whether a status filter (e.g. "show flagged only") is wanted now or in Story 8.
- **Q6 — Pagination/virtualization.** Default: simple list (optionally capped). At what event count
  do we need pagination/server-side sorting? Revisit when volume warrants.
- **Q7 — Count semantics.** "Submitted vs expected" counts **all** submissions by default. Confirm,
  or switch to approved-vs-expected (one-line change).
- **Q8 — Show contributor email in the table?** Default: **no** (columns are name/relationship/date/
  files/status). Confirm whether admins need the contributor email visible here (privacy trade-off).
- **Q9 — Who owns `Event @@index([status, submissionDeadline])`?** It's listed in architecture §7.1
  (originally tagged for the Story 18 reminder cron). Confirm whether Story 18 or Story 7 adds it to
  avoid a duplicate migration.
- **Q10 — SLA thresholds.** `RED_HOURS=48`, `AMBER_HOURS=120`, `LOW_PROGRESS=0.5`, `MID_PROGRESS=0.8`
  are proposals (architecture §11.2 specifies the concept, not the numbers). Confirm/tune. Also
  confirm they stay in-code constants vs becoming config vars.
- **Q11 — Audit depth for a read-only surface.** Default: log all views; write an `AuditLog` row only
  for admin sign-in. Confirm whether event-detail views should also be written to `AuditLog` (heavier
  but a fuller compliance trail).
- **Q12 — Schema not yet on `main`.** As of writing, `prisma/schema.prisma` holds only `User` +
  `Role`; `Event`/`Submission`/`MediaItem` arrive with Stories 3/5/6. This design assumes those land
  per their design docs and architecture §7.1 before Story 7 is implemented; reconcile field names if
  any upstream story diverges.
```
