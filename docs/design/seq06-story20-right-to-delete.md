# Sequence 06 / Story 20 — Right to Delete (User-Initiated)

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (routes/actions, field names, token scheme, soft-vs-hard-delete steps, cron
timing, error cases) so later code generation is unambiguous. Where a value is a proposal
awaiting confirmation it is flagged in §13 (Open Questions / Assumptions), not silently
chosen.

| Meta | Value |
|---|---|
| Story number / title | Story 20 — Right to delete (user-initiated) |
| Sequence number | 6 (this is the 6th design in build order) |
| Epic | J — Lifecycle |
| Depends on | Story 5 (Submission model + `/contribute/[slug]` + contributor email/`deletionToken` origin), Story 7 (Admin/organizer dashboard event detail) |
| Parallel with | Story 18 (Reminders cron), Story 19 (30-day retention) |
| Unlocks | Story 19 reuses the soft/hard-delete + cron-sweep machinery defined here |
| Complexity | M (1–3 days) |

> **Sources of truth honored:** `docs/requirements.md` §8 (Right to delete; Data
> retention); `docs/architecture.md` §7.2 (storage layout / `deleted/` prefix), §10
> (security & surprise integrity), §11.3 (S3 versioning), §11.4 (Data Retention &
> Deletion — the canonical spec for this story), §14 (env); `docs/stories.md`;
> `docs/branding.md`; `docs/stories/story-01-foundation.md`; `CLAUDE.md`;
> `prisma/schema.prisma`; sibling designs `seq03-story03-event-creation.md`,
> `seq04-story05-contributor-text-submission.md`, `seq05-story06-media-uploads.md`.

> **Schema-state caveat.** As of this writing, live `prisma/schema.prisma` contains only
> the `User` model; `Event`, `Submission`, `MediaItem`, `AuditLog`, etc. are introduced by
> their owning stories (3, 5, 6, …). This document assumes those models exist on `main`
> exactly per `architecture.md` §7.1 and the sibling designs above when Story 20 lands. If
> any field names diverge, reconcile §6 against the merged schema before generating code.

---

## 1. Story Summary

Story 20 gives the two human owners of event data a way to **delete it themselves, on
demand**, satisfying `requirements.md` §8 "Right to delete":

- **Organizer** — from their dashboard, deletes an **entire event** and everything
  associated with it (all submissions, media, AI artifacts, editor assignment, final
  videos, share page, and the event row + its S3 objects).
- **Contributor** — via a **tokenized self-service link** that ships in their submission
  confirmation email, deletes **only their own submission** (and its media). Deleting a
  submission never deletes the event and never reveals anything about the event or honoree
  beyond what that one contributor already knows.

Both flows follow the identical machinery mandated by `architecture.md` §11.4:

```
2-click confirm ──► soft-delete NOW ──► [72h grace] ──► hard-delete (cron sweep)
                    (rows marked,                       (DB rows purged,
                     S3 objects moved                    S3 objects deleted,
                     to deleted/ prefix)                 de-identified audit kept)
```

The soft-delete is **immediate and reversible-by-support** during the 72-hour grace
window (data is marked deleted and hidden from all normal queries, files relocated under a
`deleted/` prefix but not yet destroyed). After 72h a cron sweep performs the
**irreversible** hard delete. Throughout, `NotificationLog` and `AuditLog` retain a
**de-identified** record of the deletion for compliance.

This story deliberately builds the soft/hard-delete + cron-sweep **as shared machinery**
so Story 19 (scheduled 30-day retention) reuses exactly the same hard-delete executor and
sweep, differing only in *what triggers* the soft-delete.

---

## 2. Scope

### In scope

- **Organizer event deletion**: a delete-event control on the organizer event-detail page
  (Story 7 surface) with a **2-click confirmation** that explicitly warns what will be
  destroyed; a server action that authorizes ownership, soft-deletes the event +
  cascade-marks all descendants, and moves the event's S3 objects to the `deleted/` prefix.
- **Contributor self-service submission deletion**: a tokenized public page reached via the
  `deletionToken` link from the confirmation email; a 2-click confirm; a server action
  that validates the token, soft-deletes **only** that submission + its media, moves that
  submission's S3 objects to `deleted/`.
- **Soft-delete semantics**: set `deletedAt` + `hardDeleteAt = deletedAt + 72h` on the
  affected rows; exclude soft-deleted rows from all normal queries (a shared filter
  pattern); relocate S3 objects to `deleted/`.
- **72-hour grace hard-delete cron sweep**: a worker (Story 9/18 BullMQ + cron pattern)
  that finds rows past `hardDeleteAt`, purges DB rows and S3 files, and writes a
  de-identified audit record. **This sweep + executor is the shared mechanism Story 19
  reuses.**
- **De-identified audit retention**: `AuditLog` deletion events with PII stripped;
  `NotificationLog` entries retained with email hashed.
- **`deletionToken` generation point**: the token column lives on `Submission`; this story
  ensures every contributor submission has a unique, unguessable `deletionToken` and
  defines the self-service URL it backs (see §13 Q1 on where the column/token actually gets
  populated — Story 5 vs here).
- Schema additions: `Event.deletedAt` / `Event.hardDeleteAt`;
  `Submission.deletionToken @unique` / `Submission.deletedAt` / `Submission.hardDeleteAt`.
- Config: deletion grace-period config in **both** `src/config/env.ts` and
  `src/config/index.ts`.
- Seed data: an event + submissions with deletion tokens, plus one already-soft-deleted
  record awaiting hard delete.
- Unit + integration tests; `SKIP_INTEGRATION` honored.

### Out of scope (deferred — with owners)

| Item | Where it lands |
|---|---|
| **Scheduled 30-day retention deletion** (event_date + 30d → reminder → hard delete) | **Story 19** — *reuses* this story's soft/hard-delete executor + sweep; this doc designs the machinery to be shared |
| Sending the contributor **confirmation email** itself (the email body, Resend send) | Story 5 / 18 (see §13 Q1). This story defines the **link/token** the email must contain and the page it points to |
| Retention **extension** UI (extend by 30 days, up to 2×) | Story 19 |
| Organizer **un-delete / restore** UI within the grace window | Out of MVP 1 (support-only restore; see §13 Q5) |
| Bulk admin deletion / GDPR data-export-then-delete | Out of MVP 1 |
| Deleting *individual media items* from within a submission (partial submission edit) | Out of MVP 1 (`seq05-story06` §2) |
| Stripe-side refund on event deletion | Out (deletion ≠ refund; see §13 Q6) |
| Orphan-object lifecycle reaping for abandoned uploads | Story 9 / lifecycle (`seq05-story06` §13 Q10) |

---

## 3. Dependencies & Sequence

### Must already be on `main`

- **Story 1 (Foundation):** typed `config` (`src/config/env.ts` + `src/config/index.ts`),
  Prisma client singleton (`src/lib/db.ts`), `src/lib/logger.ts`, Redis client, worker
  scaffold (`src/workers/index.ts`), CI.
