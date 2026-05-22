# Sequence 06 / Story 8 — Submission Approval (Approve / Reject)

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (route/action signatures, payload shapes, status-transition matrix, authz rules,
audit-entry shapes, error cases) so later code generation is unambiguous. Where a value is a
proposal awaiting confirmation it is flagged **[CONFIRM]** and tracked in §13.

| Field | Value |
|---|---|
| Story number / title | Story 8 — Submission approval (approve / reject) |
| Epic | D — Admin Operations (Basic) |
| Sequence number | 6 (this is the 6th design in build order) |
| Depends on | Story 7 (Admin dashboard — read-only: admin role gating, event list, per-event detail with submission view) |
| Parallel with | — |
| Unlocks | Story 12 (routing analyzer consumes APPROVED submissions), Story 13/16 (manual brief + AI pipeline operate on approved media) |
| Complexity | S (0.5–1 day) |

> **Note on the Story 7 source.** `docs/design/seq05-story07-admin-dashboard-readonly.md`
> does **not** exist in the repo at the time of writing (only `seq02`–`seq05` designs are
> present). This document therefore takes the admin auth model, the `/admin/events/[id]`
> detail route, and the per-submission display contract from `architecture.md` §5.5/§10.2 and
> `requirements.md` §5.5, and is written to extend that consistently. If the Story 7 design
> lands first and diverges (route path, auth helper name, submission-row component), reconcile
> §4/§5 against it before generating code (flagged §13 Q1).

---

## 1. Story Summary

Story 7 gives Swara Admins a read-only dashboard: an event list and a per-event detail page at
`/admin/events/[id]` that lists each submission with its contributor, media, and current
`status` badge. Story 8 makes that detail page **actionable**: an admin can change an individual
submission's `status` — **approve** or **reject**, and (optionally) **flag** — and attach an
optional free-text note. Each decision is persisted to `Submission.status` + `Submission.adminNote`
and recorded as an immutable `AuditLog` entry capturing who acted, on what, and what changed.

This is the smallest possible vertical slice that turns the read-only dashboard into a review
tool. It introduces:

- A single **status-change server action** (admin-only) with a defined, validated transition
  matrix.
- The **`AuditLog`** model (defined in `architecture.md` §7.1 but not yet in the live schema —
  see §6) introduced here, since this is the first admin write action that must be audited.
- Per-submission **approve / reject (/ flag)** controls and optional note input on the
  `/admin/events/[id]` detail page, with optimistic status-badge updates and error handling.

What this story is **not**: it does not do bulk actions, does not do AI routing (Story 12), does
not auto-flag from a quality pipeline (Story 9+), and does not change any other admin surface.

---

## 2. Scope

### In scope

- **Per-submission status change by an admin**: APPROVE, REJECT, and (optionally) FLAG, each with
  an **optional** `adminNote`.
- A **server action** (App Router Server Action) that performs the change, scoped admin-only,
  with an explicit allowed-transition matrix (§5.3).
- Writing `Submission.status` **and** `Submission.adminNote` atomically with an `AuditLog` row in
  one DB transaction.
- **`AuditLog` model + migration** (introduced this story; matches `architecture.md` §7.1).
- UI controls on `/admin/events/[id]`: approve / reject / flag buttons per submission, optional
  note input, live status-badge update, confirmation + optimistic states, error states.
- **Re-changes** — an admin may correct a prior decision (e.g. REJECTED → APPROVED). The matrix
  in §5.3 defines exactly which transitions are allowed.
- Authz: admin-only (NextAuth Google OAuth, `role=ADMIN`, allowlisted domain — `architecture.md`
  §10.2), plus event/submission scope checks (the submission must belong to a real event).
- Audit-entry action names + metadata shape (§11).
- Seed data: submissions in `PENDING` and `FLAGGED` for an event to act on; an `ADMIN` actor user.
- Unit + integration tests (§9), gated by `SKIP_INTEGRATION`.

### Out of scope (deferred)

| Item | Where it lands |
|---|---|
| **Bulk approve/reject** (multi-select, "approve all") | Future (flagged §13 Q6) |
| **AI / routing** decision (AI vs MANUAL) and its `routing.approved`/`routing.switched` audit actions | Story 12 |
| **Auto-flagging** by the quality pipeline (`qualityScore < 40` → FLAGGED, `< 20` → auto-reject) | Story 9 (writes `FLAGGED` from the worker; see §13 Q3) |
| **Admin viewing/downloading media** (presigned GET) | Story 7 |
| **Export** of approved media / script / CSV | Story 7 / 13 |
| **Editing submission content** by admin | Out of MVP 1 |
| **Notifying the contributor** of approval/rejection | Out of MVP 1 (surprise integrity — see §10; flagged §13 Q5) |
| **Read-only dashboard, event list, detail layout, role gating helper** | Story 7 (consumed here, not built) |

