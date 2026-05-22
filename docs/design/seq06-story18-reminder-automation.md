# Sequence 06 / Story 18 — Reminder Automation (Cron)

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (cron schedule, sweep query, trigger windows/thresholds, dedupe keys, the
`Channel` interface, email template inventory, error cases) so a later code-generation step
implements exactly this and nothing more. Where a value is a proposal awaiting confirmation
it is flagged **[CONFIRM]**; genuine ambiguities are listed in §13, not silently chosen.

| Field | Value |
|---|---|
| Story number / title | Story 18 — Reminder automation (cron) |
| Epic | J — Lifecycle (lands in parallel late in development) |
| Sequence number | 6 (this is the 6th design in build order) |
| Depends on | Story 6 (Media uploads) — and transitively Story 3 (`Event`) + Story 5 (`Submission`) |
| Parallel with | Stories 8 (approve/reject), 9 (workers + quality), 20 (right to delete) |
| Unlocks | Nothing schema-wise; provides the `Channel` interface + `NotificationLog` dedupe pattern that MVP 2 WhatsApp send and other notification senders reuse |
| Complexity | S (0.5–1 day) |

> **Sources of truth honored:** `docs/requirements.md` §5.4 (reminder automation table, email-only
> MVP 1, channel abstraction), §8 (email required), §6 (NotificationLog logical model);
> `docs/architecture.md` §8.3 (reminder scheduler — the canonical SQL sweep, trigger windows,
> milestone thresholds, deadline-passed actions, dedupe via NotificationLog), §8.1 (`reminders`
> + `notifications` queues), §8.2 (job idempotency contract), §7.1 (`NotificationLog` model incl.
> `suppressed_surprise` status, the `@@index([status, submissionDeadline])` reminder index),
> §10.1 (surprise integrity — the honoree filter in the dispatcher), §13 (critical alert on
> honoree suppression), §14 (env vars), §16 (config single-source). Also: `docs/branding.md`
> (email voice/templates), `docs/stories.md`, `docs/stories/story-01-foundation.md` (doc + config
> style), `prisma/schema.prisma`, and the sibling designs `seq03-story03-event-creation.md`,
> `seq04-story05-contributor-text-submission.md`, `seq05-story06-media-uploads.md`.

> **Note on the Story 9 worker design.** `docs/design/seq06-story09-workers-quality-scoring.md`
> is **not present** in the repo at the time of writing. Worker/BullMQ patterns in this doc are
> therefore taken from `architecture.md` §8.1 (queue topology — the `reminders` queue:
> concurrency 1, Low priority), §8.2 (idempotency contract), and the Story 1 worker scaffold
> (`src/workers/index.ts`). If the Story 9 design lands first and establishes concrete worker
> conventions (queue registration, BullMQ setup helpers, repeatable-job patterns), reconcile §5
> against it before generating code. This is flagged in §13 (A1).

---

## 1. Story Summary