- **Story 3 (Event creation):** `Event` model (`id`, `slug`, `organizerId`, `status`,
  `honoreeName`, `occasionType`, …), `AuditLog` model, `User ↔ Event` relation.
- **Story 5 (Contributor submission):** `Submission` model, `email`, `consentAt`, the
  `/contribute/[slug]` form, and the place where the **confirmation email + `deletionToken`
  link** originates (see §13 Q1).
- **Story 6 (Media uploads):** `MediaItem` model + `storagePath`; the **storage service
  interface** (the only module that talks to S3) — Story 20 adds a `moveToDeletedPrefix`
  and a `deletePrefix`/`deleteObjects` capability to that interface.
- **Story 7 (Admin/organizer dashboard):** the organizer-facing **event detail page**
  where the delete-event control is mounted, plus the session helper and ownership checks.
- **Story 9/18 (Workers + cron):** BullMQ worker registration and the cron-sweep pattern
  (hourly/daily scheduled job) this story's hard-delete sweep follows.

> **Dependency flag.** `stories.md` lists Story 20's hard dependencies as **Story 5 and
> Story 7**. Story 6 (media/storage interface) and Story 9/18 (worker + cron) are *de
> facto* prerequisites for the S3-move and the cron sweep to be real. If Story 20 must ship
> before Story 9/18, the soft-delete (DB mark + S3 move) is fully functional immediately;
> only the **hard-delete sweep** needs the cron/worker host — see §13 Q2 for the fallback
> (a manually-invokable executor + a Vercel Cron trigger).

### Sequence within this story

```
1. Schema: add Event.deletedAt/hardDeleteAt + Submission.deletionToken/deletedAt/hardDeleteAt
   → verify: prisma migrate runs; prisma generate clean; deletionToken backfilled unique
2. Config: add deletion grace-period vars in env.ts + index.ts (+ .env.example)
   → verify: config parses
3. Storage interface: add moveToDeletedPrefix + delete-by-prefix capabilities
   → verify: unit tests against the storage interface (mocked) + MinIO integration
4. Shared query filter: not-deleted scope helper applied to organizer/admin/public reads
   → verify: unit test the filter; integration test soft-deleted rows excluded
5. Soft-delete executors: deleteEventSoft(eventId) + deleteSubmissionSoft(token)
   → verify: integration test marks + S3 move; descendants cascade-marked
6. Hard-delete executor + cron sweep (shared): purge rows + S3 + de-identified audit
   → verify: integration test grace-period transition + completeness of purge
7. Frontend: organizer delete-event 2-click control; contributor self-service page
   → verify: 2-click enforcement; states/errors; branding; no leakage
8. Seed + tests + DoD → verify: lint/typecheck/test green; CI green
```

### What this unlocks

- **Story 19** imports the **same** `hardDeleteEvent(eventId)` executor and the **same**
  sweep loop. Story 19 only adds a *different soft-delete trigger* (the 30-day timer +
  reminder) and the retention-extension fields; it does not re-implement purge or sweep.

---

## 4. Frontend / UI Design

All copy follows `branding.md`: warm, confident, clear; **no exclamation marks in
transactional copy**; **honoree name spelled exactly as entered**; occasion-aware nouns;
title case for headings, sentence case for buttons; Lucide outline icons (20px); palette
tokens already wired (`bg-brand-ivory`, `text-brand-ink`, functional `--error` for the
destructive action). Deletion is destructive, so the tone is calm and explicit — never
alarmist, never an exclamation mark, but unmistakably clear about consequences.

### 4.1 Organizer — delete event (on the event detail page, Story 7 surface)

| Concern | Decision |
|---|---|
| Location | A clearly separated **"Danger zone"** section at the bottom of the organizer event-detail page (`/events/[id]`, owned by Story 3/7). Visually demarcated; never adjacent to benign actions |
| Control | A single **"Delete this event"** button, functional `--error` styling, outline-then-fill on the confirm step |
| Auth | Organizer session required; must own the event (§5.1) |

**2-click confirmation flow (click 1 → click 2):**

1. **Click 1 — "Delete this event"** opens a modal (not a navigation). The modal:
   - Heading: "Delete {HonoreeName}'s {occasion} tribute?"
   - Explicit destruction warning (occasion-aware, exact name), e.g.:
     > "This permanently removes everything for this tribute: every contributor's message,
     > all photos, videos, and voice notes, the AI script and storyboard, any final video,
     > and the share page. We move it out of view right away and delete it for good after
     > **72 hours**. This can't be undone after that window."
   - A summary line of what's affected so the consequence is concrete:
     "{N} submissions · {M} files · final video {yes/no}." (Counts come from the server;
     see §5.1.)
   - A **typed confirmation gate** to make click 2 deliberate: the organizer must type the
     honoree name (exact match, case-sensitive per `branding.md` §10 "name is sacred") OR
     the word **DELETE** into a field before the confirm button enables. (Default: type the
     honoree name; see §13 Q3.)
   - Buttons: **Cancel** (default focus) and **Delete permanently** (disabled until the
     typed gate matches).
2. **Click 2 — "Delete permanently"** invokes the server action (§5.1). On success the
   organizer is redirected to "My Events" with a calm confirmation banner:
   > "{HonoreeName}'s {occasion} tribute has been deleted. It'll be fully removed within 72
   > hours."
   The deleted event no longer appears in "My Events" (soft-deleted rows are excluded,
   §6.3).

> **Two distinct clicks, not one.** "2-click confirm" means the destructive action cannot
> fire from a single button press: click 1 reveals the warning + gate, click 2 (after the
> typed gate) commits. This is the pattern `architecture.md` §11.4 requires for both flows.

### 4.2 Contributor — self-service submission deletion (tokenized public page)

| Concern | Decision |
|---|---|
| Entry point | A **tokenized link** in the contributor's submission confirmation email (the email itself is Story 5/18; this story defines the link + the page it lands on) |
| Route | **`/submission/delete/[token]`** (public, no login). `[token]` is `Submission.deletionToken` (§5.2 token scheme) |
| Indexing | `noindex, nofollow` + `Referrer-Policy: no-referrer` (so the token never leaks via search/referrers — surprise integrity, §10) |
| Auth | **Possession of the unguessable token is the only credential** — no session, no email re-entry |