---

## 3. Dependencies & Sequence

**Must already be on `main`:**

- **Story 1 (Foundation):** typed `config` module (`src/config/env.ts` + `src/config/index.ts`),
  Prisma client singleton (`src/lib/db.ts`), logger (`src/lib/logger.ts`), CI, `SKIP_INTEGRATION`
  test convention.
- **Story 2 (Organizer auth):** NextAuth wired; `User.role` (`Role { ORGANIZER ADMIN }`) exists
  in the schema (it does — current `prisma/schema.prisma`).
- **Story 5 (Contributor text submission):** `Submission` model with `status SubmissionStatus`
  (`PENDING APPROVED REJECTED FLAGGED`, default `PENDING`) and `adminNote String?` — both already
  specified there and in `architecture.md` §7.1.
- **Story 7 (Admin dashboard read-only):** Google-OAuth admin auth + role gating helper, the
  `/admin/events/[id]` page, and the per-submission display (status badge + contributor + media).

> **Dependency flags.**
> 1. As of writing, the live `prisma/schema.prisma` contains **only** the `User` model + `Role`
>    enum. This design assumes Stories 3/5/7 land `Event`, `Submission`, and `SubmissionStatus`
>    exactly as in `architecture.md` §7.1 before this migration applies. If field/enum names
>    differ, reconcile §6 against the merged schema first.
> 2. The **admin role-gating mechanism** (the helper/middleware that asserts a request is an
>    authenticated `ADMIN`) is owned by **Story 7**. Story 8 **reuses** it; it does not redefine
>    it. If Story 7 has not landed a reusable guard, Story 8 must add a minimal one consistent
>    with `architecture.md` §10.2 and flag it (§13 Q1).

**Provides to later stories:**

- The **`AuditLog`** table + the write-audit helper become the audit substrate reused by
  Story 12 (`routing.approved` / `routing.switched`), Story 14 (editor review), and Story 20
  (deletion audit).
- An accurate `Submission.status` is the **input contract** for Story 12's routing analyzer and
  for Story 13/16 (only `APPROVED` submissions are included in the brief / AI pipeline). See §13 Q4
  on whether downstream consumes `APPROVED` only or `APPROVED` ∪ `PENDING`.

---

## 4. Frontend / UI Design

Extends the existing `/admin/events/[id]` detail page (Story 7). All copy follows `branding.md`
§3/§10 (calm, confident, sentence-case buttons, **no exclamation marks** in transactional copy).
This surface is **admin-only and authenticated** — not subject to the contributor-facing
`noindex` rules, though admin routes should not be indexed either (Story 7 concern).

### 4.1 Where the controls live

Per-submission, inside each submission row/card on `/admin/events/[id]` (the read-only layout
Story 7 renders). No new route is introduced. Each submission card gains an **action region**:

| Element | Behavior |
|---|---|
| Status badge | Shows current `status` (PENDING / APPROVED / REJECTED / FLAGGED). Color-coded per §4.3. Updates live after a successful action. |
| Approve button | Sets status → `APPROVED`. Primary accent (`--brand-deep-saffron`). |
| Reject button | Sets status → `REJECTED`. Secondary / destructive-tinted (`--error` outline). |
| Flag button | Sets status → `FLAGGED`. Warning-tinted (`--warning`). **[CONFIRM] include in MVP** — see §13 Q2. |
| Optional note input | Single multi-line text field ("Add a note (optional)"), bound to that submission. Sent as `adminNote` with the action. |
| Existing note display | If `adminNote` is already set, show it (read-only) above the input, with a hint that submitting a new note replaces it (§5.3). |

The action that matches the **current** status is shown as the **active/selected** state (e.g. an
already-`APPROVED` submission shows Approve as selected); the buttons remain clickable to allow a
re-change (REJECT it, FLAG it). Disallowed transitions (§5.3) are rendered **disabled** with a
tooltip rather than failing on submit.

### 4.2 Note input semantics

- The note is **always optional** for every action (approve, reject, flag). An empty/whitespace
  note is treated as "no note provided" and is **not** written (leaves any prior `adminNote`
  unchanged — see §5.3 for the exact write rule, flagged §13 Q7).
- Max length **2000** characters **[CONFIRM]**, enforced client-side (advisory) and server-side
  (authoritative).
- Plain text only; rendered escaped wherever shown (no HTML execution).

### 4.3 Status badges (color tokens, `branding.md` §4)

