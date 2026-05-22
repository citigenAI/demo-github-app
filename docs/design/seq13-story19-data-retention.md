# Sequence 13 / Story 19 — Data Retention (30-Day Deletion)

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (the daily cron sweep queries + windows, the reminder email, the extension logic
+ caps, the hard-delete trigger, what is purged vs retained, error cases) so a later
code-generation step implements exactly this and nothing more. Where a value is a proposal
awaiting confirmation it is flagged **[CONFIRM]**; genuine ambiguities are listed in §13,
not silently chosen.

| Meta | Value |
|---|---|
| Story number / title | Story 19 — Data retention (30-day deletion) |
| Sequence number | 13 (this is the 13th design in build order) |
| Epic | J — Lifecycle (can land in parallel late in development) |
| Depends on | **Story 15** (Delivery: share page + download link — delivery happens before retention; the reminder offers download); transitively Story 3 (`Event` + `eventDate`), Story 18 (cron + `Channel`/`NotificationLog`), Story 20 (soft/hard-delete executor + sweep) |
| Parallel with | Stories 18 (reminders cron), 20 (right to delete) — but **reuses** their machinery |
| Reuses (does not reinvent) | **Story 20**'s `hardDeleteEvent(eventId)` executor + soft-delete columns + `deleted/` S3 prefix + de-identified audit; **Story 18**'s BullMQ repeatable-cron pattern + `Channel`/`EmailChannel` + dispatcher (honoree filter + `NotificationLog` dedupe) |
| Complexity | M (1–3 days) |

> **Sources of truth honored:** `docs/requirements.md` §8 (Data retention: keep all event
> data for 30 days after event date, then send reminder, then hard-delete 7 days later;
> organizer can extend up to 2 times, 30 days each); `docs/architecture.md` §11.4 (Data
> Retention & Deletion — the canonical scheduled-deletion lifecycle, the retention schema
> additions, what hard-delete removes vs retains), §8.3 (cron sweep context), §8.1
> (`reminders` queue), §8.2 (idempotency contract), §10.1 (surprise integrity / honoree
> filter), §13 (critical alerts), §14 (env), §16 (config single-source); `docs/stories.md`;
> `docs/branding.md` (retention reminder email + dashboard copy voice). Sibling designs:
> **`seq06-story20-right-to-delete.md`** (the shared soft/hard-delete + sweep — REUSED
> verbatim), **`seq06-story18-reminder-automation.md`** (cron + `Channel`/`NotificationLog`
> — REUSED), `seq03-story03-event-creation.md` (`Event` model + `eventDate`). The Story 15
> delivery design (`seq12-story15-...`) is **not present** in the repo at the time of
> writing — see §13 Q-anchor on the date that anchors retention; this doc assumes
> `eventDate` per `architecture.md` §11.4 and flags the alternative.

> **Schema-state caveat.** As of this writing, live `prisma/schema.prisma` contains only
> the `User` model; `Event`, `Submission`, `NotificationLog`, `AuditLog`, and the
> soft/hard-delete columns are introduced by their owning stories (3, 5, 18, 20, …). This
> document assumes those exist on `main` exactly per `architecture.md` §7.1/§11.4 and the
> sibling designs when Story 19 lands. If field names diverge, reconcile §6 against the
> merged schema before generating code.

---

## 1. Story Summary

Story 19 implements the **default (scheduled) retention lifecycle** mandated by
`requirements.md` §8 and `architecture.md` §11.4:

```
eventDate ── +30d ── reminder sent ── +7d ── hard delete (data destroyed)
              │          (set retentionReminderSentAt,
              │           compute retentionDeleteAt = +37d)
              │
              └── organizer may "Extend retention by 30 days"
                  up to 2 times (max 90 days post-event), then forced delete
```

A **daily cron sweep** (a *separate* schedule from Story 18's hourly reminder sweep — they
must not be folded together, per `architecture.md` §11.4 / `seq06-story18` §2 Out-of-scope)
does two things each run:

1. **Reminder pass.** For every live (not-yet-deleted) event whose `eventDate + 30 days <
   now` and `retentionReminderSentAt IS NULL`, send a **single reminder email to the
   organizer only** (via Story 18's `Channel`/dispatcher, honoree-suppressed), set
   `retentionReminderSentAt = now`, and compute `retentionDeleteAt` (= 7 days out, capped at
   90 days post-event — §5.2).
2. **Delete pass.** For every event that has been reminded and is now past its
   `retentionDeleteAt` and has not been extended beyond the cap, **trigger the soft-delete +
   the SHARED `hardDeleteEvent(eventId)` executor from Story 20** (§5.3). Story 19 does
   **not** re-implement purge, S3 deletion, cascade, or de-identified audit retention — it
   **reuses Story 20's machinery**; only the *trigger* differs (a 30/37-day timer instead of
   a user click).

Separately, the organizer can **extend retention by 30 days** from their dashboard, up to
**2 times** (max **90 days** post-event); after the second extension, the next due delete is
**forced** (§5.4). The reminder also offers the organizer a way to **download the final
video now** (delivery from Story 15) before deletion.

This story adds **no new purge logic and no new sweep host** — it adds the **retention
timestamps**, the **retention reminder template + trigger**, the **extension action**, and
the **daily sweep** that wires the existing executor to the timer.

### Success criteria

- [ ] A **daily** cron sweep runs in the worker process (separate from Story 18's hourly
      sweep), gated by config, and is manually invokable for tests/ops.
- [ ] **Reminder pass:** an event past `eventDate + RETENTION_DAYS` with no reminder yet gets
      exactly **one** organizer-only reminder email; `retentionReminderSentAt` +
      `retentionDeleteAt` are set; re-running the sweep sends **no** duplicate.
- [ ] **Delete pass:** an event past `retentionDeleteAt` (and not extended within cap) is
      soft-deleted and then hard-deleted via **Story 20's `hardDeleteEvent`**; nothing is
      purged before the reminder + grace window have elapsed (or the cap is hit).
- [ ] **Extension:** the organizer can extend by 30 days up to **2×** (max 90 days
      post-event); the 3rd attempt is rejected; after the cap, delete is forced.
- [ ] Idempotency: all transitions are derived from the retention timestamps; a re-run is a
      no-op for already-handled events.
- [ ] The reminder goes to the **organizer only**; it passes through the honoree-suppression
      filter; it offers download + extend.
- [ ] Hard delete reuses Story 20's purge: DB cascade + S3 (both prefixes, all versions) +
      de-identified `NotificationLog`/`AuditLog` retained.
- [ ] New env vars in **both** `src/config/env.ts` and `src/config/index.ts`; no `process.env`
      outside `src/config/env.ts`.