**Page render (GET `/submission/delete/[token]`):** the server resolves the submission by
`deletionToken` and renders **one of these states** (it must NOT leak event/honoree
details beyond the contributor's own submission — §10):

| State | Condition | Renders |
|---|---|---|
| **Confirm** | Token valid, submission not deleted | Confirmation panel (below) |
| **Already deleted** | Token valid but `deletedAt` already set | "This submission has already been deleted." Calm; no further action |
| **Invalid/expired** | No submission for token, or token hard-deleted/cleared | Generic "This link isn't valid." (identical-feeling to not-found; no enumeration signal) |

**Confirm panel (2-click on a public page):** because there is no second authentication
factor, the 2-click pattern here is **page → explicit confirm button**:

1. **Page load (click "into" via the email link = click 1)** shows:
   - Heading: "Delete your submission?"
   - **Minimal, contributor-scoped** context only — what the contributor themselves
     provided, so they recognize it: their own `contributorName`, the occasion noun, and a
     short summary of *their* content ("your message and 3 photos"). It must **not** show
     the honoree's name, other contributors, counts, the event title, or any event-wide
     data (§10). (See §13 Q4 on whether even the occasion noun is shown.)
   - Warning: "This permanently removes the message and any photos, videos, or voice notes
     you submitted. We remove it from view right away and delete it for good after **72
     hours**."
   - Buttons: **Keep my submission** (links away / closes) and **Delete my submission**.
2. **Click 2 — "Delete my submission"** invokes the server action (§5.2). On success render
   a success state in place:
   > "Your submission has been deleted. It'll be fully removed within 72 hours. Thank you
   > for letting us know."
   No re-deletion is possible (the token now resolves to **Already deleted**).

The page offers **no honoree contact**, no "view other submissions," no event link.

### 4.3 States & errors (both flows)

| State | Organizer modal | Contributor page |
|---|---|---|
| Loading | Spinner in modal; counts fetched server-side at render | Server-rendered; no client fetch needed |
| Success | Redirect + banner (§4.1) | Inline success (§4.2) |
| Not owner / not found (org) | Calm "We couldn't find that event." (no existence leak) | n/a |
| Invalid/expired token | n/a | "This link isn't valid." (generic) |
| Already deleted | Button hidden if event already soft-deleted (re-entry shows banner) | "Already deleted" state |
| Server error | "Something went wrong on our end. Please try again." (no partial UI claim) | same |
| Deadline/state irrelevant | Deletion is allowed **regardless of event status / pipeline stage** (see §13 Q7) | same — a contributor may delete any time their token is valid |

### 4.4 Responsive & branding
- Modal and public page are mobile-first; the public deletion page is a single calm column
  (~480px max), ivory background, ink text, the destructive button in `--error`.
- Co-brand "by Swara Media" footer lockup on the public page (`branding.md` §6).
- Signature gradient/gold is **not** used — deletion is functional, not celebratory.
- Accessibility: typed-gate field labeled + `aria-describedby` the warning; confirm button
  `aria-disabled` until gate matches; focus trapped in the modal; the destructive button is
  reachable and operable by keyboard; color is never the only signal (icon + text).

---

## 5. Backend / API Design

Two soft-delete entry points (organizer action; contributor token action) and one shared
hard-delete sweep. Prefer **Next.js Server Actions** for the two user-initiated operations
(project standard, `architecture.md` §5); a thin route handler is acceptable for the
contributor page's confirm if a non-action transport is preferred (the contracts below are
transport-agnostic). The **hard-delete sweep** runs in the worker process.

### 5.1 Organizer delete-event (soft-delete) action

| Property | Value |
|---|---|
| Operation | `deleteEvent(eventId)` (Server Action) — or `POST /api/events/[id]/delete` |
| Auth | Organizer session required; **must own the event** (`event.organizerId === session.userId`) |
| Idempotency | If the event is already soft-deleted, return success no-op (do not error, do not re-move S3) |

**Pre-render count helper (for the modal warning, §4.1):** a read
`getEventDeletionImpact(eventId)` (organizer-owned) returns `{ submissionCount,
mediaCount, hasFinalVideo }` over **not-deleted** descendants, so the modal can state the
concrete consequence. Ownership-enforced; returns not-found if not owned.

**Algorithm (authoritative order):**

1. **Authenticate + authorize.** No session → unauthorized; session but not owner →
   indistinguishable **not-found** (no existence leak across organizers, per
   `seq03-story03` §10).
2. **Resolve event** (must be not already soft-deleted; if `deletedAt` set → success
   no-op, step 7).
3. **Compute timestamps:** `now = server time (UTC)`; `hardDeleteAt = now + GRACE`
   (`GRACE` from config, default 72h — §7).
4. **Soft-delete in one DB transaction:**
   - Set `Event.deletedAt = now`, `Event.hardDeleteAt = hardDeleteAt`.
   - **Cascade-mark descendants** that carry soft-delete columns. In MVP 1 the only models
     with their own `deletedAt`/`hardDeleteAt` are `Event` and `Submission` (per
     `architecture.md` §11.4 schema additions). Therefore set the same
     `deletedAt`/`hardDeleteAt` on **all `Submission` rows for the event**. `MediaItem`,
     `AiArtifact`, `EditorAssignment`, `FinalVideo`, `SharePage` do **not** get their own
     soft-delete columns — they are scoped via their parent (`eventId`/`submissionId`) and
     are excluded from reads transitively (§6.3), then physically purged at hard delete via
     FK cascade (§6.4). (See §13 Q8 on whether to add soft-delete columns to those models;
     default: no — scope through the parent.)
   - The event `status` is **left unchanged**; "deleted" is expressed by `deletedAt`, not a
     new `EventStatus` value (avoids enum churn; see §13 Q9).
5. **Move S3 objects to `deleted/` prefix** (outside the DB transaction, after commit —
   storage is not transactional). Relocate everything under the event's prefix:
   `events/{eventId}/...` → `deleted/events/{eventId}/...` (§7.2). Use the storage
   interface's `moveToDeletedPrefix(prefix)` capability. This is **best-effort + idempotent
   + recorded**: if the move partially fails, the rows remain soft-deleted (hidden) and the
   sweep's hard delete will delete by the **original** prefix as a fallback (§5.3 step 4),
   so no object survives. Log per-object outcomes (counts, not URLs).
6. **Write audit** (de-identified, §11): `AuditLog` `action = "event.deleted.soft"`,
   `actorId = organizer userId`, `eventId`, `metadata = { hardDeleteAt, submissionCount,
   mediaCount, initiatedBy: "organizer" }` (no honoree name, no contributor PII).
7. **Write NotificationLog** retention marker (optional, §11) and **return success**.

**Status codes / results:**

| Case | Result |
|---|---|
| Success (soft-deleted) | `200` — `{ ok: true }`; UI redirects to My Events |
| Already soft-deleted | `200` — success no-op |
| Not authenticated | `401`-equivalent → redirect to sign-in |
| Authenticated, not owner / not found | `404`-equivalent (indistinguishable) |
| S3 move partial failure | Still `200` (rows hidden); failure logged + flagged for the sweep fallback (§5.3) |
| Unexpected error before commit | `500`-equivalent; nothing marked; safe message |

> **Note on no enqueue.** Soft-delete does not enqueue a hard-delete job per event. The
> hard delete is performed by the **scheduled sweep** (§5.3) that scans for rows past
> `hardDeleteAt`. This keeps a single, idempotent purge path shared with Story 19. (See
> §13 Q2 for an optional delayed-job alternative.)

### 5.2 Contributor delete-submission (soft-delete) action