| Status | Label | Token |
|---|---|---|
| `PENDING` | "Pending" | `--neutral-500` (neutral) |
| `APPROVED` | "Approved" | `--success` (`#15803D`) |
| `REJECTED` | "Rejected" | `--error` (`#B91C1C`) |
| `FLAGGED` | "Flagged" | `--warning` (`#D97706`) |

Color is never the only signal — each badge pairs an icon (Lucide outline, `branding.md` §8) with
the label text (accessibility, §4.6).

### 4.4 Interaction / optimistic + confirmation states

| State | Trigger | UI |
|---|---|---|
| **Idle** | Default | Buttons enabled per the allowed-transition matrix; badge shows current status. |
| **Confirm (reject only)** | Click Reject | Lightweight inline confirm ("Reject this submission?") with Confirm / Cancel. Approve and Flag do **not** require a confirm step (low-stakes, reversible). **[CONFIRM]** confirm-on-reject vs no-confirm — §13 Q8. |
| **Pending (optimistic)** | Action submitted | Badge optimistically switches to the target status; action buttons disabled with a subtle spinner; note input locked. |
| **Success** | Server confirms | Optimistic badge confirmed; a brief, calm toast/inline note ("Submission approved."); note input cleared/collapsed; existing-note display refreshed. |
| **Error** | Server rejects (see §5.5) | Optimistic change **reverted** to the prior status; an inline error message below the row (calm voice, §4.5); buttons re-enabled. No partial UI state. |

Optimistic update is purely visual; the **server is authoritative** (§5). The page revalidates the
submission's state after the action resolves (App Router `revalidatePath`/router refresh, or the
action returns the updated row to swap in — see §5.4).

### 4.5 Error copy (admin-facing, calm voice)