- [ ] Unit + integration tests (§9) pass; integration honors `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green.

---

## 2. Scope

### In scope (this story)

- **The scheduled 30-day retention lifecycle:**
  - **Reminder at `eventDate + 30d`** — one organizer-only email; sets
    `retentionReminderSentAt`; computes `retentionDeleteAt`.
  - **Hard delete at `+37d`** (`retentionReminderSentAt + 7d`) **unless extended** — via
    Story 20's soft-delete + `hardDeleteEvent` executor.
  - **Organizer extension** of retention by **30 days**, **up to 2 times** (max **90 days**
    post-event), then forced delete.
- **A daily cron sweep** (reusing Story 18's BullMQ repeatable-job scheduler, on the
  `reminders`-style low-priority queue) running both the reminder pass and the delete pass.
- The **retention reminder email** (organizer only) via Story 18's `Channel`/dispatcher +
  `NotificationLog` dedupe + honoree filter; a new template (§5.6).
- The **organizer dashboard retention status** (delete-date countdown) + **"Download now"**
  and **"Extend retention by 30 days"** actions (disabled after 2 extensions) on the event
  detail page (Story 3/7 surface) (§4).
- Schema additions to `Event`: `retentionReminderSentAt`, `retentionExtendedCount` (default
  0), `retentionDeleteAt` — and **reconciliation** with Story 20's already-present
  `deletedAt`/`hardDeleteAt` (shared columns; §6).
- Config: retention-window vars (`RETENTION_DAYS`, `RETENTION_GRACE_DAYS`,
  `RETENTION_MAX_DAYS`, `RETENTION_MAX_EXTENSIONS`, retention-sweep cron) in **both**
  config files; reuse `RESEND_*` and `DELETION_GRACE_HOURS` semantics where applicable (§7).
- Seed: events positioned to exercise reminder-due, delete-due, and extended states (§8).
- Unit + integration tests; `SKIP_INTEGRATION` honored (§9).

### Out of scope (deferred — with owners)

| Item | Where it lands |
|---|---|
| **User-initiated deletion** (organizer "Delete this event"; contributor self-service submission deletion) | **Story 20** — Story 19 **reuses** its `hardDeleteEvent` executor + soft-delete columns + sweep; it does **not** add the user-facing delete-now controls |
| The **hard-delete executor itself** (purge DB + S3 + de-identified audit) | **Story 20** (REUSED verbatim — §5.3) |
| The **soft-delete `deletedAt`/`hardDeleteAt` columns** + the `deleted/` S3 prefix move | **Story 20** (REUSED; this story sets the same columns via the timer — §6) |
| The **`Channel`/`EmailChannel`/dispatcher/honoree filter/`NotificationLog` dedupe** | **Story 18** (REUSED — §5.5) |
| The **BullMQ repeatable-cron scheduler** + `reminders` queue | **Story 18 / Story 9** (REUSED — §5.1) |
| **Contributor-submission-level** retention/auto-delete (per-submission timers) | Out of MVP 1 — retention is **event-scoped**; contributor right-to-delete is Story 20 |
| **Self-service restore / un-delete** within the post-reminder window | Out of MVP 1 (support-only; see Story 20 §13 Q5) |
| The **delivery share page + download link** the reminder links to | **Story 15** (this story only **links** to it) |
| **Stripe refund** on auto-deletion | Out (deletion ≠ refund; matches Story 20 §13 Q6) |
| The **hourly reminder sweep** (48h/24h/milestone/deadline) | **Story 18** (a *different*, hourly sweep — not folded in) |

---

## 3. Dependencies & Sequence

### Must already be on `main`

- **Story 1 (Foundation):** typed `config` (`src/config/env.ts` + `src/config/index.ts`),
  Prisma client singleton (`src/lib/db.ts`), `src/lib/logger.ts`, Redis client
  (`src/lib/redis.ts`), the **worker entry point** (`src/workers/index.ts`), CI.
- **Story 3 (Event creation):** `Event` model with `eventDate DateTime`, `organizerId` (→
  `User`), `honoreeName`, `occasionType`, `status`, `slug`; `AuditLog` model; `User ↔ Event`
  relation. (`eventDate` is the retention anchor — §13 Q1.) The retention fields were
  **explicitly deferred** from Story 3 to this story (`seq03-story03` §6.1 "retention fields
  — Story 19").
- **Story 18 (Reminder automation):** the **BullMQ repeatable-job scheduler** + `reminders`
  queue, the **`Channel` interface + `EmailChannel`** (Resend prod / Mailpit dev), the
  **shared dispatcher** (honoree filter + `NotificationLog` dedupe + retry), and the
  `NotificationLog` model. Story 19 adds **one trigger + one template**, no new plumbing.
- **Story 20 (Right to delete):** the **shared `hardDeleteEvent(eventId)` executor**, the
  soft-delete columns `Event.deletedAt`/`Event.hardDeleteAt`, the **hard-delete cron sweep**
  loop, the storage `deletePrefix`/`moveToDeletedPrefix` capabilities, the `deleted/` S3
  prefix, and the de-identified `AuditLog`/`NotificationLog` retention. Story 19 **calls
  `hardDeleteEvent` unchanged**.
- **Story 15 (Delivery):** the share page + presigned **download link** the reminder offers
  ("Download now"). Story 19 depends on Story 15 per `stories.md` (Story 19 "Depends On:
  15") so the reminder can point at a real download. If Story 15's exact route/helper name
  differs, reconcile §5.6 (the download URL builder) against it.

> **Dependency flag.** `stories.md` lists Story 19's hard dependency as **Story 15**. The
> *machinery* dependencies (Story 18 cron/`Channel`, Story 20 executor) are not in that one
> line but are load-bearing for this design's "reuse, don't reinvent" mandate. If Story 19
> must ship before Story 20, the hard-delete executor does not yet exist — see §13 Q2 for
> the fallback (Story 19 cannot ship its delete pass without Story 20's executor; the
> reminder pass can ship independently).

### Sequence within this story

```
1. Schema: add Event.retentionReminderSentAt / retentionExtendedCount / retentionDeleteAt;
   reconcile with Story 20's deletedAt/hardDeleteAt; add sweep index
   → verify: prisma migrate runs; prisma generate clean
2. Config: add RETENTION_* vars in env.ts + index.ts (+ .env.example); reuse RESEND_*/grace
   → verify: config parses
3. Retention date math (pure): reminderDueAt(eventDate), retentionDeleteAt(now, eventDate),
   extension cap math → verify: unit tests
4. Reminder template: retention reminder email (organizer only) in brand voice
   → verify: render snapshot test (no "!", exact honoree name, occasion-aware, download+extend links)
5. Daily sweep: reminder pass + delete pass (delete pass calls Story 20 hardDeleteEvent)
   → verify: unit (windows/idempotency) + integration (reminder once → time-advance → hard delete)
6. Extension action (organizer authz): bump count, push retentionDeleteAt +30d, cap at 2× / 90d
   → verify: unit (caps) + integration (3rd attempt rejected)
7. Frontend: retention status (countdown) + Download now + Extend (disabled after 2×) + confirm
   → verify: states; disabled-after-cap; branding
8. Cron wiring: register daily repeatable job in worker (gated by config)
   → verify: job registers; sweep idempotent