| Property | Value |
|---|---|
| Operation | `deleteSubmissionByToken(token)` (Server Action / `POST /api/submission/delete`) |
| Auth | **Valid `deletionToken` only.** No session. No email re-entry |
| Scope | Soft-deletes **exactly one** `Submission` (the token's) + its `MediaItem`s. **Never** the event |
| Idempotency | If already soft-deleted, return the "already deleted" success state (no re-move) |

**Algorithm (authoritative order):**

1. **Resolve submission by `deletionToken`** (`@unique`). If none → generic invalid result
   (no enumeration; do not 500).
2. **Constant-time-ish token handling.** Look up by the unique column; do not branch
   timing on partial matches (token is high-entropy random, so timing is a minor concern,
   but treat unknown-token uniformly — §10).
3. **If already `deletedAt` set** → return "already deleted" success (step 7).
4. **Compute timestamps:** `now`; `hardDeleteAt = now + GRACE`.
5. **Soft-delete in one DB transaction:** set `Submission.deletedAt = now`,
   `Submission.hardDeleteAt = hardDeleteAt` on **that submission only**. Do **not** touch
   the parent `Event` or sibling submissions. `MediaItem`s are scoped through the
   submission (no own columns; excluded transitively, purged via cascade at hard delete).
6. **Move S3 objects** under that submission's prefix:
   `events/{eventId}/submissions/{submissionId}/...` →
   `deleted/events/{eventId}/submissions/{submissionId}/...` (§7.2), via the storage
   interface. Best-effort + idempotent + logged; sweep fallback deletes by original prefix
   if the move failed.
7. **Write audit** (de-identified): `AuditLog` `action = "submission.deleted.soft"`,
   `actorId = null` (system/anonymous; the contributor has no user id), `eventId` (for
   grouping), `metadata = { submissionId, hardDeleteAt, mediaCount, initiatedBy:
   "contributor" }`. **No** contributor name/email/IP in metadata.
8. **Write NotificationLog** retention marker with **hashed** recipient (§11) and return
   success.

**Status codes / results:**

| Case | Result |
|---|---|
| Success (soft-deleted) | `200` — inline success state |
| Already soft-deleted | `200` — "already deleted" success state |
| Invalid/unknown token | `404`-equivalent — generic "link isn't valid" (no leak) |
| S3 move partial failure | Still `200`; logged + sweep fallback |
| Unexpected error before commit | `500`-equivalent; nothing marked |

> **Token does not need the event to be "open."** A contributor may delete after the
> deadline, after routing, even after delivery — their right to delete is unconditional
> while the token is valid (§13 Q7). The only terminal state is hard delete (which clears
> the token, §5.3).

### 5.3 Hard-delete cron sweep (shared mechanism — Story 19 reuses)

| Property | Value |
|---|---|
| Where | Worker process (`src/workers/…`), registered following the Story 9/18 BullMQ + cron pattern |
| Trigger | Scheduled sweep — **runs hourly** (so a 72h grace is honored within ~1h granularity). (`reminders`-style low-priority queue, `architecture.md` §8.1; see §13 Q10 on cadence) |
| Idempotency | Every step is idempotent and safe to retry; jobs key off `hardDeleteAt < now` and on completion the rows no longer exist, so a re-run is a no-op |

**Sweep query (two row classes, both gated on the grace window):**

```
-- Events ready for hard delete
SELECT id FROM events
WHERE deletedAt IS NOT NULL
  AND hardDeleteAt <= NOW();

-- Submissions ready for hard delete that are NOT part of an event being hard-deleted
SELECT id, eventId FROM submissions
WHERE deletedAt IS NOT NULL
  AND hardDeleteAt <= NOW();
```

(When an event is hard-deleted, its submissions go with it via FK cascade — the sweep
de-duplicates so a submission already covered by an event purge isn't processed twice.)

**Per-event hard-delete executor — `hardDeleteEvent(eventId)` (the shared unit Story 19
calls):**

1. **Re-confirm** the event is still soft-deleted and `hardDeleteAt <= now` (guard against
   a race / a restore that cleared `deletedAt`).
2. **Delete S3 objects** under **both** the relocated `deleted/events/{eventId}/` prefix
   **and** the original `events/{eventId}/` prefix (fallback for a failed soft-delete
   move). Use storage `deletePrefix`. Records counts; idempotent (deleting an absent prefix
   is a no-op).
3. **Delete DB rows** in one transaction. Deleting the `Event` row **cascades** (FK
   `onDelete: Cascade`, `architecture.md` §7.1) to: `Submission` → `MediaItem`,
   `AiArtifact`, `EditorAssignment`, `FinalVideo`, `SharePage`. Verify via the cascade or
   explicit child deletes in dependency order (see §6.4 / §9 completeness test).
4. **Retain de-identified records:** `NotificationLog.eventId` is `onDelete: SetNull`
   (§7.1) so log rows survive with `eventId = null`; before/at purge, **hash** the
   `recipientEmail` on those rows (§11). `AuditLog.eventId` is `onDelete: SetNull` too;
   strip any PII from existing `AuditLog.metadata` for this event (§11). Write a final
   `AuditLog` `action = "event.deleted.hard"`, `actorId = null`, `eventId = null`
   (event is gone), `metadata = { formerEventIdHash, purgedSubmissions, purgedMedia,
   purgedAt }` (no plaintext id if we choose to hash it — §13 Q11).
5. **Done.** The event and all its data are irrecoverable.

**Per-submission hard-delete executor — `hardDeleteSubmission(submissionId)`:**

1. Re-confirm still soft-deleted and past grace.
2. Delete S3 objects under both `deleted/events/{eventId}/submissions/{submissionId}/` and
   the original submission prefix.
3. Delete the `Submission` row (cascades to its `MediaItem`s). The parent `Event` and
   siblings are untouched.
4. Retain de-identified `NotificationLog` (hash email) for that submission's
   confirmation/deletion notices; write `AuditLog` `action = "submission.deleted.hard"`,
   `actorId = null`, `metadata = { formerSubmissionIdHash, purgedMedia, purgedAt }`.

**Sweep-level contract:**

- Process events first, then submissions, skipping submissions whose `eventId` was just
  hard-deleted (covered by cascade).
- Each executor is wrapped so one failure doesn't abort the whole sweep (per-item
  try/catch + structured log + continue); failed items are retried next sweep (still past
  grace).
- **Story 19 reuse:** Story 19's retention sweep calls `hardDeleteEvent(eventId)` verbatim;
  it differs only in the *soft-delete trigger* (a 30-day timer + reminder sets
  `deletedAt`/`hardDeleteAt`) and the extension fields. No purge logic is duplicated.

### 5.4 Payloads (conceptual)

```
deleteEvent:               { eventId: string }            → { ok: true } | { ok:false, error }
getEventDeletionImpact:    { eventId: string }            → { submissionCount, mediaCount, hasFinalVideo }
deleteSubmissionByToken:   { token: string }              → { ok: true, alreadyDeleted?: boolean }
                                                            | { ok:false, error: "INVALID_TOKEN" }
hardDeleteEvent(eventId):  internal worker; returns { purgedSubmissions, purgedMedia, purgedObjects }
hardDeleteSubmission(id):  internal worker; returns { purgedMedia, purgedObjects }
```

---

## 6. Database Design

This story adds **only** the soft/hard-delete columns from `architecture.md` §11.4. It
does **not** add new tables or enums. All other models are owned by earlier stories.

### 6.1 `Event` — fields added this story

| Field | Type | Null? | Default | Notes |
|---|---|---|---|---|
| `deletedAt` | DateTime | **yes** | `null` | Soft-delete timestamp; non-null ⇒ excluded from normal queries (§6.3) |
| `hardDeleteAt` | DateTime | **yes** | `null` | When the sweep may purge; set to `deletedAt + GRACE` (72h) at soft-delete. Reused by Story 19 |

### 6.2 `Submission` — fields added this story

| Field | Type | Null? | Default | Notes |
|---|---|---|---|---|
| `deletionToken` | String | **yes** | — | **`@unique`**; the self-service deletion credential (§5.2 token scheme). Unguessable, URL-safe. See §13 Q1 on population point |
| `deletedAt` | DateTime | **yes** | `null` | Soft-delete timestamp (per-submission flow, or set en masse by the organizer event flow) |
| `hardDeleteAt` | DateTime | **yes** | `null` | `deletedAt + GRACE`; sweep purge gate |

**`deletionToken` population:** every contributor submission must have a non-null,
**unique** `deletionToken` so the email link works. Two viable points (see §13 Q1):
- (Preferred) Story 5 generates it at submission insert and the confirmation email embeds
  it; Story 20 only **adds the column + the page/action that consumes it** plus a
  one-time **backfill** for any pre-existing rows.
- (Fallback) Story 20 owns generation: add the column nullable, **backfill** all existing
  rows with a fresh token in the migration's data step, then the submit path (Story 5)
  must be updated to set it going forward.
This doc's default: **column + backfill here**, generation **at submit in Story 5**, with a
backfill safety net in this migration so no row is ever token-less.

### 6.3 Excluding soft-deleted rows from normal queries (filter pattern)

Soft-deleted data must vanish from every normal read while still existing physically until
hard delete. The pattern:

| Layer | Rule |
|---|---|
| **Canonical filter** | A shared helper provides the not-deleted predicate: for `Event` and `Submission` queries, always add `where: { deletedAt: null }` (and for descendants, scope through a not-deleted parent). Reads that must include deleted rows (the sweep, support tooling) **opt in** explicitly |
| **Organizer reads** | `listMyEvents`, `getEvent`, `getEventDeletionImpact` add `deletedAt: null` (a deleted event disappears from My Events immediately) |
| **Admin reads** (Story 7) | Admin event list / detail add `deletedAt: null` (deleted events drop off the admin dashboard during grace; support uses a separate path to see them — §13 Q5) |
| **Public reads** | `/contribute/[slug]` (Story 5) and any share page (Story 15) must treat a soft-deleted event as not-found (the contributor form for a deleted event shows the generic invalid state). The submission deletion page itself reads by token and is the **only** read that surfaces a (single) soft-deleted submission, and only as "already deleted" |
| **Descendant reads** | `MediaItem`, `AiArtifact`, etc. are read via their parent; a not-deleted-parent filter suffices since they lack own columns |
| **Implementation note** | Prefer a **single shared query-scope helper** (or Prisma middleware/extension applying `deletedAt: null` to `Event`/`Submission` find queries by default) so no read forgets the filter. If middleware is used, the sweep must use a raw/escape-hatch query to see deleted rows. (See §13 Q12.) |

> **Why not a Prisma global soft-delete extension only:** middleware that silently rewrites
> every query is convenient but easy to bypass for the sweep and confusing for `delete`
> semantics. This doc allows either an explicit shared `notDeleted` predicate **or**
> middleware, but **requires** that exactly one approach is used consistently and that the
> sweep has a documented escape hatch.

### 6.4 What hard-delete removes vs. retains

**Removed (purged) at hard delete** (`architecture.md` §11.4):

| Removed | How |
|---|---|
| `Event` row | Direct delete; cascades to children |
| `Submission` rows | FK `onDelete: Cascade` from `Event` (or direct, for the per-submission flow) |
| `MediaItem` rows | FK `onDelete: Cascade` from `Submission` |
| `AiArtifact` row | FK `onDelete: Cascade` from `Event` |
| `EditorAssignment` row | FK `onDelete: Cascade` from `Event` |
| `FinalVideo` rows | FK `onDelete: Cascade` from `Event` |
| `SharePage` row | FK `onDelete: Cascade` from `Event` |
| **All S3 objects** under the event/submission prefix | Storage `deletePrefix` over both `deleted/` and original prefixes (incl. `submissions/.../media/`, `artifacts/`, `editor-brief/`, `final/`, `share/`) |

**Retained (de-identified, for audit/compliance)** (`architecture.md` §11.4):

| Retained | De-identification |
|---|---|
| `NotificationLog` rows | `eventId → null` (FK `onDelete: SetNull`); `recipientEmail` **hashed** (§11) so no plaintext PII remains; keeps channel/trigger/status/sentAt |
| `AuditLog` rows | `eventId → null` (FK `onDelete: SetNull`); `metadata` **PII-stripped** (no honoree name, no contributor name/email/IP); keeps action + timestamps + non-PII counts |
| Stripe payment records | Stripe-side; we retain only the `stripeSessionId` reference, which is purged with the `Event` row — Stripe remains the system of record for the financial record (no in-app PII retained beyond the audit) |

### 6.5 Constraints, indexes, migration notes

| Item | Definition | Purpose |
|---|---|---|
| `Submission.deletionToken @unique` | unique index | Token lookup is O(1) and collision-free; backs `/submission/delete/[token]` |
| `@@index([deletedAt, hardDeleteAt])` on `Event` | composite index | Sweep query `WHERE deletedAt IS NOT NULL AND hardDeleteAt <= NOW()` is index-served |
| `@@index([deletedAt, hardDeleteAt])` on `Submission` | composite index | Same for the submission sweep |
| FK `onDelete: Cascade` (Event→Submission→MediaItem; Event→AiArtifact/EditorAssignment/FinalVideo/SharePage) | already defined by owning stories (`architecture.md` §7.1) | Hard-delete row purge by single `Event` delete |
| FK `onDelete: SetNull` (NotificationLog.eventId, AuditLog.eventId) | already defined (`architecture.md` §7.1) | De-identified retention survives the purge |

**Migration:** a single additive migration `add_user_initiated_deletion`:
- Adds the 5 columns (2 on `Event`, 3 on `Submission`) — all nullable, so **no downtime**.
- Adds the unique index on `deletionToken` and the two sweep indexes.
- **Data backfill step:** populate `deletionToken` for every existing `Submission` with a
  fresh unguessable token (so no historical submission is token-less). Run as part of the
  migration or an idempotent seed/backfill script. (If `deletionToken` is already populated
  by Story 5, the backfill only fills nulls.)
- Run with the project's pooled/direct-URL convention (`DATABASE_URL` runtime, `DIRECT_URL`
  for `prisma migrate`). `prisma generate` clean; `npm run typecheck` green.