| Case | Message |
|---|---|
| Not found / stale | "This submission could not be found. Refresh and try again." |
| Forbidden (shouldn't reach UI) | "You don't have access to do that." |
| Invalid transition | "That status change isn't allowed from the current state." |
| Validation (note too long) | "Notes must be under 2000 characters." |
| Unexpected | "Something went wrong. Try again." |

### 4.6 Accessibility & branding

- Buttons are real `<button>`s with discernible accessible names ("Approve submission from
  {contributorName}"); status badge text is readable to screen readers (not color-only).
- The action result is announced via an `aria-live="polite"` region.
- Disabled (disallowed) buttons expose the reason via `aria-disabled` + tooltip text.
- Keyboard-operable end to end; visible focus states.
- Fonts/palette per `branding.md` §4/§5 (already wired in `src/app/layout.tsx`). Signature
  gradient is **not** used here (reserved for hero/delivery moments).

---

## 5. Backend / API Design

One server-side entry point: a **status-change Server Action** invoked from the submission card.
No REST route is required (App Router Server Action, consistent with the project's "Server Actions
handle form submissions without writing API routes", `architecture.md` §5). If a thin JSON route
is ever wanted for non-browser callers, the same contract and status codes (§5.5) apply.

### 5.1 Action signature & inputs

| Concern | Decision |
|---|---|
| Mechanism | Next.js **Server Action** (e.g. `changeSubmissionStatus`), co-located with the admin detail page |
| Auth | **Admin-only** — must be an authenticated `User` with `role = ADMIN` (and allowlisted domain, `architecture.md` §10.2). Reuses the Story 7 guard (§3) |
| Mutation kind | Single submission, single status transition + optional note |

**Inputs (conceptual; validated with a Zod schema, project convention, importable by tests):**

| Field | Type | Required | Notes |
|---|---|---|---|
| `submissionId` | string (cuid) | yes | The submission to act on |
| `newStatus` | enum `APPROVED` \| `REJECTED` \| `FLAGGED` | yes | Target status. `PENDING` is **not** an accepted target (you cannot manually "un-decide" — see §13 Q9) |
| `adminNote` | string | no | Optional; trimmed; ≤2000 chars; empty/whitespace ⇒ treated as absent |

The action does **not** accept `actorId` from the client — the actor is derived **server-side**
from the authenticated session (never trust a client-supplied identity).

### 5.2 Algorithm (authoritative order)

1. **AuthN/AuthZ.** Resolve the session. If no session or `role != ADMIN` (or domain not
   allowlisted) → **forbidden** (E2). Nothing read or written.
2. **Validate input** (§5.1 Zod schema). On failure → **validation error** (E4). Nothing written.
3. **Load the submission** by `submissionId`, joined to its `Event` (need `eventId` for the audit
   row and for scope). If not found → **not found** (E1).
4. **Scope check.** The submission must belong to an existing event (the join in step 3 confirms
   this). Admins are global (not per-event-owner), so there is no per-event ownership gate — but
   the action MUST refuse a `submissionId` that resolves to no event. (Belt-and-braces against a
   dangling row.)
5. **Transition check.** `(currentStatus → newStatus)` must be in the allowed matrix (§5.3). If
   not → **invalid transition** (E3). Nothing written.
6. **Idempotent no-op.** If `currentStatus == newStatus` **and** no note change is requested,
   short-circuit to success **without** writing a new audit row (avoid audit-log spam from
   double-clicks). If `currentStatus == newStatus` but a **note** is provided, treat as a
   note-update (allowed, see matrix diagonal in §5.3) and DO write an audit row. **[CONFIRM]** —
   §13 Q7.
7. **Transaction (single DB transaction):**
   a. Update `Submission.status = newStatus`.
   b. Update `Submission.adminNote` per the note-write rule (§5.3): set to the trimmed note when a
      non-empty note is supplied; otherwise leave the existing value unchanged.
   c. Insert one `AuditLog` row (§11) with `action` = the mapped action name, `actorId` = the
      session user id, `eventId` = the submission's event id, `metadata` = the change shape (§11).
   The status/note write and the audit insert **succeed or fail together** — never a status change
   without an audit record, never an audit record without the change.
8. **Return** the updated submission state (id, status, adminNote, updatedAt) for the UI to swap
   in, and trigger revalidation of `/admin/events/[id]`.

### 5.3 Allowed transition matrix

Rows = current status; columns = requested `newStatus`. ✓ = allowed, ✗ = rejected with E3.
`PENDING` is never a manual target (you decide; you don't manually reset to undecided — §13 Q9).

| From \ To | PENDING | APPROVED | REJECTED | FLAGGED |
|---|---|---|---|---|
| **PENDING** | — (n/a) | ✓ | ✓ | ✓ |
| **APPROVED** | ✗ | ✓ (note-only update / no-op) | ✓ (re-change) | ✓ (re-change) |
| **REJECTED** | ✗ | ✓ (re-change) | ✓ (note-only update / no-op) | ✓ (re-change) |
| **FLAGGED** | ✗ | ✓ | ✓ | ✓ (note-only update / no-op) |

Rationale:
- **All non-terminal.** Admin decisions are **reversible** — a misclick or a contributor follow-up
  shouldn't be permanent. Every decided state can move to any other decided state. (Reversibility
  is flagged for confirmation, §13 Q9.)
- The **diagonal** (X→X) is the "note-only update / idempotent no-op" case handled in §5.2 step 6.
- The only hard refusals are **any → PENDING** (cannot un-decide) and the n/a PENDING→PENDING cell.
- If FLAGGED is excluded from MVP (§13 Q2), drop the FLAGGED row/column and the FLAGGED targets;
  the matrix collapses to PENDING/APPROVED/REJECTED with the same shape.

### 5.4 Outputs / payloads

**Success result** (returned to the client component for optimistic confirm + swap):

```
{ ok: true, submission: { id, status, adminNote, updatedAt } }
```

Plus server-side `revalidatePath('/admin/events/[id]')` (or equivalent) so a full refresh shows the
same state. No redirect (admin stays on the page).

**Error result** (the action returns a structured result the UI renders, §4.5):

```
{ ok: false, error: "<ERROR_CODE>", message: "<calm admin-facing copy>" }
```

### 5.5 Status codes & error cases

Server Actions don't set HTTP status codes directly; the "HTTP-equivalent" column is the contract a
future thin JSON route would honor literally, and what integration tests assert on (result shape +
DB state).

| # | Case | Detection | Error code | HTTP-equiv | Admin sees | Side effects |
|---|---|---|---|---|---|---|
| E1 | Submission not found / stale id | step 3 | `SUBMISSION_NOT_FOUND` | 404 | "could not be found…" | none |
| E2 | Caller not an admin (no session / wrong role / domain) | step 1 | `FORBIDDEN` | 403 | "don't have access…" | log (warn) |
| E3 | Disallowed transition (incl. any → PENDING) | step 5 | `INVALID_TRANSITION` | 409 | "isn't allowed from the current state" | none |
| E4 | Validation failure (bad `newStatus`, note too long) | step 2 | `INVALID_REQUEST` | 422 | field/summary error | none |
| E5 | Dangling submission with no event | step 4 | `SUBMISSION_NOT_FOUND` | 404 | "could not be found…" | log (error) — data integrity |
| E6 | Unexpected server error (DB/txn failure) | any | `INTERNAL` | 500 | "Something went wrong…" | log (error); txn rolled back (no partial write) |

There is **no separate concurrency error**: two admins racing on the same submission both succeed
as ordinary status changes; the second simply transitions from whatever the first left. Each writes
its own audit row, so the full history is preserved (last-write-wins on `status`/`adminNote`, full
trail in `AuditLog`).

---

## 6. Database Design

This story introduces the **`AuditLog`** model (defined in `architecture.md` §7.1 but **not** in
the live schema — only `User` exists today). It **uses** `Submission.status` + `Submission.adminNote`,
which are owned by Story 5 / `architecture.md` §7.1; Story 8 does **not** add or alter `Submission`
columns.

### 6.1 `AuditLog` model — fields (introduced this story)

Matches `architecture.md` §7.1 exactly so later stories (12/14/20) reuse it unchanged.

| Field | Type | Null? | Default | Notes |
|---|---|---|---|---|
| `id` | String (cuid) | no | `cuid()` | PK |
| `eventId` | String? | **yes** | — | FK → `Event.id`, `onDelete: SetNull`. Nullable so audit survives event deletion (retention/right-to-delete keep de-identified audit, `architecture.md` §11.4) |
| `event` | relation `Event?` | — | — | `@relation(fields: [eventId], references: [id], onDelete: SetNull)` |
| `actorId` | String? | **yes** | — | The acting `User.id`. **Null only for system events** (e.g. future auto-flag from a worker). For Story 8 it is always the admin's id. No FK enforced **[CONFIRM]** — §13 Q10 (architecture shows it as a plain `String?`, not a relation) |
| `action` | String | no | — | Dotted action name, e.g. `submission.approved` (§11) |
| `metadata` | Json? | yes | — | Structured change detail (§11) |
| `createdAt` | DateTime | no | `now()` | Immutable; audit rows are insert-only |

**Append-only discipline:** `AuditLog` rows are **never updated or deleted** by application code
(except the PII-stripping at hard-delete time, Story 19/20). No `updatedAt`. A re-change writes a
**new** row; it does not mutate the prior one.

### 6.2 `Event` back-relation

`architecture.md` §7.1 declares `auditLog AuditLog[]` on `Event`. If Story 3's `Event` model left
that back-relation as a placeholder, no change is needed; otherwise this story adds the back-relation
on `Event`. No other `Event` columns change.

### 6.3 `Submission` usage (no schema change)

| Column | Owned by | Story 8 behavior |
|---|---|---|
| `status SubmissionStatus @default(PENDING)` | Story 5 | **Written** by the action (target of the transition) |
| `adminNote String?` | Story 5 | **Written** by the action per the note-write rule (§5.3) |

If, contrary to assumption, `adminNote` was **not** added in Story 5 (it was flagged as Q7 there),
Story 8 must add it to `Submission` as `adminNote String?` — but the expectation is that it already
exists. (Flagged §13 Q11.)

### 6.4 Indexes

| Index | On | Reason |
|---|---|---|
| `@@index([eventId])` | `AuditLog` | List/inspect all audit entries for an event (admin audit view, analytics, retention sweeps) |
| (optional) `@@index([action])` | `AuditLog` | Only if metrics queries scan by action at scale; **[CONFIRM]** defer until needed (§13 Q12) |
| existing `@@index([eventId, status])` | `Submission` (Story 5) | Reused: dashboard lists submissions by event/status; status writes here keep it warm. No new index added |

### 6.5 Migration notes

- Migration name: `add_audit_log` (e.g. `<timestamp>_add_audit_log`).
- **Additive only** — creates the `audit_log` table, the `eventId → Event.id` FK with
  `ON DELETE SET NULL`, and the `@@index([eventId])`. No backfill (new table). Safe to
  `prisma migrate deploy` against `swara_prd` with no downtime.
- The migration references `Event.id`; it cannot apply unless Story 3's `Event` table exists in the
  same schema history. Confirm Story 3 (and Story 5's `Submission`) precede this one.
- No change to `Submission` or its enum if Story 5 already added `status` + `adminNote` (expected).
- Run `prisma generate` after migrate so `AuditLog` types are available to web + workers.

---

## 7. External Services / Integrations / Config

**No new external service** is integrated in this story. No Stripe, no Resend send, no S3, no AI,
no Redis usage beyond what already exists.

**No new config variables.** The admin auth allowlist (`ADMIN_EMAIL_DOMAINS`, `NEXTAUTH_*`) is
owned and wired by Stories 2/7 and read through `src/config` (per the no-direct-`process.env`
convention from Story 1). Story 8 reads the existing admin guard; it adds nothing to
`src/config/env.ts` or `src/config/index.ts`.

> If Story 7 has not yet surfaced an `isAdmin`/`requireAdmin` helper that reads `config`, Story 8
> consumes whatever Story 7 provides; it must not read `process.env` directly (ESLint
> `no-restricted-syntax` rule, Story 1).

---

## 8. Seed Data

Extend the existing `npm run seed` script so the approval flow is testable locally and the
downstream stories have realistic statuses to consume.

Required seed state, on the existing seeded event (e.g. `riyas-graduation`):

- An **`ADMIN` actor** `User` (e.g. `admin@swara.media`, `role = ADMIN`, on an allowlisted domain)
  so the action's authz path can be exercised end to end and `AuditLog.actorId` has a real id to
  reference.
- At least **two `PENDING`** submissions (something to approve and something to reject).
- At least **one `FLAGGED`** submission (to exercise FLAGGED → APPROVED/REJECTED re-change, and the
  FLAGGED badge). If FLAGGED is dropped from MVP (§13 Q2), seed a second PENDING instead.
- (Story 5's seed already creates one each of PENDING/APPROVED/REJECTED/FLAGGED — Story 8 only needs
  to **add the ADMIN user** and ensure ≥1 PENDING and ≥1 FLAGGED remain to act on. Avoid
  duplicating Story 5's rows.)

Seed requirements:
- Idempotent (upsert the admin user by email; do not duplicate submissions).
- Do **not** seed any `AuditLog` rows — audit history is produced by acting in the app/tests, not
  seeded (keeps the audit trail honest). **[CONFIRM]** §13 Q13.

---

## 9. Testing

Follows the project pattern (Vitest, `tests/unit` + `tests/integration`). DB-touching tests are
guarded by **`SKIP_INTEGRATION`** so unit-only runs / CI without a test DB stay green.

### 9.1 Unit tests (no DB; pure logic)

| Test | Asserts |
|---|---|
| Allowed transitions | For every cell of the §5.3 matrix, the transition checker returns allow/deny correctly (all decided↔decided allowed; any→PENDING denied; PENDING→{APPROVED,REJECTED,FLAGGED} allowed) |
| Note optionality | Action input validates with no note, with empty/whitespace note (treated absent), and with a valid note; rejects a note over the max length |
| Input validation | `newStatus` must be one of APPROVED/REJECTED/FLAGGED; `PENDING` and unknown values rejected (E4) |
| Action-name mapping | Each `newStatus` maps to the correct audit `action` string (`submission.approved` / `submission.rejected` / `submission.flagged`) (§11) |
| Authz gate (mocked session) | Non-admin / no session ⇒ FORBIDDEN before any read or write; admin ⇒ proceeds |
| No-op short-circuit | Same status + no note ⇒ success with **no** audit row produced (verify the audit-writer is not called) |
| Metadata shape | The metadata object assembled for the audit row has `previousStatus`, `newStatus`, `submissionId`, `notePresent` (§11) |

### 9.2 Integration tests (DB; skipped under `SKIP_INTEGRATION`)

| Test | Asserts |
|---|---|
| Approve persists + audits | PENDING → APPROVED writes `status=APPROVED`, optional note stored, **exactly one** `AuditLog` row with `action=submission.approved`, correct `actorId` + `eventId` + metadata |
| Reject persists + audits | PENDING → REJECTED writes `status=REJECTED` and a `submission.rejected` audit row |
| Flag persists + audits | PENDING → FLAGGED writes `status=FLAGGED` and a `submission.flagged` audit row (skip if FLAGGED dropped) |
| Re-change | APPROVED → REJECTED succeeds; status updated; a **second** audit row appended (prior row untouched) |
| Note replaces / preserves | Supplying a new note overwrites `adminNote`; supplying no note leaves prior `adminNote` unchanged (§5.3) |
| Invalid transition | any → PENDING rejected (E3); **no** status change, **no** audit row written |
| Non-admin blocked | A non-admin session is refused (E2); no row read/written; nothing in `AuditLog` |
| Not found | Unknown `submissionId` ⇒ E1; nothing written |
| Atomicity | If the audit insert is forced to fail, the status/note update is rolled back (no status change without an audit row) |
| Transaction = one unit | On success, status+note+audit are all present; on failure, none are |

### 9.3 (Optional) component/render tests

- The submission card renders the correct badge per status; disallowed-transition buttons are
  disabled; optimistic badge reverts on a returned error; the `aria-live` region announces results.

---

## 10. Security & Surprise Integrity

| Concern | Control |
|---|---|
| Admin-only mutation | Server Action asserts authenticated `User` with `role = ADMIN` (+ allowlisted domain, `architecture.md` §10.2) **server-side** before any read/write. UI gating is not relied upon. (E2) |
| Actor identity not spoofable | `actorId` comes from the **session**, never from client input (§5.1). |
| Scope safety | The submission must resolve to a real event (§5.2 step 4); a dangling/foreign id is refused (E1/E5), not acted upon. |
| Audit trail (non-repudiation) | Every decision writes an immutable `AuditLog` row (who/what/when/change) in the **same transaction** as the status change — no decision is unaudited. Append-only; re-changes append, never overwrite (§6.1). |
| No content tampering | The action changes only `status` + `adminNote`; it cannot edit submission content. |
| Input handling | `adminNote` stored as plain text; rendered escaped everywhere (no HTML execution). Length-capped server-side. |
| Surprise integrity | **No notification is sent** to anyone on approve/reject (esp. never the honoree). Approval is an internal editorial state; the honoree is an excluded actor (`architecture.md` §10.1). Contributor notification of decisions is explicitly out of scope (§13 Q5). |
| CSRF | Next.js Server Actions are origin-checked by the framework; rely on that (no custom token). |
| Least privilege | Admins are global reviewers; there is no per-event ownership escalation path introduced here. |

---

## 11. Observability / Audit

### 11.1 `AuditLog` action names (this story)

| Trigger (`newStatus`) | `AuditLog.action` |
|---|---|
| → APPROVED | `submission.approved` |
| → REJECTED | `submission.rejected` |
| → FLAGGED | `submission.flagged` |

These dotted names follow the convention in `architecture.md` §7.1 (`submission.approved`,
`routing.override`, …) and §6.4. Later stories own their own action names (e.g. `routing.approved`,
Story 12) — Story 8 introduces only the three above.

> **[CONFIRM]** §13 Q14: whether a note-only update on an unchanged status should use the same
> action name (e.g. `submission.approved` again) or a distinct `submission.note_updated`. Default:
> reuse the status-matched action name and rely on metadata (`previousStatus == newStatus`,
> `notePresent: true`) to distinguish.

### 11.2 `AuditLog.metadata` shape (this story)

```
{
  submissionId: string,
  previousStatus: "PENDING" | "APPROVED" | "REJECTED" | "FLAGGED",
  newStatus:      "APPROVED" | "REJECTED" | "FLAGGED",
  notePresent:    boolean,        // whether an adminNote was written this action
  // NOTE: the note TEXT is NOT duplicated into metadata — it lives on Submission.adminNote.
  //       Storing it twice complicates PII stripping at hard-delete (architecture §11.4).
  timestamp:      string (ISO)    // redundant with createdAt; mirrors architecture §6.4 metadata style
}
```

`actorId` and `eventId` are first-class columns (not nested in metadata), matching
`architecture.md` §7.1. The `metadata` carries the **diff** only.

### 11.3 Structured logs (Story 1 `logger`)

| Signal | Level | Fields |
|---|---|---|
| Status change success | info | `submissionId`, `eventId`, `actorId`, `previousStatus`, `newStatus` (no note text at info — treat note as potential PII) |
| Forbidden attempt (E2) | warn | `actorId` (if any), `submissionId` — for abuse/misconfig review |
| Invalid transition (E3) | debug | `submissionId`, `previousStatus`, attempted `newStatus` |
| Unexpected error (E6) | error | full error; safe message returned to admin |

### 11.4 Metrics (wire to OTel/Honeycomb per `architecture.md` §13 when observability lands)

- **Approval counts** per event and overall (APPROVED / REJECTED / FLAGGED tallies) — derivable
  from `Submission.status` and corroborated by `AuditLog` action counts.
- **Approval rate** (APPROVED / total decided) — input to editorial-quality dashboards.
- **Re-change rate** (decided→different-decided transitions) — a high rate may signal unclear
  submission quality or admin uncertainty.
- These are read-only aggregations over existing data; no new metrics table is added in this story.

---

## 12. Definition of Done

Story 8 is done only when all are true:

- [ ] `prisma/schema.prisma` has the `AuditLog` model (fields per §6.1) + the `Event.auditLog`
      back-relation; migration `add_audit_log` created and applied to `swara_dev`, applied to
      `swara_test` in CI and `swara_prd` on deploy; `prisma generate` run.
- [ ] `Submission.status` + `Submission.adminNote` are written by the action (no `Submission`
      schema change needed, assuming Story 5 added them).
- [ ] An admin-only **status-change Server Action** exists with the inputs in §5.1, enforcing
      authz **server-side**, the §5.3 transition matrix, and the §5.2 algorithm.
- [ ] Status change + optional note + `AuditLog` insert happen in **one transaction** — never a
      change without an audit row, never an audit row without the change.
- [ ] `/admin/events/[id]` shows per-submission approve / reject (/ flag) controls + optional note
      input; badges update live (optimistic, reverting on error); disallowed transitions disabled.
- [ ] All error cases (§5.5) handled: not-found, forbidden, invalid-transition, validation,
      unexpected — each with calm admin-facing copy (§4.5) and correct (no) side effects.
- [ ] Audit rows use the action names + metadata shape in §11; the note text is **not** duplicated
      into metadata.
- [ ] Seed adds an `ADMIN` actor and leaves ≥1 PENDING + ≥1 FLAGGED submission to act on; seed is
      idempotent; no `AuditLog` rows seeded.
- [ ] Unit tests (transition matrix, note optionality, authz, action-name mapping, no-op
      short-circuit, metadata shape) pass; integration tests (persist + audit, re-change,
      invalid-transition, non-admin blocked, atomicity) pass and honor `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; no `process.env` reads
      outside `src/config/`; deploy succeeds.
- [ ] No TODO comments left in committed code; `docs/stories.md` Story 8 row marked done.
- [ ] Accessibility (§4.6): real buttons with accessible names, color-independent badges,
      `aria-live` announcements, keyboard operability.

---

## 13. Open Questions / Assumptions

| # | Question / Assumption | This doc's default | Needs confirmation? |
|---|---|---|---|
| Q1 | **Story 7 design absent.** Admin auth model, `/admin/events/[id]` route, role-gating helper, and submission-row component are assumed from `architecture.md` §5.5/§10.2. | Extend architecture's admin model; reuse Story 7's `requireAdmin` guard once it lands. Reconcile route/helper names if Story 7 diverges. | **Yes** — confirm Story 7 contracts before code |
| Q2 | **Is FLAGGED an admin-set status in this story, or only set by the quality pipeline (Story 9)?** Requirements §5.5 lists only "approve/reject"; architecture's enum includes FLAGGED. | Include an admin **Flag** control in MVP (cheap, useful for "needs a second look"); the quality pipeline ALSO sets FLAGGED in Story 9. | **Yes** — confirm admins may set FLAGGED, or restrict Story 8 to APPROVE/REJECT only |
| Q3 | **Worker auto-flag (Story 9) coexistence.** Story 9 will write `FLAGGED` from a worker with `actorId = null`. | Story 8's manual transitions accept FLAGGED as a *current* state and allow re-changing it; Story 9 owns the auto-flag write + its own (`actorId: null`) audit action. | Confirm the division (Story 9 scope) |
| Q4 | **What does downstream consume — APPROVED only, or APPROVED ∪ PENDING?** Requirements §5.5 "Export package = approved media"; analyzer (§5.6) wording is ambiguous. | Treat **APPROVED** as the inclusion gate for export/brief/AI; PENDING and FLAGGED are excluded; REJECTED always excluded. | **Yes** — confirm; affects Stories 12/13/16 |
| Q5 | **Notify the contributor on approve/reject?** | **No** in MVP 1 — approval is internal editorial state; no contributor-facing decision email. Surprise integrity + scope. | Confirm no notification is wanted |
| Q6 | **Bulk actions** (approve all / multi-select). | Out of scope this story; per-submission only. | Confirm deferral |
| Q7 | **Note-write rule + no-op semantics.** Does an empty note clear an existing note? Does a note-only change (same status) write an audit row? | Empty/whitespace note **preserves** the prior note (does not clear it); a note-only change on the same status **does** write an audit row; same-status + no-note is a silent no-op. | **Yes** — confirm; alternative: empty note clears, or add an explicit "clear note" control |
| Q8 | **Confirmation step on Reject** (vs no confirm, since reversible). | Lightweight inline confirm on Reject only; Approve/Flag are one-click. | Low stakes — confirm preference |
| Q9 | **Reversibility / can a decision be undone to PENDING?** | Decisions are **reversible between decided states** (APPROVED↔REJECTED↔FLAGGED) but **cannot return to PENDING**. | **Yes** — confirm reversibility policy and the no-return-to-PENDING rule |
| Q10 | **`AuditLog.actorId` — FK to `User` or plain string?** Architecture §7.1 shows a plain `String?` (no relation). | Keep it a plain `String?` (matches architecture; allows `null` for system actions and survives user deletion). | Confirm (plain string vs FK relation) |
| Q11 | **Is `adminNote` already on `Submission` (Story 5)?** Story 5's design flagged adding it as its Q7. | Assume **yes** (added in Story 5). If not, Story 8 adds `adminNote String?` to `Submission` in this migration. | **Yes** — confirm Story 5 added it |
| Q12 | **`@@index([action])` on `AuditLog`.** | Defer until a metrics query needs it. | Defer |
| Q13 | **Seed `AuditLog` rows?** | No — produce audit history by acting in app/tests, not seeds. | Confirm |
| Q14 | **Audit action name for a note-only update on unchanged status.** | Reuse the status-matched action; distinguish via metadata (`previousStatus == newStatus`). Alternative: `submission.note_updated`. | Confirm |
| Q15 | **Schema not yet on `main`** (only `User` exists). | Assume Stories 3/5/7 land `Event`, `Submission`, `SubmissionStatus`, admin auth before this migration. | **Yes** — those must merge first |