9. Seed + tests + DoD → verify: lint/typecheck/test green; CI green
```

### What this unlocks

- Completes the MVP 1 data-lifecycle story set (Stories 18/19/20). Nothing depends on
  Story 19 downstream; it is a terminal lifecycle feature.

---

## 4. Frontend / UI Design

All copy follows `branding.md`: warm, confident, clear; **no exclamation marks in
transactional copy**; **honoree name spelled exactly as entered**; occasion-aware nouns;
title case for headings, sentence case for buttons; **dates in short functional form**
("Deletes on June 25, 2026"); Lucide outline icons (20px); palette tokens already wired
(`bg-brand-ivory`, `text-brand-ink`, functional `--warning` for the countdown as it nears,
`--error` only for the destructive auto-delete framing). Retention is a calm,
informational concern — never alarmist.

### 4.1 Retention status panel — organizer event detail page (`/events/[id]`, Story 3/7 surface)

A **"Retention"** section appears on the organizer event-detail page **once the event is
past its event date** (before that, retention is not yet relevant — show nothing or a quiet
"Your tribute and all its files are kept until 30 days after the event."). The section
states the lifecycle plainly and offers the two actions.

| State (derived server-side from the retention timestamps) | What the panel shows |
|---|---|
| **Pre-window** (`now < eventDate + 30d`, no reminder yet) | Quiet line: "Everything for this tribute is kept until 30 days after the event." Optional faint date. No urgent styling, no actions beyond Download. |
| **Reminded, deletion scheduled** (`retentionReminderSentAt` set, `now < retentionDeleteAt`) | **Countdown to delete date**: "This tribute is scheduled for deletion on **{retentionDeleteShort}** ({N} days left)." Plus the two actions (§4.2/§4.3). `--warning` tone as the date nears. |
| **Extended** | Same as above with a note: "Retention extended ({retentionExtendedCount} of 2). New delete date: {date}." When `retentionExtendedCount === 2`, the Extend button is **disabled** with helper text (§4.3). |
| **At cap / forced** (`retentionExtendedCount === 2` and past the capped delete date) | "This tribute will be deleted within a day. Download it now if you'd like to keep it." Extend disabled. |
| **Soft-deleted (in grace, awaiting hard delete)** | The event has dropped out of "My Events" already (Story 20's not-deleted filter, §6.3). The detail page, if reached, shows a calm "This tribute has been deleted and will be fully removed shortly." (Edge case; normally the page is no longer linked.) |

> **Why the panel is read-only-plus-two-actions.** Story 19 does **not** add a user
> "delete now" button — that is Story 20. Story 19's only organizer-initiated action here is
> **Extend** (and the convenience **Download**); deletion is automatic.

### 4.2 "Download now" action

- A **"Download the final video"** button (only shown when a final video exists — Story 15
  delivered). Links to the **Story 15 presigned download** / share page (`buildDownloadUrl`
  / share URL — §5.6). Opens in a new tab.
- If no final video exists yet (event not delivered at +30d — §13 Q3), the button is
  **absent**; the panel shows "Your tribute hasn't been delivered yet — contact us if you
  need more time." (and the auto-delete is still governed by the timer; §13 Q3 covers
  whether undelivered events should auto-delete at all).
- This action **never** sends a honoree communication and never exposes honoree contact
  (surprise integrity, §10).

### 4.3 "Extend retention by 30 days" action

| Concern | Decision |
|---|---|
| Control | A **"Extend retention by 30 days"** button in the Retention panel |
| Enabled when | `retentionExtendedCount < RETENTION_MAX_EXTENSIONS` (default 2) **and** the event is not already soft-deleted |
| Disabled when | `retentionExtendedCount >= 2` → button disabled with helper text: "You've used both 30-day extensions. This tribute will be deleted on {finalDate}. Download it to keep it." |
| Confirmation | **Single explicit confirm** (this is non-destructive — it *delays* deletion; a 2-click typed gate like Story 20's destructive flow is **not** needed). A lightweight confirm ("Extend retention to {newDate}?") with a **Confirm / Cancel** is sufficient (§13 Q4). |
| On success | The panel re-renders with the new delete date and incremented count, plus a calm banner: "Retention extended. This tribute is now kept until {newRetentionDeleteShort}." |
| On cap-exceeded (race) | If the server rejects (already at 2, or already soft-deleted), show "This tribute can't be extended further." and refresh the panel state. |

### 4.4 States & errors

| State | Renders |
|---|---|
| Loading | Server-rendered panel; no client fetch needed for status. The extend action is a server action with optimistic-safe re-render. |
| Not owner / not found | Calm "We couldn't find that event." (indistinguishable not-found — no existence leak across organizers, matching Story 3 §10). |
| Extend success | Banner + updated countdown (§4.3). |
| Extend rejected (cap / soft-deleted) | "This tribute can't be extended further." |
| Server error | "Something went wrong on our end. Please try again." (no partial-state claim). |

### 4.5 Responsive & branding

- The Retention panel is mobile-first, a single calm block; the countdown uses short
  functional dates; the Extend/Download buttons stack on small screens.
- Signature gradient/gold is **not** used (retention is functional, not celebratory).
- Accessibility: the countdown is text (not color-only); the disabled Extend button has
  `aria-disabled` + visible helper text; buttons keyboard-operable.
- "by Swara Media" footer lockup applies to the **email** (§5.6), not necessarily this
  in-app panel (it's inside the authenticated dashboard chrome).

---

## 5. Backend / Worker Design

The feature is a worker concern (the sweep cannot live on Vercel — `architecture.md` §4)
plus one organizer-facing server action (Extend). The sweep **reuses Story 18's scheduler**
and **Story 20's executor**; the only new logic is the date math, the two passes, and the
extension caps.

### 5.1 The daily cron sweep — scheduling (reuse Story 18's pattern)

**Recommendation: a BullMQ repeatable job** named `retention.sweep`, registered once at
worker boot, with cron pattern `0 3 * * *` (**daily**, e.g. 03:00 UTC — off-peak), enqueued
onto the **`reminders` low-priority queue** (`architecture.md` §8.1, concurrency 1). This is
the **same mechanism** Story 18 uses for its hourly `reminders.sweep`; Story 19 adds a
**second, daily** repeatable job — it does **not** modify or fold into Story 18's hourly
sweep (they have different cadences and concerns; `architecture.md` §11.4 calls retention a
"daily cron sweep" distinct from §8.3's hourly reminder scheduler).

**Why daily (not hourly):** retention windows are measured in **days** (30 / 37 / 90), so
day-granularity is sufficient and cheaper. A missed day is caught the next day (the sweep is
catch-up by design — it re-derives state from the timestamps every run; §5.7 idempotency).

**Schedule controls (config, §7):** `RETENTION_CRON_ENABLED` (default `true`; `false` in
test/CI) and `RETENTION_CRON_PATTERN` (default `0 3 * * *`). The sweep is **manually
invokable** (enqueue one `retention.sweep` job) so tests/ops can run it on demand.

> **Trade-off (same as Story 18 §5.1):** a BullMQ repeatable job fires only while a worker
> is alive. If the fleet is down for a whole day, that day's sweep is skipped; the next run
> catches up because eligibility is derived from the DB, and the windows are days wide. The
> worker-uptime alert (`architecture.md` §13) covers prolonged outages.

### 5.2 Reminder pass — query, send, set timestamps

For each sweep run, let `now = sweep start (UTC)`.

**Eligible-events query (reminder pass):**

```
SELECT id, eventDate, organizerId, honoreeName, occasionType, slug
FROM events
WHERE deletedAt IS NULL                              -- not already (soft-)deleted
  AND retentionReminderSentAt IS NULL                -- not yet reminded
  AND eventDate + INTERVAL 'RETENTION_DAYS days' < NOW();   -- past eventDate + 30d
```

(`RETENTION_DAYS` default **30**, from config — §7. The architecture's literal predicate is
`event_date + 30 days < NOW() AND retention_reminder_sent_at IS NULL`,
`architecture.md` §11.4.)

**Per eligible event:**

1. **Resolve the organizer** (`organizerId → User.email`). The reminder goes to the
   **organizer only** (`recipientType = organizer`).
2. **Compute `retentionDeleteAt`:**
   `retentionDeleteAt = min( now + RETENTION_GRACE_DAYS , eventDate + RETENTION_MAX_DAYS )`
   where `RETENTION_GRACE_DAYS` default **7** and `RETENTION_MAX_DAYS` default **90**
   (`architecture.md` §11.4: hard delete 7 days after reminder; max 90 days post-event).
   In the normal case (reminder at exactly +30d) this is `eventDate + 37d`, well under the
   90-day cap. (The `min(...)` guard matters only if a reminder is sent late — e.g. the
   worker was down — so that the delete date never exceeds the 90-day legal cap.)
3. **Dispatch the reminder** through Story 18's **shared dispatcher** (§5.5) with
   `trigger = retention.reminder`, the organizer email, and the retention template (§5.6).
   The dispatcher applies the **honoree-suppression filter** and **`NotificationLog`
   dedupe** automatically. (Dedupe on `(eventId, retention.reminder, organizerEmail)` makes
   the send at-most-once even before the timestamp is set — belt and braces with step 4.)
4. **On a `sent` result, set the timestamps in one update:**
   `UPDATE events SET retentionReminderSentAt = now, retentionDeleteAt = <computed>
    WHERE id = :id AND retentionReminderSentAt IS NULL` (conditional, idempotent — a
   concurrent/duplicate run won't double-set or re-send).
   - If the send **fails** (dispatcher returns `failed` after retries), **do not** set
     `retentionReminderSentAt` — leave it null so the **next daily sweep retries** the
     reminder (the event stays eligible). Log + alert per §5.7 / §11. This is the key
     ordering rule: **timestamp follows a successful send**, mirroring Story 18 §5.4's
     "write `sent` only after the channel confirms".

> **Why timestamp-after-send (not before):** if we set `retentionReminderSentAt` first and
> the email then failed, the organizer would never be warned yet the 7-day clock would start
> — an unacceptable "silent deletion". Setting it only after a confirmed send guarantees the
> organizer was actually warned before the delete clock starts.

### 5.3 Delete pass — trigger the SHARED Story 20 executor

**Eligible-events query (delete pass):**

```
SELECT id FROM events
WHERE deletedAt IS NULL                       -- not already soft-deleted
  AND retentionReminderSentAt IS NOT NULL     -- has been reminded
  AND retentionDeleteAt <= NOW()              -- past the (possibly extended) delete date
  AND retentionExtendedCount <= RETENTION_MAX_EXTENSIONS;   -- (always true; see note)