---

## 7. External Services / Integrations / Config

### 7.1 S3 storage — `deleted/` prefix move + final purge

The storage service (Story 6's clean interface — the only module touching the S3 SDK)
gains the capabilities this story needs:

| Capability | Purpose | Used by |
|---|---|---|
| `moveToDeletedPrefix(sourcePrefix)` | Relocate every object under `events/{…}/…` to `deleted/events/{…}/…` (copy-then-delete, or rename where supported). Idempotent; reports counts | Soft-delete (§5.1/§5.2) |
| `deletePrefix(prefix)` | Permanently delete every object under a prefix (batched delete). Idempotent; absent prefix = no-op | Hard-delete sweep (§5.3) |
| `listPrefix(prefix)` | Enumerate keys under a prefix (paged) to drive move/delete | move/delete helpers |

**Prefix layout (from `architecture.md` §7.2):**

```
swara-magical/
  events/{event_id}/...                      # live data (submissions, artifacts, final, share)
  deleted/                                    # soft-deleted, awaiting hard delete
    events/{event_id}/...                     #   moved here on soft-delete
    events/{event_id}/submissions/{sub_id}/...#   single-submission moves land here too
```

- **Soft-delete move:** event flow moves `events/{eventId}/` → `deleted/events/{eventId}/`;
  contributor flow moves `events/{eventId}/submissions/{submissionId}/` →
  `deleted/events/{eventId}/submissions/{submissionId}/` (a sub-tree move).
- **Versioning interaction (`architecture.md` §11.3):** the `final/` and `submissions/`
  prefixes have S3 **versioning** enabled. `deletePrefix` at hard delete must delete **all
  versions + delete markers** (not just create a delete marker) so the bytes actually go.
  (See §13 Q13.)
- Objects stay **private ACL** throughout (`architecture.md` §7.2).

### 7.2 Cron / worker

- The hard-delete sweep is a scheduled job in the worker process (Story 9/18 host). It uses
  the **`reminders`-style low-priority queue** (`architecture.md` §8.1) or an equivalent
  scheduled trigger. Default cadence **hourly** (§5.3). On Vercel-only deployments before
  the worker host exists, a **Vercel Cron** → an internal authenticated route that invokes
  the same executor is the fallback (§13 Q2).

### 7.3 Email (contributor link)

- This story **does not send** the confirmation email; it defines the **link** the email
  must contain: `{config.app.publicUrl}/submission/delete/{deletionToken}` and the page +
  action that consume it. The email body/send is Story 5/18 (`seq04-story05` §7). The link
  builder is a small shared helper (`buildSubmissionDeletionUrl(token)`) so Story 5/18 and
  this page agree on the exact path.

### 7.4 Config (add to BOTH files, per convention)

Add to **`src/config/env.ts`** (raw reads) and **`src/config/index.ts`** (typed Zod), with
sensible defaults so the story works without new ops setup:

| Env var | Type | Default | Used for | Notes |
|---|---|---|---|---|
| `DELETION_GRACE_HOURS` | int | `72` | Grace window: `hardDeleteAt = deletedAt + this` (§5.1/§5.2) | The 72h from `architecture.md` §11.4; tunable. **Story 19 reads the SAME var** for its post-soft-delete grace, keeping one source of truth |
| `DELETION_SWEEP_CRON` | string | `"0 * * * *"` (hourly) | Sweep schedule (§5.3) | Optional; default hourly |
| `DELETION_TOKEN_BYTES` | int | `32` | Entropy of `deletionToken` (§5.2 / §10) | 32 random bytes → URL-safe base64; matches the 32-byte standard used for share tokens (`architecture.md` §10.1) |

- Both vars added to `src/config/env.ts` `rawEnv` AND the `ConfigSchema`/mapping in
  `src/config/index.ts`. Update `.env.example`. No `process.env` outside `src/config/env.ts`
  (ESLint `no-restricted-syntax`, Story 1).
- **No new external account** is introduced (S3, Redis, the worker host already exist from
  Stories 6/9).

---

## 8. Seed Data

Extend the existing idempotent seed (Stories 3/5/6) so all deletion paths are manually
verifiable locally.

For the seeded `ACTIVE` event (e.g. slug `riyas-graduation`) and its submissions:

1. **Every seeded submission gets a deterministic, unique `deletionToken`** (a fixed,
   recognizable dev value per submission, e.g. derived from a stable seed id) so the
   self-service link can be exercised without sending email. Print the local deletion URLs
   in seed output for convenience.
2. **One submission already soft-deleted, awaiting hard delete:** create a submission with
   `deletedAt = now - 1h` and `hardDeleteAt = now + 71h` (still inside grace) so the
   "Already deleted" page state and the query-exclusion can be verified, **and** its dummy
   S3 objects placed under the `deleted/events/.../submissions/.../` prefix to mirror a real
   soft-delete move.
3. **One submission soft-deleted and PAST grace** (`deletedAt = now - 80h`,
   `hardDeleteAt = now - 8h`) so a manual sweep run hard-deletes exactly it (and leaves the
   others), exercising the sweep's grace gate and de-identified retention.
4. (Optional) **One whole event soft-deleted** (`Event.deletedAt`/`hardDeleteAt` set, all
   its submissions cascade-marked) to verify it disappears from My Events / admin while its
   `NotificationLog`/`AuditLog` stay.
5. Seed remains **idempotent** (upsert by stable ids / tokens); re-running does not
   duplicate rows, tokens, or S3 dummy objects.

---

## 9. Testing

Follows Story 1's pattern (Vitest, `tests/unit` + `tests/integration`,
`vite-tsconfig-paths`). Integration tests touching DB/MinIO are gated by **`SKIP_INTEGRATION`**.