### Goal
Add an **hourly cron sweep** (the architecture's "Reminder Scheduler", `architecture.md` §8.3)
that, for every actively-collecting event, fires the four reminder/notification flows from
`requirements.md` §5.4:

1. **48h-before-deadline contributor reminder** to people who have not yet submitted.
2. **24h-before-deadline contributor reminder** (second nudge) to non-submitters.
3. **Organizer milestones** at **25% / 50% / 75%** of expected contributors submitted.
4. **Deadline reached** → notify the **organizer** with the final submission count, and **alert
   the Swara Admin team** that the event is ready for review.

Every send goes through a **`Channel` interface** with **Email (Resend in prod / Mailpit SMTP in
dev) as the only MVP 1 implementation**. Adding WhatsApp in MVP 2 is a new `Channel`
implementation, not a rewrite (`requirements.md` §5.4 channel-abstraction requirement). Every
attempted send is recorded in **`NotificationLog`**, and the log is the **idempotency store**: a
per `(event, trigger, recipient)` dedupe key guarantees a given reminder fires **at most once**
even though the sweep runs every hour. A **strict honoree-suppression filter** lives in the
shared dispatcher: any send whose recipient equals `Event.honoreeEmail` is **never delivered** —
it is suppressed and logged with status `suppressed_surprise` (`architecture.md` §10.1).

### What it adds (delta over what's already on `main`)
- A `reminders` BullMQ **repeatable job** (every hour) + the sweep logic in the worker process.
- A `notifications` dispatch path: the `Channel` interface + `EmailChannel` (Resend / Mailpit).
- The `NotificationLog` table (first physical use of `architecture.md` §7.1's model) + the
  reminder index `@@index([status, submissionDeadline])` on `Event` (deferred from Story 3
  specifically for this story — see `seq03-story03-event-creation.md` §6.1).
- Email templates for the reminder/notification set, in the brand voice.
- Config: `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, dev SMTP (Mailpit) vars, an admin recipient
  address, and a cron-enable/schedule flag — all wired through **both** `src/config/env.ts` and
  `src/config/index.ts`.

### Success criteria
- [ ] An hourly cron sweep runs in the worker process and queries only actively-collecting,
      pre/at-deadline events (the §5.2 query).
- [ ] For each event, the four flows evaluate against their exact windows/thresholds (§5.3).
- [ ] Each reminder/notification is sent **at most once** ever — re-running the sweep produces
      **no duplicate `NotificationLog` rows** for the same `(eventId, trigger, recipient)` and no
      duplicate emails.
- [ ] All sends route through the `Channel` interface; `EmailChannel` is the only registered
      implementation; the dispatcher is channel-agnostic.
- [ ] No notification is ever delivered to `Event.honoreeEmail`; any such attempt is logged
      `suppressed_surprise` and a critical alert is raised (`architecture.md` §13).
- [ ] Emails render in dev via Mailpit and in prod via Resend; copy honors `branding.md`.
- [ ] New env vars present in **both** config files; no `process.env` read outside
      `src/config/env.ts` (ESLint `no-restricted-syntax` stays green).
- [ ] Unit + integration tests (§9) pass; integration tests skip cleanly under
      `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green.

---

## 2. Scope

### In scope (this story)
- **Hourly cron sweep** ("Reminder Scheduler") in the worker process.
- The **eligible-events query** (ACTIVE, deadline in the future or just passed) with
  submitted-vs-expected counts (§5.2).
- **48h** and **24h** contributor reminders to **non-submitters** (window math in §5.3.1).
- **Organizer milestone** notifications at **25 / 50 / 75 %** of `expectedContributors` (§5.3.2).
- **Deadline-reached** actions: notify **organizer** (final count) + **alert admin**; flip event
  status `ACTIVE → DEADLINE_PASSED` (§5.3.3).
- The **`Channel` interface** (methods/inputs/outputs described, not coded) with **`EmailChannel`**
  (Resend prod / Mailpit dev) as the only implementation.
- **`NotificationLog`-based dedupe** — a dedupe key per `(eventId, trigger, recipientEmail)`
  (§5.4); the log row is the "already sent" record (`architecture.md` §8.2 §8.3).
- The **honoree-suppression filter** in the shared dispatcher (§5.5, §10).
- **Retry / backoff** for transient send failures (§5.6).
- **Email template inventory** + variables, in brand voice (§5.7).
- `NotificationLog` Prisma model + the `Event` reminder index (§6).
- Config additions in **both** config files (§7).
- Seed data shaped to exercise every window/threshold locally (§8).
- Tests: window math, threshold crossing, dedupe, honoree suppression, channel dispatch (§9).

### Out of scope (deferred — with owners)
| Deferred item | Owner / where |
|---|---|
| **WhatsApp API send** (outbound reminders via Meta Cloud API) | MVP 2 — new `WhatsAppChannel` behind the same interface (`requirements.md` §5.4) |
| **Retention reminders** (event_date + 30d "your video will be deleted" sweep) | **Story 19** (a *separate* daily cron; do not fold into this hourly sweep — `architecture.md` §11.4) |
| **Contributor confirmation email** (on submit) + self-service deletion link | Story 20 (and noted in `seq04-story05` §7) |
| **Organizer/admin notifications for routing/delivery** (`event.routing_ready`, delivery email, editor emails) | Stories 12 / 13 / 14 / 15 — they reuse this story's `Channel` + dispatcher but own their own triggers/templates |
| **Live notification-status surface in the organizer dashboard** | Out of MVP 1 UI; `NotificationLog` is the audit substrate a future UI reads (see §4) |
| **WhatsApp opt-in capture at submission** | MVP 2 |
| **SMS** | Permanently refused (`architecture.md` §15) |
| **Per-contributor "unsubscribe" / preference center** | Out of MVP 1 (transactional reminders only) — flagged §13 (A8) |

---

## 3. Dependencies & Sequence

### Must already be on `main`
- **Story 1 (Foundation):** typed `config` (`src/config/env.ts` + `src/config/index.ts`), Prisma
  client (`src/lib/db.ts`), Redis client (`src/lib/redis.ts`), `logger`, the **worker entry
  point** (`src/workers/index.ts`), CI.
- **Story 3 (Event creation):** `Event` model with `organizerId` (→ `User`), `honoreeName`,
  `occasionType`, `submissionDeadline DateTime`, `expectedContributors Int`, `status EventStatus`,
  `slug`. (See `seq03-story03-event-creation.md` §6.) `honoreeEmail` is **not** yet collected per
  that doc's Assumption A1 — see §13 (A2) for how the honoree filter behaves when the field is
  absent/null.
- **Story 5 (Contributor submission):** `Submission` model with `eventId`, `email` (normalized
  lowercase), `submittedAt`, `@@unique([eventId, email])` (the basis for "submitted vs not"). See
  `seq04-story05-contributor-text-submission.md` §6.
- **Story 6 (Media uploads):** listed as this story's nominal dependency in `docs/stories.md`
  (Story 18 "Depends On: 6"). Story 18 does not consume `MediaItem` directly — it depends on Story
  6 only via the dependency chain (Story 6 → Story 5 → Story 3). A submission counts as "submitted"
  whether or not it carries media. (Flagged §13 A3.)
- **Story 9 (Workers + quality):** establishes BullMQ worker conventions. Per `docs/stories.md`,
  Story 18 can land "in parallel after Story 6" and does **not** strictly depend on Story 9. If
  Story 9 has not landed, this story stands up the **minimal BullMQ machinery it needs** (the
  `reminders` repeatable job + the `notifications` queue) following `architecture.md` §8, and Story
  9 reuses/extends it. If Story 9 lands first, reuse its setup. Flagged §13 (A1).

### Sequence within this story
```
1. Schema: add NotificationLog model + Event reminder index → verify: prisma migrate runs, generate clean
2. Config: add RESEND_*, SMTP/Mailpit, ADMIN/NOTIFY vars, cron flag in env.ts + index.ts → verify: config parses
3. Channel: define Channel interface + EmailChannel (Resend prod / Mailpit dev) → verify: unit test dispatch + mock
4. Dispatcher: shared send() with honoree filter + NotificationLog dedupe + retry → verify: unit tests
5. Sweep: eligible-events query + per-event trigger evaluation (windows/thresholds/deadline) → verify: unit + integration
6. Cron wiring: register hourly repeatable job in worker; enqueue sweep → verify: job registers; sweep runs idempotently
7. Templates: email inventory + variables in brand voice → verify: render snapshot tests
8. Seed + tests + DoD → verify: lint/typecheck/test green
```

### What this unlocks
- The **`Channel` interface + dispatcher + `NotificationLog` dedupe** become the shared
  notification substrate every later sender uses (Stories 12/13/14/15 routing/editor/delivery
  emails; MVP 2 WhatsApp). Those stories add **triggers + templates**, not new plumbing.

---

## 4. Frontend / UI Design

**Mostly N/A.** This story is a backend cron + worker feature; it ships **no user-facing UI**.

- There is **no organizer-facing notification settings page**, no preference center, and no
  "resend reminder" button in MVP 1 (flagged §13 A8).
- **Where status could surface later (not built here):** `NotificationLog` rows are the natural
  data source for a future organizer dashboard panel ("Reminders: 48h sent ✓, 24h sent ✓") and an
  admin view ("events with failed dispatches"). This story deliberately produces those rows with
  enough structure (`trigger`, `recipientType`, `status`, `sentAt`) that such a panel is a pure
  read later. **No UI is added now.** (Mentioned only to satisfy the structure requirement; do not
  build it.)
- The **only** human-visible artifact of this story is the **email itself**, whose copy/voice is
  specified in §5.7 and must follow `branding.md` (warm, calm, **no exclamation marks**, exact
  honoree name, occasion-aware nouns, "by Swara Media" footer lockup).

---

## 5. Backend / Worker Design

The feature is a long-running worker concern (it cannot live on Vercel — `architecture.md` §4):
an **hourly trigger** enqueues a **sweep**, the sweep **evaluates triggers per event**, and the
shared **dispatcher** sends through a **`Channel`** while recording/deduping in `NotificationLog`.

### 5.1 How the cron is scheduled — recommendation

**Recommendation: a BullMQ repeatable job** named `reminders.sweep`, registered once at worker
boot, with cron pattern `0 * * * *` (top of every hour), enqueued onto the **`reminders` queue**
(`architecture.md` §8.1 — concurrency **1**, priority **Low**). The worker process
(`src/workers/index.ts`) registers the repeatable schedule and a worker that processes the
`reminders.sweep` job.

**Why BullMQ repeatable over a platform cron (e.g., Vercel Cron / Railway cron):**
| Reason | Detail |
|---|---|
| The work already lives in the worker | The dispatcher, Prisma client, Redis, and `Channel` all run in the worker process (`architecture.md` §4 — long-running jobs live on Railway/Fly, not Vercel). A platform cron hitting an HTTP route would force this logic into a Vercel function with a 60s ceiling and duplicate the worker's setup. |
| One scheduler, one infra | BullMQ is already the queue (`architecture.md` §5, §8.1) and ships repeatable jobs + an observability dashboard out of the box. No new platform primitive. |
| Concurrency / locking solved | The `reminders` queue is concurrency 1, so two sweeps never overlap; BullMQ's lock + requeue-on-crash (`architecture.md` §11.1) gives crash safety for free; idempotency (§5.4) makes a re-run harmless. |
| Env parity | Same mechanism in dev and prod; locally the worker runs via `npm run workers` (Story 1). |

**Trade-off acknowledged:** a BullMQ repeatable job only fires while at least one worker is alive.
If the entire worker fleet is down at the top of an hour, that hour's sweep is skipped. Because the
sweep is **catch-up by design** — it re-derives state from the DB every run and the trigger
windows are an hour wide (§5.3) — the **next** hourly run still fires anything that became eligible
during the outage. A missed hour does not lose a reminder unless the worker fleet is down for the
entire 1-hour window of a given trigger; that scenario is covered by the worker-uptime alerting in
`architecture.md` §13 and is acceptable for MVP 1. (See §13 Q1 for the platform-cron alternative.)

**Schedule controls (config, §7):** `REMINDERS_CRON_ENABLED` (default `true`; set `false` in
test/CI so the scheduler doesn't auto-fire) and `REMINDERS_CRON_PATTERN` (default `0 * * * *`).
The sweep is also **manually invokable** (a plain enqueue of one `reminders.sweep` job) so tests
and ops can run it on demand without waiting for the hour boundary.

### 5.2 The sweep — eligible-events query

Per `architecture.md` §8.3, one sweep selects every actively-collecting event and its
submitted-count. The canonical query (architecture's, reproduced as the contract — implemented via
Prisma, equivalent semantics):

```sql
SELECT id, submission_deadline, expected_contributors, organizer_id, honoree_name, ...
       (SELECT count(*) FROM submissions WHERE event_id = events.id) AS submitted
FROM events
WHERE status = 'ACTIVE';
```

**Adjustment vs. the literal architecture snippet.** Architecture §8.3 shows
`AND submission_deadline > NOW()`. This story **widens** the predicate to also catch events whose
deadline has *just passed*, because the **deadline-reached** flow (§5.3.3) must fire for an event
the moment its deadline is in the past while still `ACTIVE`. The effective selection is:

> `status = 'ACTIVE'` **AND** `submission_deadline > NOW() - INTERVAL '1 hour'`

i.e. include events whose deadline is in the future **or** passed within roughly the last sweep
interval. Once the deadline-reached flow runs it flips the event to `DEADLINE_PASSED` (§5.3.3), so
the event drops out of subsequent sweeps. The `- 1 hour` slack is a safety net for a missed sweep
(events that passed up to an hour ago are still picked up); the dedupe (§5.4) prevents any double
fire. (Flagged §13 A4 — exact slack window.)

**Index:** the query is served by `Event @@index([status, submissionDeadline])`
(`architecture.md` §7.1; added in this story per §6 — it was explicitly deferred from Story 3).

**What "submitted" counts as:** the number of `Submission` rows for the event. With Story 5's
`@@unique([eventId, email])`, each row is a distinct contributor — so `submitted` is the distinct
contributor count. (See §5.3.4 on identifying *which* contributors are non-submitters.)

**Per-event processing:** for each eligible row the sweep evaluates the three trigger families
below **in order** and dispatches via §5.5. Each event's evaluation is independent; one event's
failure (e.g., a transient Resend error) must not abort the rest of the sweep (§5.6). The whole
sweep is one BullMQ job; per-event work is a loop inside it (volume in MVP 1 is small; if it grows,
fan-out to per-event child jobs is a future optimization — flagged §13 A5).

### 5.3 Per-event trigger evaluation

Let `now = sweep start time (UTC)`, `deadline = event.submissionDeadline`,
`hoursToDeadline = (deadline - now) in hours`, `expected = event.expectedContributors`,
`submitted = counted in §5.2`.

#### 5.3.1 Contributor reminders — 48h and 24h windows (to non-submitters)
| Trigger | Window condition | Recipients | Dedupe key trigger token |
|---|---|---|---|
| 48h reminder | `47h ≤ hoursToDeadline ≤ 48h` (i.e. deadline is **47–48 hours** away) | every **non-submitter** contributor email known for the event (§5.3.4) | `deadline.48h` |
| 24h reminder | `23h ≤ hoursToDeadline ≤ 24h` (deadline **23–24 hours** away) | every **non-submitter** contributor email | `deadline.24h` |

- Windows are exactly the architecture's `[47h, 48h]` and `[23h, 24h]` (`architecture.md` §8.3).
  The 1-hour width matches the hourly cadence so each window is hit by exactly one sweep in the
  normal case; the dedupe (§5.4) makes overlap (e.g. a window straddled by two sweeps, or a missed
  then caught-up sweep) harmless.
- Boundary handling **[CONFIRM]**: treat the window as **inclusive** on both ends
  (`47 ≤ h ≤ 48`). The dedupe guarantees at-most-once regardless of whether a boundary value is
  caught by one sweep or two, so inclusivity is safe. (§13 A6.)
- These reminders go to **contributors who have not submitted** — see §5.3.4 for who that is in a
  no-contributor-accounts model and the resulting limitation.

#### 5.3.2 Organizer milestones — 25 / 50 / 75 %
| Trigger | Fire condition | Recipient | Dedupe key trigger token |
|---|---|---|---|
| 25% milestone | `submitted / expected ≥ 0.25` and not previously sent | organizer email | `milestone.25` |
| 50% milestone | `submitted / expected ≥ 0.50` and not previously sent | organizer email | `milestone.50` |
| 75% milestone | `submitted / expected ≥ 0.75` and not previously sent | organizer email | `milestone.75` |

- **"Crossed since last sweep" without storing prior counts:** the sweep does **not** persist the
  previous submitted count. Instead it relies on `NotificationLog` as the durable record: for each
  threshold whose ratio is now met, attempt the send; the dedupe (§5.4) suppresses it if a row for
  that `(eventId, milestone.NN, organizerEmail)` already exists. This makes "crossed" equivalent to
  "ratio met **and** not yet logged" — robust to missed sweeps and to counts jumping multiple
  thresholds at once (e.g., a batch of submissions crossing 25%→75% between two sweeps fires all
  three pending milestones in one sweep). (This resolves the architecture §8.3 "crossed 25/50/75%
  since last sweep" intent without a prior-count column — flagged §13 Q2 and A7.)
- **Threshold math:** `ratio = submitted / max(expected, 1)`; compare `ratio ≥ threshold`. Guard
  `expected = 0` (shouldn't happen — Story 3 enforces `≥ 1` — but divide-by-zero must be impossible:
  treat `expected ≤ 0` as "no milestones" and skip). **[CONFIRM]** percentages compare on the raw
  ratio (so 1 of 4 = 25.0% fires 25%); fractional counts never occur (counts are integers).
- Milestones fire **independently of the deadline window** and **only while `status = ACTIVE`**
  (i.e. before deadline-reached flips status). A milestone reached *after* the deadline is not
  separately sent — the deadline-reached organizer email carries the final count (§5.3.3).

#### 5.3.3 Deadline reached — organizer final count + admin alert + status flip
Fires when `hoursToDeadline ≤ 0` (deadline at/in the past) **and** `status = ACTIVE`:
| Action | Recipient | Dedupe key trigger token | Notes |
|---|---|---|---|
| Notify organizer with **final submission count** | organizer email | `deadline.reached.organizer` | body includes `submitted` (final count) and `expected` |
| Alert **Swara Admin** team that the event is ready for review | admin recipient (config `ADMIN_NOTIFY_EMAIL`, §7) | `deadline.reached.admin` | "ready for review" per `requirements.md` §5.4 / §5.5 |
| **Flip status** `ACTIVE → DEADLINE_PASSED` | — | — | DB update; makes the event drop out of future sweeps (§5.2) and is the signal Story 12's analyzer/routing picks up |

- **Ordering & safety:** attempt both sends (each independently deduped/logged), **then** flip the
  status. The status flip must be **idempotent and safe under retry**: only flip if currently
  `ACTIVE` (a conditional update `WHERE status = 'ACTIVE'`), so a re-run after a partial failure
  does not double-flip or fight a concurrent transition. If a send fails, the status **still flips**
  (the deadline is a hard fact; `requirements.md` §8 "hard-closes at deadline") and the failed send
  is retried by §5.6 / re-attempted next sweep within the §5.2 slack window — but because the status
  has flipped, the event won't be re-selected; therefore **the send retry must complete within the
  dispatcher's own retry budget (§5.6) before the status flip is committed.** **Decision:** perform
  the two sends with retries first; commit the status flip last, in the same logical step, so a
  hard failure leaves status `ACTIVE` for the next sweep to retry. (Flagged §13 Q3 — flip-before
  vs flip-after.)
- The contributor 48h/24h reminders and milestones are **not** sent in the same sweep that fires
  deadline-reached for the same event (a past deadline means `hoursToDeadline ≤ 0`, outside both
  windows and milestone sends are skipped once status is leaving ACTIVE).

#### 5.3.4 Identifying non-submitters (no contributor accounts)
There are **no contributor accounts** (`requirements.md` §9; `seq04-story05` §4.1). The system
only knows a contributor's email **after** they submit (the form captures `email`). Therefore:

- **What the system can address for 48h/24h reminders is limited to invitee emails it has on
  record.** In MVP 1 the organizer shares the contributor link manually (QR / `wa.me` / email —
  `seq03-story03` §4.4); the platform does **not** store an invitee list. Consequently the set of
  "known non-submitters" the cron can email is, strictly, **the set of invitee emails the platform
  knows minus those who have submitted** — and in MVP 1 the platform may know **none**.
- **This is a genuine product gap, flagged loudly (§13 Q4).** Options:
  - **(A) Recommended MVP 1 behavior:** the 48h/24h "contributor reminder" is, in practice,
    addressed to the **organizer** as a "nudge your contributors" prompt — *"23 of 30 spots
    filled; here's your share link to remind the rest"* — because the organizer is the only party
    whose address the platform reliably holds and who can reach the invitees. The `recipientType`
    is then `organizer` and the channel is email. This keeps the trigger/window machinery intact and
    surprise-safe, and is honest about the data we have.
  - **(B) If an invitee list is added later** (organizer pastes contributor emails at event
    creation — not in scope of Story 3 today), the same trigger emails the actual non-submitters
    (`recipientType = contributor`), computed as `inviteeEmails − submittedEmails`.
- **This doc designs the machinery to support both** (the recipient resolver is a single function,
  §5.5), and **defaults to (A)** for MVP 1 so the feature ships and is useful. The dedupe key for
  the contributor-reminder triggers therefore keys on the **actual recipient email** sent to
  (organizer in mode A; each contributor in mode B) so neither double-fires.

> **Surprise-integrity note for §5.3.4:** under either mode, the recipient resolver passes through
> the honoree filter (§5.5/§10). The honoree is never an invitee and never a recipient.

### 5.4 Idempotency — the `NotificationLog` dedupe key

`NotificationLog` is the single source of "already sent" (`architecture.md` §8.2 rule 3, §8.3
"triggers are recorded in NotificationLog so duplicates can't fire").

- **Dedupe key (logical):** the tuple **`(eventId, trigger, recipientEmail)`**, where `trigger` is
  one of the tokens in §5.3 (`deadline.48h`, `deadline.24h`, `milestone.25`, `milestone.50`,
  `milestone.75`, `deadline.reached.organizer`, `deadline.reached.admin`).
- **Check-before-send:** before dispatching, the dispatcher queries for an existing
  `NotificationLog` row with that tuple and a **terminal-success-or-suppressed** status
  (`sent` or `suppressed_surprise`). If found → **no-op** (do not re-send, do not write a new row).
  - `suppressed_surprise` counts as "already handled" so a honoree-targeted send is attempted at
    most once and then permanently suppressed.
  - `failed` rows do **not** block a retry: a prior `failed` allows a later sweep to try again
    (the next attempt writes a new `sent` row on success). (See §5.6 for in-sweep retry vs
    next-sweep retry.)
- **Race safety / enforcement:** the dedupe must be safe even if (against the concurrency-1
  intent) two sweeps overlapped. **[CONFIRM]** Two implementation options, pick one at code time:
  - **(i) DB-enforced (recommended):** add a **partial unique index** on
    `(eventId, trigger, recipientEmail)` covering only successful/suppressed rows, so a duplicate
    insert violates the constraint and is caught (treated as "already sent"). This makes dedupe
    race-proof at the DB. *Trade-off:* Postgres partial unique index on a status predicate;
    requires storing one row per attempt or upserting.
  - **(ii) Query-then-insert:** the §5.2 concurrency-1 queue already serializes sweeps, so a plain
    "select, if absent then send+insert" is sufficient without a unique index. *Trade-off:* relies
    on the queue's single-concurrency guarantee.
  **Recommendation:** ship **(ii)** for MVP 1 (simpler; the `reminders` queue is concurrency 1 by
  `architecture.md` §8.1) and note (i) as the hardening path. The existing
  `@@index([eventId, trigger])` (`architecture.md` §7.1) accelerates the lookup. (§13 Q5.)
- **Write timing:** write the `NotificationLog` row **after** the `Channel` reports success
  (status `sent`), or immediately with status `failed` on permanent failure, or `suppressed_surprise`
  when the honoree filter blocks it. Never write `sent` before the channel confirms — otherwise a
  failed send would be permanently deduped and never retried.

### 5.5 The shared dispatcher + `Channel` interface

A single **dispatcher** function is the only path through which any notification is sent. It owns:
the honoree filter, dedupe, channel selection, the send, retry, and the `NotificationLog` write.
The sweep never calls a `Channel` directly — it calls the dispatcher.

**Dispatcher input (one logical "notification request"):**
| Field | Meaning |
|---|---|
| `eventId` | the event the notification belongs to (nullable only for non-event notifications; always set here) |
| `trigger` | one of the §5.3 tokens (the dedupe + audit key) |
| `recipientType` | `organizer` \| `contributor` \| `admin` (this story does not send to `editor`) |
| `recipientEmail` | the resolved address (already normalized lowercase) |
| `channel` | `email` (the only MVP 1 value) |
| `templateId` + `templateVars` | which email template (§5.7) + its variables |
| `eventContext` | `{ honoreeEmail, honoreeName, occasionType, submissionDeadline, expected, submitted, organizerName, slug }` — enough for the honoree filter and template rendering without re-querying |

**Dispatcher algorithm (authoritative order):**
1. **Honoree filter (first, always).** If `recipientEmail` equals `eventContext.honoreeEmail`
   (case-insensitive, both normalized) → write `NotificationLog` with status
   `suppressed_surprise`, `errorMessage = "honoree suppression"`, emit a **critical alert**
   (`architecture.md` §13 — "Any honoree-email suppression event"), and **return without sending**.
   (See §10. If `honoreeEmail` is null/absent — current Story 3 state — the comparison is simply
   never true; the filter is a no-op but still present, ready for when the field is collected.)
2. **Dedupe check (§5.4).** If a `sent`/`suppressed_surprise` row exists for
   `(eventId, trigger, recipientEmail)` → **no-op return**.
3. **Resolve `Channel`** for `channel` (MVP 1: always `EmailChannel`).
4. **Send** via the channel with retry/backoff (§5.6).
5. **Record** the outcome in `NotificationLog`: `sent` (+`sentAt`) on success, `failed`
   (+`errorMessage`) on permanent failure.

**The `Channel` interface (described, not coded).** A `Channel` abstracts "deliver a rendered
message over a transport". Methods/inputs/outputs:
| Member | Input | Output | Notes |
|---|---|---|---|
| `name` / `channelType` | — | `"email"` (MVP 1) \| `"whatsapp"` (MVP 2) | the value stored in `NotificationLog.channel` |
| `send(message)` | a transport-agnostic message: `{ to, templateId, templateVars, subject?, ... }` (email-shaped today) | a result `{ ok: boolean, providerMessageId?: string, error?: string, retryable?: boolean }` | the dispatcher uses `retryable` to decide retry vs. permanent-fail |
| `isHealthy?()` (optional) | — | boolean | optional readiness probe for ops; not required |

- The interface is **transport-agnostic in spirit**: `send` takes a recipient + template
  reference + variables and returns a uniform result. The **email shape** (subject/from/HTML/text)
  is an `EmailChannel` concern; a future `WhatsAppChannel` maps the same `templateId`/`templateVars`
  to a WhatsApp template. The dispatcher depends only on the interface, never on Resend/Mailpit.
- **`EmailChannel` (the only MVP 1 implementation):**
  - In **production**, sends via **Resend** using `RESEND_API_KEY`, from `RESEND_FROM_ADDRESS`
    (`architecture.md` §5, §14).
  - In **development/test**, sends via **SMTP to Mailpit** (the local mail catcher from Story 1's
    `docker-compose`) using the SMTP host/port config (§7). This lets devs see rendered emails
    without hitting Resend.
  - Selection of Resend-vs-SMTP is **config-driven** (`config.env` and/or an explicit
    `EMAIL_TRANSPORT` flag, §7), not hardcoded.
  - Templates are React-email / template files (Resend's React email templates per
    `architecture.md` §5) rendered to HTML + a plaintext fallback; `EmailChannel` renders the
    `templateId` with `templateVars` (§5.7).
  - Maps provider failures to `{ ok:false, retryable }` — e.g., 5xx / network / rate-limit →
    `retryable:true`; 4xx invalid-recipient → `retryable:false`.

### 5.6 Retry / backoff & error handling
- **Per-send retry inside the dispatcher:** on a `retryable` channel failure, retry with
  exponential backoff, **3 attempts** total (`architecture.md` §11.1 — "Notification dispatch
  fails → 3 retries"). On exhausting retries → record `failed` (+`errorMessage`), emit an
  **admin alert** ("notification dispatch failed", `architecture.md` §11.1, §13), and **continue**
  with the rest of the sweep.
- **Non-retryable failure** (e.g. invalid recipient address) → record `failed` immediately, no
  retry, admin-visible.
- **Next-sweep retry:** because a `failed` row does not block re-attempts (§5.4), the **next**
  hourly sweep will try again **so long as the event is still selected** by §5.2 (i.e. before its
  status flips / its trigger window is still satisfied). For triggers whose window is a single hour
  (48h/24h), a hard failure in that hour means that specific reminder is effectively lost after the
  window passes — acceptable for transactional reminders; the failure is logged and alerted. For
  deadline-reached, see §5.3.3's flip-after-send decision so a failure leaves the event re-selectable.
- **Sweep-level isolation:** one event's exception never aborts the sweep; wrap per-event
  processing so an unexpected error is logged and the loop continues (the BullMQ job still succeeds
  overall; individual failures live in `NotificationLog`/logs/alerts).
- **BullMQ job retry:** the `reminders.sweep` job itself uses BullMQ retries for *infrastructure*
  failures (e.g., DB unreachable at sweep start). Because the sweep is idempotent (§5.4), a job
  retry is safe and re-sends nothing already logged `sent`.
- **Mailpit/Resend down in dev/prod:** `EmailChannel.send` surfaces a `retryable` error; same path
  as above. If the transport is down for an entire trigger window, that window's reminders fail and
  are alerted (consistent with `architecture.md` §13 "Claude/Whisper sustained 5xx" style alerting
  applied to notifications).

### 5.7 Email template inventory + variables

All copy follows `branding.md`: warm, calm, **no exclamation marks**, **honoree name exactly as
stored**, **occasion-aware noun** (`GRADUATION→"graduation"`, `BIRTHDAY→"birthday"`,
`WEDDING→"wedding"`, `ANNIVERSARY→"anniversary"`, `RETIREMENT→"retirement"`,
`BUSINESS_EVENT→"business event"` — same mapping as `seq03-story03` §5.6), short functional date
form for the deadline ("Submissions close May 17, 6:00 PM"), and the **"by Swara Media"** footer
lockup (`branding.md` §6/§11). Each template has an **HTML** and a **plaintext** variant.

| Template ID | Trigger(s) | Recipient | Purpose / one-line voice | Variables |
|---|---|---|---|---|
| `reminder.contributor.48h` | `deadline.48h` | contributor (mode B) **or** organizer-nudge (mode A, §5.3.4) | "Submissions close in two days." (mode A: "{submitted} of {expected} have shared so far — here's your link to remind the rest.") | `honoreeName`, `occasionNoun`, `deadlineShort`, `contributorUrl` (mode A also: `submitted`, `expected`, `shareLink`/`waLink`) |
| `reminder.contributor.24h` | `deadline.24h` | as above | "Last call — submissions close tomorrow." (calm, no "!") | same as 48h |
| `milestone.organizer` | `milestone.25` / `.50` / `.75` | organizer | "Good progress — {percent}% of expected wishes are in." | `honoreeName`, `occasionNoun`, `percent` (25/50/75), `submitted`, `expected`, `dashboardUrl`, `deadlineShort` |
| `deadline.reached.organizer` | `deadline.reached.organizer` | organizer | "Submissions for {honoreeName}'s {occasion} have closed. Final count: {submitted}." | `honoreeName`, `occasionNoun`, `submitted`, `expected`, `dashboardUrl` |
| `deadline.reached.admin` | `deadline.reached.admin` | admin | "{honoreeName}'s {occasion} is ready for review ({submitted} submissions)." | `honoreeName`, `occasionNoun`, `submitted`, `expected`, `eventAdminUrl`, `slug`, `deadlinePassedAt` |

Notes:
- **One `milestone.organizer` template** parameterized by `percent` rather than three templates —
  but **three distinct `trigger` tokens** (`milestone.25/.50/.75`) so dedupe treats them
  separately. (`templateId` is the same; the dedupe keys on `trigger`, not `templateId`.)
- **No exclamation marks anywhere** (`branding.md` §10); "Last call" / "two days" carry urgency
  without punctuation theatrics (matches `branding.md` §3 example: *"Submissions close tomorrow at
  6 PM. We'll send one more reminder in the morning."*).
- `subject` lines are part of each template and follow the same voice; e.g. organizer milestone
  subject "Halfway to {honoreeName}'s {occasion} tribute".
- The contributor templates link to the **contributor URL** (`/contribute/{slug}` — `seq03-story03`
  §5.7); organizer/admin templates link to the relevant dashboard/admin URL built from
  `NEXT_PUBLIC_APP_URL`. Admin URL points at the per-event admin detail (Story 7 surface).
- Templates **never** reference or expose the honoree's contact and never offer to "notify the
  honoree" (`branding.md` / surprise integrity).

---

## 6. Database Design

This story physically introduces **`NotificationLog`** (the model is fully specified in
`architecture.md` §7.1; this is its first owning story) and adds the **reminder index** to
`Event`. No other model changes.

### 6.1 `NotificationLog` model — fields
Matches `architecture.md` §7.1 exactly (so no later sender renames anything):

| Field | Type | Null? | Default | Notes |
|---|---|---|---|---|
| `id` | String (cuid) | no | `cuid()` | PK |
| `eventId` | String | **yes** | — | FK → `Event.id`, **`onDelete: SetNull`** (per §7.1; retention/right-to-delete keeps a de-identified audit trail after the event is gone — `architecture.md` §11.4) |
| `event` | relation `Event?` | — | — | `@relation(fields: [eventId], references: [id], onDelete: SetNull)` |
| `recipientType` | String | no | — | `"organizer"` \| `"contributor"` \| `"admin"` (also `"editor"` for later stories) — string, not enum, per §7.1 |
| `recipientEmail` | String | no | — | the address sent to; **redacted/hashed in non-prod logs** (§10/§11) but stored here for audit (§7.1) |
| `channel` | String | no | — | `"email"` (MVP 1) \| `"whatsapp"` (MVP 2) — string per §7.1 |
| `trigger` | String | no | — | one of the §5.3 tokens; part of the dedupe key |
| `status` | String | no | — | `"sent"` \| `"failed"` \| `"suppressed_surprise"` (the three values from §7.1) |
| `errorMessage` | String | yes | — | failure reason or `"honoree suppression"` |
| `sentAt` | DateTime | no | `now()` | attempt/record timestamp; for `sent` this is delivery time |

> Field names/types/string-vs-enum choices are taken verbatim from `architecture.md` §7.1 — do not
> "improve" them to enums in this story (consistency across stories outweighs type-safety here; a
> later story may migrate to enums uniformly if desired). Flagged §13 A9.

### 6.2 Indexes & constraints
| Index / constraint | Definition | Purpose |
|---|---|---|
| `@@index([eventId, trigger])` | from `architecture.md` §7.1 | accelerates the dedupe lookup (find rows for this event+trigger) |
| **(optional, recommended hardening)** partial unique on `(eventId, trigger, recipientEmail)` where `status IN ('sent','suppressed_surprise')` | new | DB-enforced at-most-once (§5.4 option (i)) — **[CONFIRM]**; ship only if option (i) is chosen |
| FK `eventId → Event.id` | `onDelete: SetNull` | keep audit row after event deletion (§7.1, §11.4) |

### 6.3 `Event` changes
- **Add** `@@index([status, submissionDeadline])` — the reminder-sweep index from
  `architecture.md` §7.1, **explicitly deferred from Story 3** to its consuming story (this one),
  per `seq03-story03` §6.1 ("Do not add `@@index([status, submissionDeadline])` yet — that index
  is for the reminder cron, Story 18").
- **Add** the back-relation `notifications NotificationLog[]` on `Event` (the other side of the FK).
- **No new `Event` columns.** In particular, **no `lastMilestoneSent`/prior-count column** — §5.3.2
  deliberately uses `NotificationLog` instead of a stored prior count (§13 Q2). `honoreeEmail`
  remains as-is (whatever Story 3 merged — currently absent per `seq03-story03` A1; the honoree
  filter handles null, §5.5/§13 A2).

### 6.4 Migration notes
- Migration name e.g. `add_notification_log` — creates the `notification_log` table, its
  `@@index([eventId, trigger])`, the FK with `ON DELETE SET NULL`, the `Event` back-relation
  (virtual), and the new `Event @@index([status, submissionDeadline])`. (Plus the partial unique
  index only if §5.4 option (i) is selected.)
- **Additive only** — no backfill, no destructive change; safe to `prisma migrate deploy` against
  `swara_prd` (Story 1 §11 pooled/direct-URL convention: `DATABASE_URL` at runtime, `DIRECT_URL`
  for `prisma migrate`).
- Run `prisma generate` after migrate so `NotificationLog` types are available to web + workers;
  verify `npm run typecheck` clean.
- **Prerequisite:** the migration references `Event.id` and `Event.status`/`submissionDeadline`;
  Story 3's `Event` migration must precede it in history (it will — Story 3 is far upstream).

---

## 7. External Services / Integrations / Config

### 7.1 External services
- **Resend** (prod email) — `architecture.md` §5, §14. New account/key needed for real sends.
- **Mailpit** (dev SMTP catcher) — already in Story 1's `docker-compose` (`development-setup.md`).
  No new infra; `EmailChannel` points SMTP at it in dev/test.
- **Redis / BullMQ** — already provisioned (Story 1); reused for the `reminders` repeatable job +
  `notifications` work. No new Redis.
- **No WhatsApp** integration this story (MVP 2).

### 7.2 Config — add in BOTH `src/config/env.ts` and `src/config/index.ts`
Per the load-bearing convention (`story-01-foundation.md` §3, `architecture.md` §16): every new var
is read **only** in `src/config/env.ts` (raw) and validated/typed in `src/config/index.ts` (Zod).
No `process.env` elsewhere (ESLint `no-restricted-syntax`). Add each to `.env.example` too.

**Raw reads to add in `src/config/env.ts`:**
`RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `EMAIL_TRANSPORT`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, `ADMIN_NOTIFY_EMAIL`, `REMINDERS_CRON_ENABLED`, `REMINDERS_CRON_PATTERN`,
`NOTIFICATIONS_MAX_RETRIES`.

**Typed `notifications` (and `reminders`) block to add in `src/config/index.ts`:**
| Config field | Env var | Type | Default | Notes |
|---|---|---|---|---|
| `email.transport` | `EMAIL_TRANSPORT` | enum `resend` \| `smtp` | `smtp` in dev/test, `resend` in prod | selects `EmailChannel` backend; default derived from `config.env` if unset |
| `email.resendApiKey` | `RESEND_API_KEY` | string | — | required when `transport=resend`; optional otherwise (refine in Zod) |
| `email.fromAddress` | `RESEND_FROM_ADDRESS` | string (email) | — | the `From:` for all sends (e.g. `Swara Magical Memories <notifications@swaramagical.com>`) |
| `email.smtp.host` | `SMTP_HOST` | string | `localhost` | Mailpit host in dev |
| `email.smtp.port` | `SMTP_PORT` | int | `1025` | Mailpit default SMTP port |
| `email.smtp.user` | `SMTP_USER` | string? | — | usually empty for Mailpit |
| `email.smtp.pass` | `SMTP_PASS` | string? | — | usually empty for Mailpit |
| `notifications.adminEmail` | `ADMIN_NOTIFY_EMAIL` | string (email) | — | recipient for `deadline.reached.admin` + dispatch-failure/honoree-suppression alerts |
| `notifications.maxRetries` | `NOTIFICATIONS_MAX_RETRIES` | int | `3` | per-send retry budget (§5.6; matches `architecture.md` §11.1) |
| `reminders.cronEnabled` | `REMINDERS_CRON_ENABLED` | boolean | `true` (`false` in test/CI) | gate the repeatable-job registration |
| `reminders.cronPattern` | `REMINDERS_CRON_PATTERN` | string | `0 * * * *` | hourly; overridable for testing |

- **Zod refinement:** when `email.transport === 'resend'`, require `email.resendApiKey` and
  `email.fromAddress`; when `'smtp'`, require `email.smtp.host`/`port`. This keeps dev runnable
  without a Resend key and prod safe.
- `.env.example` gets all of the above with dev defaults (Mailpit SMTP `localhost:1025`,
  `EMAIL_TRANSPORT=smtp`, `ADMIN_NOTIFY_EMAIL=admin@example.com`, `REMINDERS_CRON_ENABLED=false`
  for safe local default unless explicitly testing the cron).
- `RESEND_FROM_ADDRESS` / `RESEND_API_KEY` align with `architecture.md` §14's `RESEND_API_KEY`
  + `RESEND_FROM_ADDRESS` names exactly.

---

## 8. Seed Data

Extend the idempotent dev/test seed (Story 3/5/6) to create events + submissions positioned to
exercise **every** window/threshold/flow when a sweep runs at "now". Use **relative** deadlines
(now-anchored) so the windows are hit whenever the seed runs. Seed only in non-production (guard on
`config.env`), and make it upsert-by-stable-key (idempotent).

| Seed fixture | Setup | Exercises |
|---|---|---|
| Event "48h window" | `status=ACTIVE`, `submissionDeadline = now + 47.5h`, `expected=10`, e.g. 1 submission | 48h contributor reminder window (§5.3.1); also < 25% so no milestone |
| Event "24h window" | `status=ACTIVE`, `submissionDeadline = now + 23.5h`, `expected=8`, ~2 submissions | 24h contributor reminder window |
| Event "milestone 25%" | `status=ACTIVE`, `submissionDeadline = now + 5d`, `expected=4`, **1** submission (=25%) | `milestone.25` fires; 50/75 do not |
| Event "milestone 50%/75% jump" | `status=ACTIVE`, `submissionDeadline = now + 5d`, `expected=4`, **3** submissions (=75%) with **no prior milestone log** | proves a multi-threshold jump fires 25+50+75 in one sweep (§5.3.2) |
| Event "deadline reached" | `status=ACTIVE`, `submissionDeadline = now - 10m`, `expected=6`, 6 submissions | `deadline.reached.organizer` + `deadline.reached.admin`; status flips to `DEADLINE_PASSED` |
| Event "already notified" | `status=ACTIVE`, deadline in 48h window, **with a pre-seeded `NotificationLog` `sent` row** for `deadline.48h` to its recipient | proves dedupe: sweep produces **no** duplicate row/email |
| Event "honoree case" **[only if `honoreeEmail` exists]** | an event whose `honoreeEmail` equals a contributor/organizer address used as a recipient | proves the honoree filter logs `suppressed_surprise` and never sends |

Also seed:
- A **sample organizer** `User` (reuse Story 3's, e.g. `organizer@example.com`) as the recipient of
  organizer-bound triggers.
- The **admin recipient** is config (`ADMIN_NOTIFY_EMAIL`), not a seeded row — but document that the
  seed's `.env.example` sets it to a Mailpit-visible address so admin alerts are observable locally.
- For the contributor-reminder fixtures, seed a couple of `Submission` rows with emails so
  "submitted vs non-submitter" is non-trivial (and, in mode B if ever enabled, an invitee list).

All seeded `NotificationLog` rows use realistic `trigger`/`status`/`recipientEmail` so dedupe tests
have data; idempotent upsert by a stable composite (e.g. fixed ids).

---

## 9. Testing

Follows the Story 1 pattern (Vitest, `tests/unit` + `tests/integration`, `vite-tsconfig-paths`).
DB/infra-touching tests are gated by **`SKIP_INTEGRATION`** so unit-only runs (and CI without a DB
/ Mailpit) stay green. Email sends are **mocked** in unit tests (stub the `Channel`); integration
tests assert against Mailpit or a captured-send fake.

### 9.1 Unit tests (pure logic, no DB, no network)
| Test | Asserts |
|---|---|
| **48h window math** | `hoursToDeadline` exactly 48, 47.5, 47 → in window; 48.01 and 46.99 → out. Boundaries inclusive (§5.3.1, A6). |
| **24h window math** | 24 / 23.5 / 23 → in; 24.01 / 22.99 → out. |
| **Milestone threshold crossing** | ratios just below/at/above 0.25/0.50/0.75 fire/don't fire correctly; a 0→75% jump with no prior log yields all three milestone triggers; `expected ≤ 0` → no milestones (no divide-by-zero). |
| **Dedupe decision** | given an existing `sent` (or `suppressed_surprise`) row for `(eventId,trigger,recipient)` → dispatcher returns no-op; given only a `failed` row → proceeds; given no row → proceeds. |
| **Honoree suppression** | when `recipientEmail == honoreeEmail` (case/space-normalized) → outcome is `suppressed_surprise`, **no channel send call**, critical alert emitted; when `honoreeEmail` is null → filter is a no-op (send proceeds). |
| **Channel dispatch / interface** | dispatcher calls `Channel.send` with the right `{to, templateId, templateVars}`; maps `{ok:false, retryable:true}` → retry then `failed`; `{ok:false, retryable:false}` → immediate `failed`; `{ok:true}` → `sent`. Swapping in a fake `Channel` (no Email) works (proves channel-agnosticism). |
| **Recipient resolver** | mode A (default) resolves contributor-reminder recipient to the organizer; mode B (if invitee list present) resolves to `invitees − submitters`; both pass through the honoree filter. |
| **Eligible predicate** | the §5.2 selection includes future-deadline ACTIVE events and just-passed (≤1h) ACTIVE events; excludes non-ACTIVE and long-past events. |
| **Template rendering** | each template (§5.7) renders with sample vars: contains `honoreeName` verbatim, correct `occasionNoun`, the right link, **no exclamation mark**, "by Swara Media" footer; plaintext + HTML both produced. |
| **Deadline-reached status flip** | flip only applies when `status='ACTIVE'` (conditional); a second evaluation does not re-flip. |

### 9.2 Integration tests (DB + mocked/local email; `SKIP_INTEGRATION` gates)
| Test | Flow |
|---|---|
| **Sweep fires expected rows once** | seed the §8 fixtures → run one sweep → assert exactly the expected `NotificationLog` rows exist (one per due `(event,trigger,recipient)`), correct `status=sent`, and the right number of emails captured. |
| **Re-run is idempotent** | run the sweep **twice** → assert **no** new rows and **no** new emails the second time (dedupe via `NotificationLog`). |
| **Milestone multi-jump** | the 75%-with-no-prior-log fixture → one sweep writes `milestone.25` + `.50` + `.75` rows. |
| **Deadline-reached** | the past-deadline fixture → organizer + admin rows written, emails captured, and `Event.status` becomes `DEADLINE_PASSED`; the event is **not** re-selected on a subsequent sweep. |
| **Dedupe against pre-seeded row** | the "already notified" fixture → sweep does not duplicate the pre-existing `deadline.48h` row/email. |
| **Honoree suppression end-to-end** *(if `honoreeEmail` present)* | a recipient equal to `honoreeEmail` → a `suppressed_surprise` row is written and **zero** emails to that address are captured. |
| **Email transport** | with `EMAIL_TRANSPORT=smtp`, sends land in Mailpit (assert via Mailpit API) — or, if Mailpit unavailable, the `EmailChannel` is pointed at an in-memory capture fake. Resend path is asserted via a mocked Resend client (no live send in tests). |
| **Dispatch failure path** | force the channel to return a permanent failure → a `failed` row with `errorMessage` is written, an admin alert is emitted, and the sweep still completes for other events. |

### 9.3 Mocking & gating
- **Unit:** stub the `Channel` (no Resend SDK, no SMTP); stub the clock (`now`) so window math is
  deterministic; stub the alert sink to assert critical alerts.
- **Integration:** real Prisma against `swara_test`; email via Mailpit container (Story 1 compose)
  or capture-fake; **never** a live Resend send in CI. Gate all DB/Mailpit tests behind
  `SKIP_INTEGRATION` (mirrors `seq04`/`seq05`). Set `REMINDERS_CRON_ENABLED=false` in test so the
  scheduler doesn't auto-fire; tests invoke the sweep directly.

---

## 10. Security & Surprise Integrity

| Concern | Control |
|---|---|
| **Honoree never notified (critical)** | The dispatcher's **first** step compares `recipientEmail` to `Event.honoreeEmail` (normalized, case-insensitive); on match it writes `suppressed_surprise`, emits a critical alert (`architecture.md` §13), and returns **without sending** (`architecture.md` §10.1). This is a **shared, single** filter every notification path goes through — the sweep never bypasses it. If `honoreeEmail` is absent (current Story 3 state, §13 A2), the filter is present and inert, ready for when the field exists. |
| **Belt-and-braces logging of any honoree attempt** | Even a suppressed attempt is recorded (`suppressed_surprise`) so a data-model bug (a honoree address leaking into a recipient list) is **visible and alerted**, not silent (`architecture.md` §7.1, §13). |
| **No honoree exposure in content** | Templates never address or reference the honoree's contact and never offer to notify them (`branding.md`, surprise integrity). |
| **Recipient redaction in non-prod logs** | `recipientEmail` is stored in `NotificationLog` for audit but **must not** be logged in plaintext at info level in non-prod; logs hash/redact it (consistent with `architecture.md` §10.1/§10.3 redaction posture, and `seq04`/`seq05` PII discipline). The DB column is the audit of record; structured logs are not. |
| **No email URL/secret leakage** | Resend API key, SMTP creds, and rendered links are never logged. (Links to the contributor/dashboard are not secrets but follow the same no-URL-logging discipline.) |
| **Rate / abuse** | The sweep is system-initiated and bounded (one email per `(event,trigger,recipient)` ever, enforced by dedupe), so it cannot spam a recipient even under repeated sweeps. Per-event isolation prevents one event from amplifying sends. No external trigger can cause arbitrary sends (no public endpoint added). |
| **Least exposure** | Only `ADMIN_NOTIFY_EMAIL` and the resolved organizer/contributor addresses are ever used; no honoree field, no broadcast list. |

---

## 11. Observability / Audit

| Signal | Where | Notes |
|---|---|---|
| **Audit of every notification** | `NotificationLog` rows | The table **is** the audit trail (`architecture.md` §7.1 §8.2): every `sent` / `failed` / `suppressed_surprise` with `eventId`, `recipientType`, `channel`, `trigger`, `sentAt`. Retained (de-identified) after event deletion via `onDelete: SetNull` (§6.1, `architecture.md` §11.4). |
| **Structured logs** | `src/lib/logger.ts` | Sweep start/end (events scanned, triggers evaluated, sends attempted) at info; per-send outcome at info/debug **with recipient redacted/hashed**; dedupe no-ops at debug; failures at error. Never log raw recipient at info in prod (§10). |
| **Critical alerts (page someone)** | alert sink (OTel/Honeycomb per `architecture.md` §13) | (1) **Any honoree suppression** — "potential data model bug" (`architecture.md` §13). (2) **Notification dispatch failure** after retries (`architecture.md` §11.1, §13). |
| **Metrics (when observability lands)** | OTel per `architecture.md` §13 | sweep duration, events scanned per sweep, sends by `trigger` and `status`, failure rate, suppression count (should be ~0). Useful to confirm the cron is actually running each hour. |
| **Cron liveness** | logs/metric | Each sweep logs a heartbeat; absence of an hourly heartbeat is itself an ops signal (ties to `architecture.md` §13 worker-uptime alerting; covers the "missed hour" trade-off in §5.1). |

---

## 12. Definition of Done

Story 18 is **done** only when all are true:
- [ ] `NotificationLog` model added per §6 (fields/types/string-status verbatim from
      `architecture.md` §7.1); `@@index([eventId, trigger])`, FK `onDelete: SetNull`, and the new
      `Event @@index([status, submissionDeadline])` present; migration created + applied to dev,
      test, and prod (`prisma migrate deploy`); `prisma generate` clean; `typecheck` green.
- [ ] All new env vars (§7.2) added in **both** `src/config/env.ts` and `src/config/index.ts`
      (+ `.env.example`); transport-conditional Zod refinement in place; **no** `process.env`
      outside `src/config/env.ts` (ESLint passes).
- [ ] An hourly `reminders.sweep` repeatable BullMQ job is registered at worker boot
      (gated by `REMINDERS_CRON_ENABLED`); the `reminders` queue is concurrency 1 (`architecture.md`
      §8.1); the sweep is also manually invokable for tests/ops.
- [ ] The sweep selects the right events (§5.2) and evaluates 48h/24h windows, 25/50/75%
      milestones, and deadline-reached actions with the exact windows/thresholds (§5.3).
- [ ] Every send routes through the `Channel` interface; `EmailChannel` (Resend prod / Mailpit dev,
      config-selected) is the only implementation; the dispatcher is channel-agnostic.
- [ ] Dedupe via `NotificationLog` guarantees at-most-once per `(eventId, trigger, recipientEmail)`;
      re-running the sweep writes no duplicate rows and sends no duplicate emails.
- [ ] The honoree-suppression filter is the dispatcher's first step; any honoree-targeted send is
      `suppressed_surprise` + critical alert + no delivery; `honoreeEmail=null` is handled.
- [ ] Deadline-reached flips `ACTIVE → DEADLINE_PASSED` conditionally/idempotently after the two
      sends (§5.3.3 decision).
- [ ] Retry/backoff (3 attempts) on transient send failure; permanent failure → `failed` row +
      admin alert; one event's failure never aborts the sweep.
- [ ] Email templates (§5.7) exist with HTML+plaintext, in brand voice (warm, no "!", exact honoree
      name, occasion-aware, "by Swara Media" footer); render tests pass.
- [ ] Seed creates fixtures exercising every window/threshold/flow + a dedupe fixture; idempotent;
      non-prod only.
- [ ] Unit + integration tests (§9) pass; integration tests skip cleanly under `SKIP_INTEGRATION`;
      no live Resend send in CI.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; deploy succeeds.
- [ ] No TODO comments left in committed code; `docs/stories.md` Story 18 row marked done.

---

## 13. Open Questions / Assumptions

### Assumptions (proceed unless told otherwise)
- **A1 — Worker/BullMQ conventions.** `seq06-story09-workers-quality-scoring.md` is absent; this
  story stands up the minimal `reminders` repeatable job + `notifications` path per
  `architecture.md` §8 and the Story 1 worker scaffold. If Story 9 lands first, reuse its
  conventions and reconcile §5.1/§5.5.
- **A2 — `honoreeEmail` may be null/absent.** Story 3 (`seq03-story03` A1) does not collect it. The
  honoree filter is implemented now and is a **no-op when null**, fully active the moment the field
  is populated. No behavior change required when the field later appears.
- **A3 — Dependency on Story 6 is transitive.** Story 18 doesn't read `MediaItem`; it depends on
  Story 6 only via the chain to `Submission`/`Event`. A media-less submission still counts as
  "submitted".
- **A4 — Just-passed slack window.** §5.2 widens the architecture predicate to include events whose
  deadline passed within ~the last sweep interval (≈1h) so deadline-reached is reliably caught.
  Exact slack (1h vs 2h) is tunable; 1h proposed.
- **A5 — Single sweep job, in-process per-event loop.** MVP 1 volume is low; no fan-out to
  per-event child jobs. Revisit if event counts grow.
- **A6 — Window boundaries inclusive** (`47 ≤ h ≤ 48`, `23 ≤ h ≤ 24`). Dedupe makes inclusivity
  safe regardless.
- **A7 — Milestone "crossed" = ratio met AND not yet logged.** No prior-count column; the dedupe is
  the memory. Multi-threshold jumps fire all pending milestones in one sweep.
- **A8 — No unsubscribe / preference center in MVP 1.** All sends are transactional reminders to
  organizer/admin (and, in mode B, opted-in-by-submitting contributors). Revisit for compliance if
  contributor cold-emailing is ever added (mode B).
- **A9 — `NotificationLog` keeps string `status`/`channel`/`recipientType`** (not Prisma enums) to
  match `architecture.md` §7.1 verbatim and to keep this migration aligned with every other
  sender. A uniform enum migration, if wanted, is a separate cross-cutting change.

### Open questions (decide before/with build)
- **Q1 — Cron platform: BullMQ repeatable (recommended, §5.1) vs platform cron (Vercel/Railway)?**
  This doc recommends BullMQ repeatable for infra parity and to keep the work in the worker. Confirm,
  or choose a platform cron hitting an internal worker-trigger (and accept the extra moving part).
- **Q2 — Milestone tracking via `NotificationLog` (no prior-count column)?** Recommended (§5.3.2).
  Alternative is an `Event.lastMilestoneSent` column; this doc rejects it as redundant with the log.
- **Q3 — Deadline-reached: flip status before or after the sends?** This doc flips **after** the two
  sends (with retries) so a hard send-failure leaves the event `ACTIVE` for the next sweep to retry
  (§5.3.3). Confirm; the alternative (flip first) risks losing the organizer/admin notification if
  the send then fails permanently.
- **Q4 — Who receives the 48h/24h "contributor reminder" given no contributor accounts and no
  stored invitee list?** This is the biggest product question (§5.3.4). This doc defaults to
  **mode A** (nudge the organizer with the share link + progress) for MVP 1 because the platform
  reliably holds only the organizer's address. **Mode B** (email actual non-submitters) requires an
  invitee-email list captured at/after event creation — **not currently in Story 3's scope**. Decide
  whether to (a) ship mode A now, (b) add invitee capture to enable mode B, or (c) both (mode A now,
  mode B when invitee capture lands). Recommend (a)→(c).
- **Q5 — Dedupe enforcement: query-then-insert (§5.4 ii, recommended given concurrency-1) vs a DB
  partial unique index (§5.4 i)?** Confirm; (ii) is simpler, (i) is race-proof.
- **Q6 — Email transport selection.** Default `EMAIL_TRANSPORT` from `config.env` (smtp in
  dev/test, resend in prod) vs always-explicit env var? This doc allows both with an explicit
  override. Confirm the default-derivation is acceptable.
- **Q7 — Admin recipient: single `ADMIN_NOTIFY_EMAIL` vs a queryable set of `role=ADMIN` users?**
  This doc uses a single config address for MVP 1 simplicity (`requirements.md` §5.4 "alert Swara
  Admin team"). Confirm, or resolve admins from the `User` table (`role=ADMIN`) and fan out.
- **Q8 — Should a hard-failed single-hour reminder (48h/24h) be retried in a later window?** Once
  the 47–48h window passes, the 48h reminder can't naturally re-fire. This doc accepts the loss
  (logged + alerted). Confirm, or add a "catch-up if not sent and deadline still future" relaxation.