```

(`architecture.md` §11.4: "Events where `retention_reminder_sent_at + 7 days < NOW()` and
`retention_extended = false` → hard delete." This doc replaces the boolean
`retention_extended` with the **count + the computed `retentionDeleteAt`**: an extension
*pushes `retentionDeleteAt` forward by 30 days*, so a still-extended event simply has a
future `retentionDeleteAt` and is not selected. When the cap is reached, no further
extension is possible and the event becomes selected once `retentionDeleteAt` passes — i.e.
**forced delete**. The `retentionExtendedCount` predicate is therefore informational; the
real gate is `retentionDeleteAt <= NOW()`. See §6 reconciliation.)

**Per eligible event — reuse Story 20's path exactly:**

1. **Soft-delete the event** by setting the **shared Story 20 columns**:
   `deletedAt = now`, `hardDeleteAt = now` (or `now`, see reconciliation note below) — i.e.
   transition the event into Story 20's soft-deleted state and **cascade-mark submissions**
   exactly as Story 20's `deleteEventSoft(eventId)` does. **Reuse Story 20's
   `deleteEventSoft` (or its internal soft-delete unit)** so the cascade-mark + S3
   `moveToDeletedPrefix` behavior is identical; do **not** re-implement it.
   - **Initiator:** the soft-delete audit record (Story 20 §5.1 step 6) is written with
     `actorId = null` and `metadata.initiatedBy = "retention"` (system-initiated), so the
     audit distinguishes a scheduled deletion from an organizer/contributor one.
2. **Invoke the SHARED hard-delete executor** `hardDeleteEvent(eventId)` (Story 20 §5.3) to
   purge DB rows (cascade) + S3 objects (both `deleted/` and original prefixes, all
   versions) and retain de-identified `NotificationLog`/`AuditLog`.
   - **Timing options (pick one — §13 Q5):**
     - **(A) Immediate (recommended for retention):** because the 30-day + 7-day windows
       *are* the grace period, the retention delete pass can call `hardDeleteEvent`
       **immediately** after the soft-delete (no extra 72h wait). The architecture's
       lifecycle (`eventDate +37d → hard delete`) implies the data is destroyed at +37d, not
       +37d+72h. Set `hardDeleteAt = now` so the row is immediately past grace; soft-delete
       then hard-delete in the same sweep item.
     - **(B) Defer to Story 20's grace sweep:** soft-delete only (set `hardDeleteAt = now +
       DELETION_GRACE_HOURS`) and let **Story 20's existing hard-delete sweep** purge it
       after the 72h grace. This adds a 72h buffer (a safety net against a wrongly-timed
       auto-delete) at the cost of the data living ~3 extra days.
   - **This doc's default: (A) immediate**, because the user already had a 7-day warning
     window; an additional 72h is redundant and would push the effective deletion past the
     90-day cap in edge cases. (B) is a one-line config swap if a buffer is desired. **Either
     way, the purge itself is Story 20's `hardDeleteEvent` — unchanged.**
3. **Write a retention-specific audit marker** in addition to Story 20's `event.deleted.hard`:
   `AuditLog action = "retention.deleted"`, `actorId = null`, `metadata = {
   formerEventIdHash, anchorDate: eventDate, retentionExtendedCount, purgedAt }` (no PII —
   §11). (Story 20's `event.deleted.hard` is also written by the executor; the
   `retention.deleted` marker records *why* — the scheduled lifecycle.)

> **Single shared purge path.** Story 19 contributes **zero** purge/S3/cascade code. It
> calls `deleteEventSoft` (or sets the same columns) and `hardDeleteEvent`. If Story 20's
> executor changes, Story 19 inherits the change for free. This is the explicit reuse mandate
> (`architecture.md` §11.4; Story 20 §1, §5.3 "Story 19 reuse").

### 5.4 Extension action (organizer)

| Property | Value |
|---|---|
| Operation | `extendRetention(eventId)` (Server Action) — or `POST /api/events/[id]/extend-retention` |
| Auth | Organizer session required; **must own the event** (`event.organizerId === session.userId`); non-owner ⇒ indistinguishable not-found (no existence leak) |
| Idempotency | Each successful call increments the count by exactly 1 and pushes the delete date by exactly 30 days; it is **not** a toggle |

**Algorithm (authoritative order):**

1. **Authenticate + authorize** (owner). Not owner / not found → not-found result.
2. **Load the event;** reject (with a calm error) if:
   - the event is **already soft-deleted** (`deletedAt IS NOT NULL`) — too late to extend; or
   - `retentionExtendedCount >= RETENTION_MAX_EXTENSIONS` (default 2) — cap reached; or
   - **(optional, §13 Q6)** the reminder hasn't been sent yet (`retentionReminderSentAt IS
     NULL`) — extending before the reminder is allowed but pointless; **default: allow** (it
     pre-extends the eventual delete date by basing it on the cap math below).
3. **Compute the new delete date:**
   `newRetentionDeleteAt = min( currentRetentionDeleteAt + 30 days , eventDate +
   RETENTION_MAX_DAYS )`. The `min` enforces the **90-day post-event cap**: extension can
   never push deletion beyond `eventDate + 90d`. (So the 2 extensions take +37d → +67d →
   +90d-capped; with default windows the second extension lands within the cap. **[CONFIRM]**
   the cap is on the **delete date**, i.e. data persists at most 90 days post-event — matches
   `architecture.md` §11.4 "max 90 days post-event".)
4. **Conditional update (race-safe):**
   `UPDATE events SET retentionExtendedCount = retentionExtendedCount + 1,
    retentionDeleteAt = :newDate
    WHERE id = :id AND deletedAt IS NULL AND retentionExtendedCount < :max`.
   If 0 rows updated → another writer hit the cap or soft-deleted it concurrently → return
   the cap-exceeded result.
5. **Write audit:** `AuditLog action = "retention.extended"`, `actorId = organizer userId`,
   `eventId`, `metadata = { newRetentionDeleteAt, retentionExtendedCount }` (no PII).
6. **Return** `{ ok: true, retentionDeleteAt, retentionExtendedCount }` for the panel to
   re-render.

**Caps summary:**

| Extension | `retentionExtendedCount` after | Effect on `retentionDeleteAt` (default windows) |
|---|---|---|
| (initial reminder) | 0 | `eventDate + 37d` |
| 1st extend | 1 | `+30d` → `eventDate + 67d` |
| 2nd extend | 2 | `+30d` → `eventDate + 97d`, **capped to `eventDate + 90d`** |
| 3rd attempt | — | **Rejected** (cap reached); button disabled in UI |

> **Forced delete after cap.** Once `retentionExtendedCount === 2`, no more extensions are
> possible; when `retentionDeleteAt` (capped at +90d) passes, the delete pass (§5.3) selects
> the event and deletes it — the "forced hard delete" of `architecture.md` §11.4.

### 5.5 Reuse of Story 18's dispatcher + `Channel`

The reminder send goes through Story 18's **single shared dispatcher** (the only path that
sends notifications). Story 19 does **not** call `EmailChannel` directly. The dispatcher
provides, for free:

- **Honoree-suppression filter (first step)** — if the resolved recipient ever equalled
  `Event.honoreeEmail` it would be `suppressed_surprise` + critical-alerted (`architecture.md`
  §10.1/§13). For retention the recipient is the **organizer**, never the honoree, so this is
  a safety net (the organizer email cannot equal the honoree email under normal data).
- **`NotificationLog` dedupe** on `(eventId, retention.reminder, organizerEmail)` — at-most-once.
- **Retry/backoff** (3 attempts) on transient failure; permanent failure → `failed` row +
  admin alert (Story 18 §5.6).

**New trigger token:** `retention.reminder` (the dedupe + audit key).
**Recipient type:** `organizer` only.

### 5.6 Reminder email template (organizer only)

A new template added to Story 18's email template inventory, in brand voice (`branding.md`:
warm, calm, **no exclamation marks**, **honoree name exactly as stored**, occasion-aware
noun — same mapping as `seq03-story03` §5.6 and `seq06-story18` §5.7 — short functional date
form, **"by Swara Media" footer** lockup; HTML + plaintext variants).

| Template ID | Trigger | Recipient | Purpose / one-line voice | Variables |
|---|---|---|---|---|
| `retention.reminder` | `retention.reminder` | organizer | "{honoreeName}'s {occasion} tribute will be deleted on {retentionDeleteDate}. Download it now, or extend retention by 30 days." | `honoreeName`, `occasionNoun`, `retentionDeleteShort` (e.g. "June 25, 2026"), `downloadUrl` (Story 15 download/share — §5.6 builder), `extendUrl`/`dashboardUrl` (organizer event detail with the Extend action), `retentionExtendedCount`, `extensionsRemaining` |

**Body shape (per `architecture.md` §11.4 reminder content + `branding.md`):**

> Subject: "Your {honoreeName} {occasion} tribute — keep it or it'll be removed on {date}"
> *(calm, no "!")*
>
> Body (paraphrase): "We keep every tribute for 30 days after the event. {honoreeName}'s
> {occasion} tribute is now past that window and is scheduled for deletion on
> **{retentionDeleteShort}**. If you'd like to keep it, download the video now, or extend
> retention by 30 more days from your dashboard. You can extend up to two times
> ({extensionsRemaining} left)." + **[Download the video]** + **[Extend retention]** +
> "— Swara Magical Memories / by Swara Media".

- **Download link:** built via the Story 15 download/share helper (e.g.
  `buildDownloadUrl(eventId)` or the share page URL). If Story 15's helper name differs,
  reconcile here. Shown **only if a final video exists** (§13 Q3 for the undelivered case).
- **Extend link:** the organizer event-detail URL (`{config.app.publicUrl}/events/{id}`)
  where the Extend action (§4.3) lives. (A direct one-click extend-by-email link is **out of
  scope** — extension requires the authenticated dashboard, §13 Q7.)
- **Never** references or exposes the honoree's contact; never offers to notify the honoree
  (surprise integrity).

### 5.7 Idempotency, status/transition handling, error cases

- **Idempotency via the retention timestamps** (`architecture.md` §8.2 idempotency
  contract): every transition is derived from `retentionReminderSentAt` / `retentionDeleteAt`
  / `retentionExtendedCount` / `deletedAt`. A re-run of the sweep:
  - **Reminder pass:** events with `retentionReminderSentAt != null` are excluded → no
    re-send. The dispatcher dedupe is a second guard.
  - **Delete pass:** events with `deletedAt != null` are excluded → no re-delete; and
    `hardDeleteEvent` itself is idempotent (Story 20 §5.3 — re-running on a gone event is a
    no-op).
- **State transitions:**
  - `EventStatus` is **left unchanged** by retention (matching Story 20 §5.1's decision —
    "deleted" is expressed by `deletedAt`, not a new enum value; avoids enum churn). The
    event's `status` (e.g. `DELIVERED`) is preserved until the row is purged.
  - The reminder pass and delete pass are **mutually exclusive per event in a single run**
    (a freshly-reminded event has `retentionDeleteAt` in the future, so it can't also be
    delete-eligible the same day).
- **Per-event isolation:** wrap each event's processing in try/catch so one failure (e.g. an
  S3 error inside `hardDeleteEvent`, or a transient send failure) does not abort the whole
  sweep; log the failure (id + reason, no PII) and continue. Failed items are retried next
  sweep (still eligible).
- **Error cases:**

| Case | Handling |
|---|---|
| Organizer email missing/invalid | Reminder `failed` (Story 18 path) + admin alert; `retentionReminderSentAt` stays null → retried next day. **Delete is never triggered for an event that was never successfully reminded** (delete pass requires `retentionReminderSentAt IS NOT NULL`). |
| Send transient failure | Dispatcher retries (3×); on exhaustion `failed` + alert; timestamp not set; retried next sweep. |
| `hardDeleteEvent` fails mid-purge | Story 20's executor is idempotent and per-item-isolated; the event remains soft-deleted (`deletedAt` set) and is retried by the next retention sweep (or by Story 20's own grace sweep if option (B)); a spike in failures alerts (§11). |
| Worker fleet down for a day | Sweep skipped; next run catches up (windows are days wide). |
| Extension race (two clicks / concurrent) | Conditional update (§5.4 step 4) ensures the count never exceeds the cap and the date never exceeds +90d. |
| Event soft-deleted by Story 20 (user "delete now") before retention fires | Retention queries exclude `deletedAt != null` → retention never double-processes it; Story 20's grace sweep handles the purge. The two lifecycles share the columns and never conflict. |

### 5.8 Payloads (conceptual)

```
retention.sweep (worker, no input)  → { remindersSent, deletesTriggered, failures }
extendRetention:  { eventId }        → { ok: true, retentionDeleteAt, retentionExtendedCount }
                                       | { ok: false, error: "CAP_REACHED" | "ALREADY_DELETED" | "NOT_FOUND" }