### 9.1 Unit (no infra; pure logic)

| Test | Asserts |
|---|---|
| Token generation | `deletionToken` is URL-safe, ≥ `DELETION_TOKEN_BYTES` entropy, unique across many generations |
| Token validation/scope | A valid token resolves to exactly one submission; an unknown/garbled token yields the generic invalid result; a hard-deleted token (cleared row) is invalid |
| Grace-window math | `hardDeleteAt == deletedAt + DELETION_GRACE_HOURS` at boundaries (exactly-at, +1s) |
| Soft→hard transition timing | Given `now`, the sweep predicate selects rows with `hardDeleteAt <= now` and excludes `hardDeleteAt > now` (just-before/at/after) |
| Query-exclusion filter | The shared `notDeleted` predicate excludes `deletedAt != null` rows; opt-in include returns them |
| 2-click enforcement | The organizer confirm gate (typed name/"DELETE") only enables the action when matched; a single click does not fire deletion |
| Deletion-URL builder | `buildSubmissionDeletionUrl(token) == {publicUrl}/submission/delete/{token}` |
| What-gets-purged completeness | Given the model graph, the purge plan covers `Event, Submission, MediaItem, AiArtifact, EditorAssignment, FinalVideo, SharePage` (+ both S3 prefixes) and **retains** `NotificationLog`/`AuditLog`; a snapshot/contract test flags any new model added later that isn't classified purge-or-retain |
| De-identification | Email-hash function is deterministic + non-reversible-shaped (salted hash); audit metadata builder emits no PII fields |