hardDeleteEvent(eventId): (Story 20, REUSED) → { purgedSubmissions, purgedMedia, purgedObjects }
```

---

## 6. Database Design

This story adds **only** the three retention timestamps from `architecture.md` §11.4 to
`Event` and **reconciles** them with Story 20's already-present soft/hard-delete columns. No
new tables, no new enums.

### 6.1 `Event` — fields added this story

| Field | Type | Null? | Default | Notes |
|---|---|---|---|---|
| `retentionReminderSentAt` | DateTime | **yes** | `null` | Set to `now` when the retention reminder is successfully sent (§5.2). Non-null ⇒ the 7-day delete clock has started. Reminder pass excludes non-null rows. |
| `retentionExtendedCount` | Int | no | `0` | Number of 30-day extensions used (0–2). Caps the extension action (§5.4); replaces the architecture's boolean `retention_extended` with a count (so 2× is representable). |
| `retentionDeleteAt` | DateTime | **yes** | `null` | Computed `= min(retentionReminderSentAt + RETENTION_GRACE_DAYS, eventDate + RETENTION_MAX_DAYS)` at reminder time; pushed `+30d` (capped at +90d) per extension (§5.4). The **delete-pass gate**. |

### 6.2 Reconciliation with Story 20's `deletedAt` / `hardDeleteAt` (shared columns)

Story 20 already adds `Event.deletedAt` and `Event.hardDeleteAt` (the soft-delete + grace
columns). **Story 19 does NOT re-add them** — it **shares** them. The two lifecycles relate
as follows:

| Column | Owned by | Set by user-initiated (Story 20) | Set by scheduled retention (Story 19) |
|---|---|---|---|
| `retentionReminderSentAt` | **Story 19** | — | reminder pass (§5.2) |
| `retentionExtendedCount` | **Story 19** | — | extension action (§5.4) |
| `retentionDeleteAt` | **Story 19** | — | reminder pass; extension. **The retention "when to delete" signal.** |
| `deletedAt` | **Story 20** | organizer/contributor click | retention **delete pass** (§5.3) when `retentionDeleteAt <= now` |
| `hardDeleteAt` | **Story 20** | `deletedAt + DELETION_GRACE_HOURS` (72h) | retention delete pass sets it (`= now` for option (A); `= now + grace` for option (B)) |

**The clean separation:** `retentionDeleteAt` answers *"when does the scheduled lifecycle
decide to delete?"*; `deletedAt`/`hardDeleteAt` answer *"the event is now in the soft→hard
delete machine."* Retention's delete pass is simply the **trigger** that flips an event into
Story 20's machine (and, in option (A), drives the purge immediately). **Both never fire on
the same event:** once `deletedAt` is set (by either path), the other path's queries (which
all filter `deletedAt IS NULL`) exclude it. This is the explicit reconciliation
`architecture.md` §11.4 implies by listing all five fields together on `Event`.

> **Why a count, not a boolean.** `architecture.md` §11.4 shows both `retentionExtendedCount
> Int @default(0)` (the schema block) and prose "`retention_extended = false`" (the sweep
> rule). The schema block is authoritative; this doc uses the **count**, and expresses
> "extended and not yet due" as `retentionDeleteAt > now` rather than a boolean — supporting
> the 2× cap that a boolean cannot represent.

### 6.3 Indexes

| Index | Definition | Purpose |
|---|---|---|
| `@@index([retentionReminderSentAt, eventDate])` on `Event` **[CONFIRM]** | composite | Serves the reminder-pass query (`retentionReminderSentAt IS NULL AND eventDate + 30d < now`). (A simpler `@@index([eventDate])` also works; the composite narrows by the null-reminder predicate.) |
| `@@index([retentionDeleteAt])` on `Event` | single | Serves the delete-pass query (`retentionDeleteAt <= now`). |

The Story 20 `@@index([deletedAt, hardDeleteAt])` on `Event` already serves Story 20's grace
sweep (and option (B) above); Story 19 does not duplicate it.

### 6.4 What hard-delete removes vs retains (reference Story 20 — unchanged)

Story 19's delete pass produces **the same** purge/retention outcome as Story 20, because it
calls the **same executor**. Summarized for completeness (authoritative spec: Story 20 §6.4,
`architecture.md` §11.4):

**Removed (purged):** `Event` row (cascades to `Submission` → `MediaItem`, `AiArtifact`,
`EditorAssignment`, `FinalVideo`, `SharePage`); **all S3 objects** under the event prefix
(both `events/{id}/` and `deleted/events/{id}/`, all versions + delete markers on versioned
prefixes).

**Retained (de-identified):** `NotificationLog` rows (`eventId → null` via `onDelete:
SetNull`; `recipientEmail` hashed) — **including this story's `retention.reminder` row**, so
the audit shows the organizer was warned before deletion; `AuditLog` rows (`eventId → null`,
PII-stripped) — including Story 20's `event.deleted.hard` **and** this story's
`retention.deleted` marker; Stripe payment record (Stripe-side; only `stripeSessionId`
reference, purged with the row).

### 6.5 Migration notes

- A single additive migration, e.g. `add_event_retention_fields`:
  - Adds the 3 columns (`retentionReminderSentAt`, `retentionExtendedCount` default 0,
    `retentionDeleteAt`) — all nullable / defaulted, so **no downtime, no backfill**.
  - Adds the retention indexes (§6.3).
  - **Does NOT** add `deletedAt`/`hardDeleteAt` (Story 20 owns those). If Story 19 lands
    **before** Story 20 (against the recommended order — §13 Q2), this migration must add
    those two columns too **and** Story 20's migration must then be reconciled to not
    re-add them. **Default assumption: Story 20 lands first; Story 19's migration adds only
    the 3 retention columns.**
- Backfill behavior for **existing live events past +30d at migration time:** the columns
  default null/0, so existing events are simply picked up by the **next reminder sweep**
  (which sends them a reminder, then the normal 7-day clock). No data-migration step needed;
  the sweep is the catch-up mechanism. (An optional one-off note: confirm no surprise mass
  reminder fires the first run — see §13 Q8.)
- Run with the project's pooled/direct-URL convention (`DATABASE_URL` runtime, `DIRECT_URL`
  for `prisma migrate`). `prisma generate` clean; `npm run typecheck` green.

---

## 7. External Services / Integrations / Config

### 7.1 External services

- **Resend** (prod) / **Mailpit** (dev) — **reused** via Story 18's `EmailChannel`. Story 19
  reuses `RESEND_API_KEY` / `RESEND_FROM_ADDRESS` (already added by Story 18); **no new email
  account or key**.
- **S3 / R2** — **reused** via Story 20's storage interface (`deletePrefix` /
  `moveToDeletedPrefix`) inside `hardDeleteEvent`. No new storage capability.
- **Redis / BullMQ** — **reused** (Story 1 / 18) for the daily repeatable job. No new Redis.
- **No new external account** is introduced by this story.

### 7.2 Config — add in BOTH `src/config/env.ts` and `src/config/index.ts`

Per the load-bearing convention (`story-01-foundation.md` §3, `architecture.md` §16): every
new var is read **only** in `src/config/env.ts` (raw) and validated/typed in
`src/config/index.ts` (Zod). No `process.env` elsewhere (ESLint `no-restricted-syntax`). Add
each to `.env.example` with the defaults below. Reuse existing `RESEND_*` (Story 18) and
`DELETION_GRACE_HOURS` (Story 20) — do not re-declare them.

**Raw reads to add in `src/config/env.ts`:** `RETENTION_DAYS`, `RETENTION_GRACE_DAYS`,
`RETENTION_MAX_DAYS`, `RETENTION_MAX_EXTENSIONS`, `RETENTION_CRON_ENABLED`,
`RETENTION_CRON_PATTERN`.

**Typed `retention` block to add in `src/config/index.ts`:**

| Config field | Env var | Type | Default | Notes |
|---|---|---|---|---|
| `retention.days` | `RETENTION_DAYS` | int | `30` | Days after `eventDate` before the reminder fires (`architecture.md` §11.4 / `requirements.md` §8). |
| `retention.graceDays` | `RETENTION_GRACE_DAYS` | int | `7` | Days after the reminder before hard delete (the "+7 days"). |
| `retention.maxDays` | `RETENTION_MAX_DAYS` | int | `90` | Hard cap: data is deleted no later than `eventDate + this` (the "max 90 days post-event"). |
| `retention.maxExtensions` | `RETENTION_MAX_EXTENSIONS` | int | `2` | Max 30-day extensions (`requirements.md` §8 "up to 2 times"). |
| `retention.cronEnabled` | `RETENTION_CRON_ENABLED` | boolean | `true` (`false` in test/CI) | Gates the daily repeatable-job registration. |
| `retention.cronPattern` | `RETENTION_CRON_PATTERN` | string | `0 3 * * *` | Daily, off-peak; overridable for testing. |

- `.env.example` gets all six with the defaults above and `RETENTION_CRON_ENABLED=false` for
  a safe local default (so the sweep doesn't auto-fire locally unless explicitly testing).
- **No `RETENTION_DELETE_IMMEDIATE` needed** if option (A) in §5.3 is the fixed default; if
  the team wants option (B) configurable, add a boolean `RETENTION_DELETE_USES_GRACE`
  (default `false`) — flagged §13 Q5. Default: not added (option A is the chosen behavior).

### 7.3 Cron / worker

- The retention sweep is a **second** BullMQ repeatable job in the worker process (Story
  9/18 host), on the `reminders` low-priority queue, **daily** (§5.1). It is registered
  alongside Story 18's hourly `reminders.sweep` at worker boot, gated by
  `RETENTION_CRON_ENABLED`. On a Vercel-only deployment before the worker host exists, the
  same fallback as Story 18/20 applies (a platform Cron → an authenticated internal route
  invoking the same sweep) — §13 Q2.

---

## 8. Seed Data

Extend the existing idempotent dev/test seed (Stories 3/5/6/18/20) so every retention
transition is manually verifiable locally. Use **relative** dates (now-anchored) so windows
are hit whenever the seed runs; seed only in non-production (guard on `config.env`); upsert
by stable key (idempotent).

| Seed fixture | Setup | Exercises |
|---|---|---|
| Event "reminder due" | `eventDate = now - 31d`, `retentionReminderSentAt = null`, `deletedAt = null`, a `FinalVideo` present | Reminder pass sends one organizer reminder; sets `retentionReminderSentAt` + `retentionDeleteAt = now + 7d`; download link present. |
| Event "delete due" | `eventDate = now - 38d`, `retentionReminderSentAt = now - 8d`, `retentionDeleteAt = now - 1d`, `retentionExtendedCount = 0`, `deletedAt = null` | Delete pass soft-deletes + calls `hardDeleteEvent`; verify DB cascade + S3 purge + de-identified `NotificationLog`/`AuditLog` (incl. `retention.deleted`). |
| Event "extended once, not yet due" | `eventDate = now - 40d`, `retentionReminderSentAt = now - 10d`, `retentionExtendedCount = 1`, `retentionDeleteAt = now + 20d` | Verify the extended event is **not** delete-eligible; the Extend button shows "1 of 2 used" and is still enabled. |
| Event "at cap" | `eventDate = now - 70d`, `retentionExtendedCount = 2`, `retentionDeleteAt = now + 2d` (capped) | Verify Extend is **disabled** (cap reached); when advanced past `retentionDeleteAt`, the delete pass forces deletion. |
| Event "already reminded — dedupe" | `eventDate = now - 31d`, `retentionReminderSentAt = now - 1d`, with a pre-seeded `NotificationLog` `sent` row for `retention.reminder` | Proves the reminder pass + dispatcher dedupe send **no** duplicate. |
| Event "pre-window" | `eventDate = now - 10d` | Proves the reminder pass does **not** fire yet (within 30 days). |

Also seed:
- Reuse Story 3's **sample organizer** `User` (e.g. `organizer@example.com`) as the reminder
  recipient (Mailpit-visible locally).
- For the "delete due" fixture, place dummy S3 objects under the event prefix so the purge is
  observable (mirrors Story 20's seed).
- Print the local `/events/{id}` URLs in seed output so the Retention panel (countdown +
  Extend) can be exercised by hand.

All seeded `NotificationLog`/timestamps use realistic values; idempotent upsert by stable
ids. (`RETENTION_CRON_ENABLED=false` in seed/dev so the sweep runs only when invoked.)

---

## 9. Testing

Follows Story 1's pattern (Vitest, `tests/unit` + `tests/integration`,
`vite-tsconfig-paths`). DB/MinIO-touching tests are gated by **`SKIP_INTEGRATION`**. Email
sends are **mocked** (stub Story 18's `Channel`/dispatcher); the **shared
`hardDeleteEvent`** is exercised in integration and mocked in unit (to assert it's *called*,
proving reuse rather than re-implementation).

### 9.1 Unit (pure logic, no infra)

| Test | Asserts |
|---|---|
| Reminder window (`eventDate + 30d`) | An event with `eventDate = now - 30d - 1s` is reminder-eligible; `now - 29d` is not; uses `RETENTION_DAYS` from config (vary it). |
| Delete window (`reminder + 7d`) | `retentionDeleteAt = min(retentionReminderSentAt + 7d, eventDate + 90d)`; an event with `retentionDeleteAt <= now` is delete-eligible, `> now` is not; boundary (exactly-at, +1s). |
| 90-day cap on reminder date | A **late** reminder (e.g. sent at +85d) yields `retentionDeleteAt = eventDate + 90d`, not `+92d`. |
| Extension increments | Each `extendRetention` bumps the count by exactly 1 and pushes `retentionDeleteAt` by exactly 30 days (capped). |
| 2× cap | A 3rd `extendRetention` is rejected (`CAP_REACHED`); count stays 2; date unchanged. |
| 90-day extension cap | The 2nd extension's new date is clamped to `eventDate + 90d` (never beyond). |
| Idempotency — reminder once | Given `retentionReminderSentAt != null`, the reminder pass excludes the event (no second send); given a `sent` `NotificationLog` row, dedupe also blocks. |
| Idempotency — delete once | Given `deletedAt != null`, the delete pass excludes the event; `hardDeleteEvent` re-run is a no-op (mock asserts at-most-once effective purge). |
| Hard-delete trigger reuse | The delete pass **calls** `deleteEventSoft`/`hardDeleteEvent` (Story 20) with the right `eventId` and `initiatedBy:"retention"` — asserted via a mock (proves no re-implemented purge). |
| Reminder template render | `retention.reminder` renders with sample vars: honoree name verbatim, correct occasion noun, the delete date, a download link, an extend/dashboard link, **no exclamation mark**, "by Swara Media" footer; HTML + plaintext. |
| Recipient is organizer only | The reminder recipient resolves to the organizer email; passes through the honoree filter (no-op when honoree email absent). |
| Eligible predicates exclude soft-deleted | Both passes exclude `deletedAt != null` rows (no double-processing with Story 20). |

### 9.2 Integration (DB + MinIO; `SKIP_INTEGRATION` guards)

| Test | Flow |
|---|---|
| Reminder pass → one NotificationLog | Seed "reminder due" → run sweep → exactly one `retention.reminder` `sent` row for the organizer; `retentionReminderSentAt` + `retentionDeleteAt (= +7d)` set; one email captured (Mailpit/fake). |
| Re-run is idempotent (reminder) | Run sweep twice → no second `retention.reminder` row, no second email; timestamps unchanged. |
| Time-advance → hard delete reuses executor | Seed "delete due" (or advance the reminded fixture past `retentionDeleteAt`) → run sweep → event soft-deleted then **purged via `hardDeleteEvent`**: DB rows gone (cascade children gone), S3 prefix empty (all versions), `NotificationLog` survives (`eventId=null`, hashed email) **including the retention reminder row**, `AuditLog` survives PII-stripped with both `event.deleted.hard` (Story 20) and `retention.deleted` (this story). |
| Delete gate honored | An event reminded but `retentionDeleteAt` still in the future is **not** purged; one past it in the same run **is**. |
| Never-reminded event not deleted | An event with `retentionReminderSentAt = null` past +37d is **not** deleted (delete pass requires the reminder) — proves no silent deletion. |
| Extension end-to-end | `extendRetention` on a reminded event → count 1, `retentionDeleteAt += 30d`; event no longer delete-eligible; 2nd extend → count 2 (capped at +90d); 3rd → rejected. |
| Forced delete after cap | Advance an at-cap (`count=2`) event past its capped `retentionDeleteAt` → sweep deletes it. |
| Mocking email | Story 18's `Channel` is stubbed / Mailpit-captured; **no live Resend** in CI. |
| Coexistence with Story 20 | An event soft-deleted by Story 20 (user delete-now) is ignored by both retention passes; an event deleted by retention is ignored by Story 20's reminder/extension paths. |

### 9.3 Mocking & gating

- **Unit:** stub the Story 18 dispatcher/`Channel`; stub `deleteEventSoft`/`hardDeleteEvent`
  (assert calls); stub the clock (`now`) for deterministic window math.
- **Integration:** real Prisma against `swara_test`; real MinIO (`swara-magical-test`) for
  the purge; email via Mailpit or capture-fake; gate all DB/MinIO tests behind
  `SKIP_INTEGRATION`; set `RETENTION_CRON_ENABLED=false` so the scheduler doesn't auto-fire —
  tests invoke the sweep directly.

---

## 10. Security & Surprise Integrity

| Concern | Control |
|---|---|
| **Reminder to organizer only** | The reminder's `recipientType = organizer`; the recipient is resolved from `event.organizerId → User.email`. It passes through Story 18's **honoree-suppression filter** (first dispatcher step) as a safety net; any honoree-email match → `suppressed_surprise` + critical alert + no send (`architecture.md` §10.1/§13). The honoree is never an organizer, so this is belt-and-braces. |
| **No honoree exposure in content** | The reminder template never references or exposes the honoree's contact and never offers to notify the honoree (`branding.md` / surprise integrity). It links only to the organizer's authenticated dashboard + the (organizer-only) download. |
| **Complete purge (DB + S3)** | Reuses Story 20's `hardDeleteEvent`: DB cascade + S3 `deletePrefix` over both prefixes incl. **all versions + delete markers** on versioned prefixes (Story 20 §7.1) — so retention deletion truly destroys bytes, not just hides them. |
| **De-identified audit retention** | At hard delete, `NotificationLog` (incl. the `retention.reminder` row) survives with `eventId=null` + hashed email; `AuditLog` survives PII-stripped with `retention.deleted` + `event.deleted.hard` — no honoree/contributor PII re-identifiable (Story 20 §6.4/§11). |
| **Extension authorization** | `extendRetention` requires an authenticated organizer session and `event.organizerId === session.userId`; non-owner ⇒ indistinguishable not-found (no existence leak across organizers). Caps are enforced **server-side** via a race-safe conditional update (§5.4), not just the disabled UI button. |
| **No public trigger for deletion** | The sweep is system-initiated and bounded by the timestamps; no public endpoint can cause a delete. The only user-facing retention write is `extendRetention` (which only *delays* deletion, never causes it). |
| **No silent deletion** | The delete pass requires a successful reminder first (`retentionReminderSentAt IS NOT NULL`); a failed reminder blocks the delete and retries — the organizer is always warned before data is destroyed. |

---

## 11. Observability / Audit

| Signal | Where | Notes |
|---|---|---|
| **Retention reminder audit** | `NotificationLog` | The `retention.reminder` `sent` row is the durable record that the organizer was warned (de-identified-retained after purge — §6.4). `trigger = retention.reminder`, `recipientType = organizer`. |
| **Retention deletion audit** | `AuditLog` | `action = "retention.deleted"`, `actorId = null`, `metadata = { formerEventIdHash, anchorDate, retentionExtendedCount, purgedAt }` (no PII) — recorded **in addition to** Story 20's `event.deleted.hard`, so the audit shows the *scheduled* cause. The soft-delete marker is `metadata.initiatedBy = "retention"`. |
| **Extension audit** | `AuditLog` | `action = "retention.extended"`, `actorId = organizer userId`, `metadata = { newRetentionDeleteAt, retentionExtendedCount }`. |
| **Structured logs** | `src/lib/logger.ts` | Sweep start/end (events scanned, reminders sent, deletes triggered, failures) at info; per-event outcome with `eventId` only (no PII, no email, no object URLs); failures at error. A daily heartbeat confirms the cron ran. |
| **Metrics** | OTel → Honeycomb (`architecture.md` §13) | reminders sent/day, deletes/day, extensions/day, sweep duration, failure counts. Useful to confirm the daily cron is actually running. |
| **Critical alert — delete failures** | alert sink (`architecture.md` §13) | A spike in `hardDeleteEvent` failures during the retention sweep is paged (data-not-being-destroyed is a compliance risk) — reuses Story 20 §11's sweep-failure alert; the retention sweep emits the same signal. |
| **Alert — reminder dispatch failure** | alert sink | Reuses Story 18 §11's "notification dispatch failed" alert for the `retention.reminder` trigger. |

---

## 12. Definition of Done

Story 19 is **done** only when ALL are true:

- [ ] `prisma/schema.prisma` adds `Event.retentionReminderSentAt`, `retentionExtendedCount`
      (default 0), `retentionDeleteAt` per §6; migration `add_event_retention_fields`
      created + applied (dev/test/prod); **does not** re-add Story 20's
      `deletedAt`/`hardDeleteAt` (shared); retention sweep indexes present; `prisma generate`
      clean.
- [ ] Config `RETENTION_DAYS` (30), `RETENTION_GRACE_DAYS` (7), `RETENTION_MAX_DAYS` (90),
      `RETENTION_MAX_EXTENSIONS` (2), `RETENTION_CRON_ENABLED`, `RETENTION_CRON_PATTERN`
      added in **both** `src/config/env.ts` and `src/config/index.ts` (+ `.env.example`);
      `RESEND_*` and the grace concept reused (not re-declared); no `process.env` outside
      `src/config/env.ts`.
- [ ] A **daily** `retention.sweep` repeatable BullMQ job is registered at worker boot
      (gated by `RETENTION_CRON_ENABLED`), on the `reminders` queue, **separate** from Story
      18's hourly sweep; manually invokable for tests/ops.
- [ ] **Reminder pass:** selects events past `eventDate + RETENTION_DAYS` with no reminder;
      sends exactly one **organizer-only** reminder via Story 18's dispatcher (honoree
      filter + dedupe); sets `retentionReminderSentAt` + `retentionDeleteAt` **only after a
      confirmed send**; re-run sends no duplicate.
- [ ] **Delete pass:** selects events past `retentionDeleteAt` (and not extended within cap),
      soft-deletes (reusing Story 20's soft-delete) then purges via **Story 20's
      `hardDeleteEvent`** (no re-implemented purge); writes `retention.deleted` audit; never
      deletes an event that was never successfully reminded.
- [ ] **Extension:** `extendRetention` authorizes ownership, increments
      `retentionExtendedCount`, pushes `retentionDeleteAt +30d` capped at `eventDate + 90d`,
      rejects the 3rd attempt and already-deleted events (race-safe conditional update);
      writes `retention.extended` audit.
- [ ] Organizer event-detail page shows the **Retention status** (delete-date countdown),
      **"Download now"** (when delivered) and **"Extend retention by 30 days"** (disabled
      after 2 extensions, with helper text) with a single confirm; states + branding per §4.
- [ ] Reminder email template `retention.reminder` exists (HTML + plaintext), brand voice
      (warm, no "!", exact honoree name, occasion-aware, download + extend links, "by Swara
      Media" footer); render test passes.
- [ ] Hard delete reuses Story 20's purge completeness (DB cascade + S3 both prefixes/all
      versions) and de-identified retention (`NotificationLog` hashed, `AuditLog` PII-stripped).
- [ ] All transitions idempotent via the retention timestamps; coexistence with Story 20's
      user-initiated deletion verified (no double-processing).
- [ ] Seed creates reminder-due, delete-due, extended, at-cap, dedupe, and pre-window
      fixtures; idempotent; non-prod only; prints local event URLs.
- [ ] Unit + integration tests (§9) pass; integration honors `SKIP_INTEGRATION`; no live
      Resend send in CI.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; deploy succeeds.
- [ ] No TODO comments in committed code; `docs/stories.md` Story 19 row marked done.

---

## 13. Open Questions / Assumptions

| # | Question / Assumption | This doc's default | Needs confirmation? |
|---|---|---|---|
| Q1 | **Which date anchors the 30 days — `eventDate` or the delivery date?** `requirements.md` §8 and `architecture.md` §11.4 both say "30 days after **event date**". But branding's delivery email says "the link stays live for 30 days" (from delivery). These can differ (delivery is usually after the event). | **`eventDate`** (per the two normative sources). The delivery email's "30 days" is a separate share-link expiry concept (Story 15), not the retention anchor. | **Yes** — confirm `eventDate` anchors retention (and reconcile the delivery email's "30 days" wording with Story 15). |
| Q2 | **Build order: does Story 20 land before Story 19?** Story 19 reuses Story 20's `hardDeleteEvent` + soft-delete columns. | **Story 20 first.** If Story 19 must precede Story 20, its delete pass has no executor to call — ship only the **reminder pass + extension** until Story 20 lands, then wire the delete pass. The migration must then also add `deletedAt`/`hardDeleteAt`. | **Yes** — confirm Story 20 precedes Story 19. |
| Q3 | **What if the event is not yet delivered at `eventDate + 30d`?** No final video to download; deletion would destroy in-flight work. | **Reminder still fires** (it warns + offers Extend; the download link is omitted with a "not delivered yet" note). **Default: still auto-delete at +37d** unless extended — but flag strongly: deleting an undelivered, paid event is harsh. Alternative: skip the delete pass for events not in `DELIVERED` status (or with no `FinalVideo`) and alert admin instead. | **Yes** — confirm whether undelivered events auto-delete or are held + admin-alerted. |
| Q4 | **Extension confirmation — single confirm vs 2-click?** Extension is non-destructive (it *delays* deletion). | **Single confirm** (Confirm/Cancel). The 2-click typed gate is reserved for destructive actions (Story 20). | Low stakes — confirm. |
| Q5 | **Hard delete immediately vs via Story 20's 72h grace?** | **Immediate** (option A) — the 30+7-day window already served as grace; an extra 72h is redundant and risks exceeding the 90-day cap. Option B (defer to Story 20's grace sweep) is a config swap if a buffer is wanted. | **Yes** — confirm immediate purge at `retentionDeleteAt`. |
| Q6 | **Allow Extend before the reminder is sent?** | **Allow** (harmless; pre-extends). Could restrict to "only after reminder" for clarity. | Low stakes — confirm. |
| Q7 | **One-click "Extend" link in the reminder email (no login)?** | **No** — extension requires the authenticated dashboard; the email links to `/events/{id}`. A tokenized one-click extend could be added later (mirrors Story 20's deletion token), but is out of scope. | Confirm. |
| Q8 | **First-run mass reminder on existing events.** At migration, many old events may be past +30d with `retentionReminderSentAt = null` and would all get reminders on the first sweep. | **Accept** — they *should* be reminded (they're overdue). If a flood is a concern, the first sweep can be rate-limited or pre-backfilled, but the default is to let the catch-up sweep do its job. | **Yes** — confirm a first-run reminder batch is acceptable (or backfill timestamps for legacy events). |
| Q9 | **`retentionExtendedCount` (count) vs `retention_extended` (boolean).** `architecture.md` §11.4 shows both. | **Count** (the schema block is authoritative; required to represent the 2× cap). "Extended and not yet due" is expressed as `retentionDeleteAt > now`, not a boolean. | Confirm (default matches the §11.4 schema block). |
| Q10 | **Retention sweep cadence — daily vs hourly.** | **Daily** (`0 3 * * *`) — windows are day-scale; cheaper; catch-up safe. | Confirm. |
| Q11 | **Hash secret for de-identified logs.** Reuses Story 20's hashing of `recipientEmail` / former ids. | **Reuse Story 20's `LOG_HASH_SECRET`** (or whatever Story 20 settled on, its §13 Q11) — Story 19 introduces no new hashing. | Inherit from Story 20. |