### 9.2 Integration (DB + MinIO; `SKIP_INTEGRATION` guards)

| Test | Flow |
|---|---|
| Organizer delete cascades + S3 move | Soft-delete an event → `Event.deletedAt` + all `Submission.deletedAt` set; `hardDeleteAt = +72h`; objects relocated under `deleted/events/{id}/`; event absent from `listMyEvents`/admin reads |
| Ownership enforcement | Organizer B cannot delete A's event (indistinguishable not-found); no rows marked |
| Contributor token delete (scoped) | Valid token soft-deletes **only** that submission + its media (S3 sub-tree moved); the event and sibling submissions untouched; sibling still visible to admin |
| Token cannot widen scope | A submission's token deletes its own submission only; attempting to reuse another submission's data is impossible (token maps 1:1) |
| Grace-period hard delete | Advance a soft-deleted row past `hardDeleteAt` (or seed it past) → run the sweep → DB rows purged (incl. cascade children), S3 prefix empty (all versions gone), `NotificationLog` survives with `eventId=null` + hashed email, `AuditLog` survives PII-stripped + a `*.deleted.hard` row written |
| Sweep grace gate | A row still inside grace is **not** purged by the sweep; a past-grace row in the same run **is** |
| Sweep dedup | An event hard-delete that cascades its submissions does not double-process those submissions in the same sweep |
| Soft-delete move failure fallback | Simulate a failed S3 move on soft-delete (rows still hidden) → sweep hard-delete still deletes by the **original** prefix so no object survives |
| Idempotent re-delete | Re-invoking soft-delete on an already-soft-deleted event/submission is a success no-op (no second S3 move, no duplicate audit) |
| Public read treats deleted as not-found | `/contribute/[slug]` for a soft-deleted event renders the generic invalid state |

### 9.3 Mocking
- **Unit** mocks the storage interface (`moveToDeletedPrefix`, `deletePrefix`, `listPrefix`)
  and the clock; no SDK/network.
- **Integration** uses the real MinIO container (bucket `swara-magical-test`) and `swara_test`
  DB; gated by `SKIP_INTEGRATION` (mirror Story 1 CI services pattern).

---

## 10. Security & Surprise Integrity

| Concern | Control |
|---|---|
| **Organizer ownership** | `deleteEvent` and `getEventDeletionImpact` require an authenticated organizer session and `event.organizerId === session.userId`; non-owner ⇒ indistinguishable not-found (no existence leak across organizers, `seq03-story03` §10) |
| **Contributor token unguessable** | `deletionToken` is **32 random bytes**, URL-safe-encoded (matches the 32-byte share-token standard, `architecture.md` §10.1). Not derived from email/name (no enumeration). `@unique` |
| **Token scoped to one submission** | The token maps 1:1 to a single `Submission`; the action soft-deletes only that row + its media; it can never affect the event or other submissions |
| **No leakage of other submissions / honoree** | The self-service page shows **only** the contributor's own data (their name + their content summary). It does **not** render the honoree name, event title, other contributors, counts, or any event-wide info (§4.2). The token never appears in server logs (URL logged as `/submission/delete/[redacted]`, mirroring share-token redaction §10.1) |
| **Surprise integrity** | The deletion page is `noindex, nofollow` + `Referrer-Policy: no-referrer`; it never offers honoree contact and sends no honoree communication. Deleting data cannot trigger any honoree-facing message |
| **No re-deletion / replay harm** | Idempotent soft-delete; a replayed token confirm shows "already deleted", causing no additional effect |
| **Audit retention is de-identified** | Hard delete strips PII from retained `AuditLog`/`NotificationLog` (hash email; no names/IPs in metadata) so retained records can't re-identify the deleted person (§11) |
| **CSRF** | Server Actions are origin-checked by Next.js; the contributor confirm is a same-origin POST from the rendered page |
| **Destructive-action friction** | 2-click + typed gate (organizer) and explicit second click (contributor) prevent accidental/one-click deletion |
| **Hard delete actually destroys bytes** | `deletePrefix` removes all S3 object **versions + delete markers** on versioned prefixes (§7.1), so versioning can't silently retain deleted media |

---

## 11. Observability / Audit

`AuditLog` (schema present from Story 3) records deletion lifecycle events **without PII**:

| Event | `action` | `actorId` | `eventId` | `metadata` (no PII) |
|---|---|---|---|---|
| Organizer soft-delete | `event.deleted.soft` | organizer userId | eventId | `{ hardDeleteAt, submissionCount, mediaCount, initiatedBy:"organizer" }` |
| Contributor soft-delete | `submission.deleted.soft` | `null` | eventId | `{ submissionId, hardDeleteAt, mediaCount, initiatedBy:"contributor" }` |
| Event hard-delete | `event.deleted.hard` | `null` | `null` (event gone) | `{ formerEventIdHash, purgedSubmissions, purgedMedia, purgedObjects, purgedAt }` |
| Submission hard-delete | `submission.deleted.hard` | `null` | `null` | `{ formerSubmissionIdHash, purgedMedia, purgedObjects, purgedAt }` |

- **No honoree name, no contributor name/email/IP** ever enters `AuditLog.metadata`.
- At hard delete, **pre-existing** `AuditLog` rows for the event have their `eventId` set
  null (FK `SetNull`) and any PII in their `metadata` stripped/redacted.

**`NotificationLog` retention** (`architecture.md` §11.4):
- Rows survive hard delete with `eventId → null` (`onDelete: SetNull`).
- `recipientEmail` is **hashed** (salted, one-way) so the audit trail of "a notification
  was sent" is kept without retaining the address. Channel/trigger/status/`sentAt` remain.
- The hashing scheme: a keyed/salted hash (e.g. HMAC with a server secret) so emails can't
  be brute-forced from the small address space (see §13 Q11 for the secret source).

**Structured logs** (`src/lib/logger.ts`):
- Soft-delete: log `eventId`/`submissionId`, initiator type, `hardDeleteAt`, S3 move counts
  — **never** the token, never raw email/IP, never object URLs.
- Sweep run: log counts (events/submissions purged, objects deleted), durations, per-item
  failures (id + reason, no PII). A spike in sweep failures is the alert signal.

---

## 12. Definition of Done

Story 20 is **done** only when ALL are true:

- [ ] `prisma/schema.prisma` adds `Event.deletedAt`/`hardDeleteAt` and
      `Submission.deletionToken @unique`/`deletedAt`/`hardDeleteAt` exactly per §6; migration
      `add_user_initiated_deletion` created + applied (dev/test/prod), with the
      `deletionToken` backfill so no submission is token-less; `prisma generate` clean.
- [ ] Sweep indexes (`[deletedAt, hardDeleteAt]` on both models) + `deletionToken` unique
      index present.
- [ ] Config `DELETION_GRACE_HOURS` (default 72), `DELETION_SWEEP_CRON`,
      `DELETION_TOKEN_BYTES` added in **both** `src/config/env.ts` and
      `src/config/index.ts` (+ `.env.example`); no `process.env` outside `src/config/env.ts`.
- [ ] Storage interface gains `moveToDeletedPrefix` + `deletePrefix` (+ `listPrefix`);
      reads only `config.storage`; works against MinIO; deletes all versions on versioned
      prefixes.
- [ ] Organizer event-detail page has a Danger-zone **Delete this event** control with a
      **2-click** confirm (warning of exactly what's destroyed, concrete counts, typed gate);
      single click never deletes.
- [ ] `deleteEvent` authorizes ownership, soft-deletes the event + cascade-marks all
      submissions, sets `hardDeleteAt = +GRACE`, moves S3 to `deleted/`, writes
      de-identified audit; idempotent on re-delete; deleted event disappears from
      organizer + admin reads immediately.
- [ ] Contributor self-service page `/submission/delete/[token]` renders Confirm /
      Already-deleted / Invalid states with **no** event/honoree leakage; `noindex` +
      `no-referrer`; 2-click confirm; `deleteSubmissionByToken` soft-deletes only that
      submission + its media + S3 sub-tree; idempotent.
- [ ] Hard-delete cron sweep runs on schedule, purges past-grace rows (DB cascade + both S3
      prefixes, all versions), retains `NotificationLog` (hashed email) + `AuditLog`
      (PII-stripped) with `eventId=null`, writes `*.deleted.hard` audit; **per-event
      executor `hardDeleteEvent` is structured so Story 19 calls it unchanged**.
- [ ] Soft-deleted rows excluded from all normal queries via one consistent filter pattern;
      the sweep has a documented escape hatch to see them.
- [ ] Seed creates submissions with deletion tokens, one soft-deleted-within-grace record,
      and one past-grace record; idempotent; prints local deletion URLs.
- [ ] Unit + integration tests (§9) pass; integration honors `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; deploy succeeds.
- [ ] No TODO comments in committed code; `docs/stories.md` Story 20 row marked done.

---

## 13. Open Questions / Assumptions

| # | Question / Assumption | This doc's default | Needs confirmation? |
|---|---|---|---|
| Q1 | **Where is the `deletionToken` generated and the confirmation email sent?** Story 5 design defers both the confirmation email and the `deletionToken` to Story 20 (`seq04-story05` §2, §7), but `architecture.md` §11.4 puts the token on `Submission` and the email is a Story 5/18 concern. | **Column + backfill here**; **token generated at submit in Story 5** (the cleanest origin); the confirmation **email send** is Story 5/18 and must embed `buildSubmissionDeletionUrl(token)`. Story 20 owns the page + action + the safety-net backfill. | **Yes** — confirm the generation point so Story 5 sets the token and the email links it |
| Q2 | **Is the worker/cron host available when Story 20 ships?** `stories.md` deps are only 5 & 7; Story 9/18 add the worker + cron. | Soft-delete works immediately (DB + S3). If no worker host yet, run the hard-delete via a **Vercel Cron → authenticated internal route** invoking the same executor, swapped to the BullMQ sweep once Story 9/18 land. | **Yes** — confirm host timing |
| Q3 | **Organizer typed-gate value:** type the honoree name vs the word "DELETE"? | Type the **honoree name** (most specific, hardest to fat-finger) — falls back to "DELETE" if name has tricky characters. | Low stakes — confirm preference |
| Q4 | **How much context on the contributor deletion page?** Showing the occasion noun aids recognition but is more than zero. | Show the contributor's **own** name + their content summary + the occasion **noun** (e.g. "graduation") — never the honoree name or event title. | **Yes** — confirm the occasion noun is acceptable (it is mild; if stricter, show only "your submission") |
| Q5 | **Restore within the 72h grace window?** | **No self-service restore** in MVP 1; data is recoverable only via support/DB during grace (rows still exist, S3 under `deleted/`). A self-service un-delete is a future story. | Confirm support-only restore is acceptable |
| Q6 | **Does organizer deletion trigger a Stripe refund?** | **No** — deletion is a data-rights action, not a refund. Refund policy is separate (Story 4 / ops). | Confirm |
| Q7 | **Is deletion allowed mid-pipeline / after delivery?** | **Yes, unconditionally** — both organizer (any `EventStatus`) and contributor (any time the token is valid) may delete; the right to delete is not gated on pipeline stage. In-flight worker jobs for purged data become no-ops (their rows vanish; jobs are idempotent and tolerate missing inputs). | **Yes** — confirm no stage restriction (and that in-flight encode/AI jobs are tolerant) |
| Q8 | **Add soft-delete columns to descendant models** (MediaItem/AiArtifact/…) vs scope through parent? | **Scope through parent** (only `Event` + `Submission` carry the columns, per `architecture.md` §11.4); descendants excluded transitively and purged via cascade. | Confirm (default matches §11.4 schema) |
| Q9 | **Express "deleted" as a new `EventStatus` value vs `deletedAt` only?** | **`deletedAt` only**; no new enum value (avoids enum churn; status is preserved for audit). | Confirm |
| Q10 | **Sweep cadence** — hourly vs daily? | **Hourly** (72h grace honored within ~1h). Daily is acceptable if worker cost matters (grace then effectively 72–96h). | Confirm |
| Q11 | **Hashing scheme for retained logs** (and whether to hash former ids in audit). | **Salted/keyed one-way hash (HMAC with a server secret)** for `recipientEmail` and any former-id we choose to keep; the secret comes from config (e.g. reuse `NEXTAUTH_SECRET` or a dedicated `LOG_HASH_SECRET`). | **Yes** — confirm the secret source (recommend a dedicated `LOG_HASH_SECRET`) |
| Q12 | **Soft-delete filter mechanism:** explicit shared `notDeleted` predicate vs Prisma middleware/extension applied globally. | Allow either, but use **exactly one** consistently; if middleware, the sweep uses a documented escape hatch. Default recommendation: explicit shared predicate (clearer for `delete`/sweep semantics). | Confirm preference |
| Q13 | **Versioned-prefix deletion at hard delete.** `final/` + `submissions/` have S3 versioning (`architecture.md` §11.3). | `deletePrefix` must remove **all versions + delete markers** so bytes are truly gone (a delete marker alone would retain them until lifecycle expiry). | **Yes** — confirm versioned hard delete is required for compliance |
| Q14 | **Does the contributor deletion email link expire?** | **No fixed expiry in MVP 1** — the token is valid until the submission is hard-deleted (which clears it). The data lifecycle (retention/right-to-delete) bounds it. | Confirm (an expiry could be added later) |
