# Sequence 09 / Story 12 — Routing Analyzer + Admin Approval Gate

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (the full deterministic signal ruleset with trigger conditions, directions, weights,
and messages; the score → recommendation → confidence computation; the `RoutingResult` shape;
where/when the analyzer runs; the live-preview vs canonical-deadline runs; status transitions;
the two approval-action contracts; the audit-record shape; error cases) so a later
code-generation step implements exactly this and nothing more. Where a value is a proposal
awaiting confirmation it is flagged **[CONFIRM]**; genuine ambiguities are listed in §13, not
silently chosen. **No code appears in this document.**

| Field | Value |
|---|---|
| Story number / title | Story 12 — Routing analyzer + admin approval gate |
| Epic | F — Routing |
| Sequence number | 9 (this is the 9th design in build order) |
| Depends on | Story 11 (Claude analysis — per-submission sentiment/quotes/tags; the `analysis` queue + the per-submission analysis job whose completion is the live-preview hook) |
| Also assumes on `main` | Story 1 (config, `db`, `redis`, `logger`, worker scaffold, CI), Story 3 (`Event` + `OccasionType`/`EventStatus`/`PaymentStatus`), Story 5 (`Submission` + `SubmissionStatus`), Story 6 (`MediaItem` + `MediaType`), Story 7 (admin auth gate + `/admin/events/[id]` detail layout + `requireAdmin`), Story 8 (`AuditLog` model + audit-in-transaction pattern), Story 9 (BullMQ queue registry + `enqueue` helper + idempotency `jobId` convention + `MediaItem.qualityFlags`/`qualityScore` populated), Story 18 (the `Channel` interface + shared notification dispatcher + `NotificationLog` dedupe + the deadline-reached sweep that flips `ACTIVE → DEADLINE_PASSED`) |
| Unlocks | Story 13 (Manual workflow — fires only after `MANUAL_ROUTED`), Story 16 (AI storyboard/script — fires only after `AI_ROUTED`) |
| Complexity | M (1–3 days) |

> **Sources of truth honored:** `docs/requirements.md` §5.6 (the full analyzer ruleset, the
> `{recommendation, confidence, signals[]}` return, the approval-card mock with supporting AND
> opposing signals, on-approval status transitions, audit), §5.5 (routing approval card, live
> analyzer preview, trigger-manual override, the admin status field). `docs/architecture.md`
> §6.4 (the `Signal` / `RoutingResult` types, `analyzeEvent(event)`, when it runs, the
> deadline-run persistence + status flip + `event.routing_ready` notify, the approval gate
> Approve AI → `AI_ROUTED` / Switch to Manual → `MANUAL_ROUTED`, the audit-record shape, the
> override-rate metric), §7.1 (schema: `Event.routingRecommendation` / `routingConfidence` /
> `routingSignals` / `routingDecision` / `routingDecidedBy` / `routingDecidedAt`; the
> `EventStatus` values `AWAITING_ROUTING_APPROVAL` / `AI_ROUTED` / `MANUAL_ROUTED`; the
> `RoutingDecision` enum; `AuditLog`), §8.1/§8.2 (queue topology + idempotency contract),
> §10.1/§10.2 (surprise integrity + admin authz), §13 (observability/metrics).
> Also: `docs/branding.md` (approval-card tone — calm, confident, no exclamation marks),
> `docs/stories.md`, `docs/stories/story-01-foundation.md` (doc + config style), `CLAUDE.md`,
> `prisma/schema.prisma` (current: `User` + `Role`), and the sibling designs
> `seq06-story08-submission-approval.md` (audit substrate + transaction pattern),
> `seq06-story09-workers-quality-scoring.md` (queue/idempotency pattern + quality-flag inputs),
> `seq05-story07-admin-dashboard-readonly.md` (admin route/auth/detail layout),
> `seq06-story18-reminder-automation.md` (the `Channel` dispatcher + the deadline-reached flow).

> **Note on the Story 11 source.** `docs/design/seq06-story11-*.md` is **not present** at the
> time of writing. Story 11's outputs are taken from `architecture.md` §7.1 (`Submission.sentiment`,
> `Submission.extractedQuotes`, `Submission.tags`) and the pipeline DAG in §6.3 (the `analyze`
> job, followed by "score complexity (recalculate event-level routing)"). The analyzer in this
> story is the concrete realization of that "score complexity / recalculate routing" step. If the
> Story 11 design lands first and names the analysis-complete hook differently, reconcile §5.4
> against it before generating code (flagged §13 Q1). **The analyzer itself consumes only
> structured counts/metadata (media mix, orientations, quality flags, occasion type, contributor
> count) — it does NOT consume sentiment/quotes/transcripts.** Story 11 is a sequencing
> dependency (the analyzer re-runs when the per-submission pipeline completes), not a data input.

---

## 1. Story Summary

By Story 11 the per-submission pipeline is complete: each submission has quality-scored media
(Story 9: `MediaItem.qualityScore` / `qualityFlags`), transcripts (Story 10), and Claude
analysis (Story 11). The architecture's pipeline DAG ends each per-submission run with a
"score complexity (recalculate event-level routing)" step (`architecture.md` §6.3) that, until
now, has had no implementation.

Story 12 implements that step and the human gate around it:

1. **A pure, deterministic routing analyzer** (`analyzeEvent(eventWithSubmissions) →
   RoutingResult`). No LLM, no AI call, sub-second. It reads only structured counts/metadata
   (media-type mix, video orientations, per-file quality flags, occasion type, contributor
   count) and applies the fixed MVP 1 ruleset from `requirements.md` §5.6 — every signal a pure
   function with a trigger condition, a **direction** (`AI` | `MANUAL`), a **weight** (`0..1`),
   and a human-readable **message**. It returns a `recommendation` (`AI` | `MANUAL`), a
   `confidence` (`0..1`), and BOTH `signalsSupporting[]` and `signalsOpposing[]` (the opposing
   set is deliberate — the admin sees the strongest counter-argument to reduce confirmation
   bias).

2. **A live preview** — the analyzer re-runs after each per-submission analysis job completes
   (Story 11's hook) so the admin can watch the recommendation trend during collection, **without
   acting on it**. The live result is non-canonical and non-actionable.

3. **A canonical run at the submission deadline** — one final, authoritative `analyzeEvent`
   that **persists** the result to `Event.routingRecommendation` / `routingConfidence` /
   `routingSignals`, flips the event status to `AWAITING_ROUTING_APPROVAL`, and fires an
   **admin** notification (`event.routing_ready`) through the Story 18 dispatcher.

4. **The admin approval gate** — an approval card on the admin event detail showing the
   recommendation + confidence%, "Why this fits" (supporting) and "Why the other might be
   better" (opposing) signals, and two actions: **Approve AI Routing** (→ status `AI_ROUTED`) or
   **Switch to Manual** (→ status `MANUAL_ROUTED`). Each decision records
   `routingDecision` / `routingDecidedBy` / `routingDecidedAt` and writes an immutable
   `AuditLog` row. A **"Trigger Manual Workflow"** override is also available outside the gate
   (any time during/after collection).

**The gate is the whole point: the system NEVER auto-routes.** Until an admin clicks one of the
two actions, nothing downstream runs — no Claude Opus storyboard (Story 16), no editor brief
(Story 13), no encoder jobs. Story 12 designs the routing **decision** and the **handoff seam**
only; what `AI_ROUTED` triggers (Story 16) and what `MANUAL_ROUTED` triggers (Story 13) are out
of scope here.

### Success criteria

- [ ] A pure `analyzeEvent(eventWithSubmissions) → RoutingResult` exists, implementing every §5.6
      signal as a documented trigger + direction + weight, returning recommendation + confidence
      + supporting/opposing split, in sub-second time with no network/LLM call.
- [ ] The analyzer re-runs after each per-submission analysis completes (live preview); the live
      result is shown in the admin detail but is **not** persisted as canonical and exposes **no**
      action buttons.
- [ ] At the submission deadline a single canonical run persists the result, flips status to
      `AWAITING_ROUTING_APPROVAL`, and fires exactly one `event.routing_ready` admin
      notification (deduped via `NotificationLog`).
- [ ] The admin event detail renders the approval card (recommendation + confidence%, supporting
      + opposing signals, two action buttons, decision-attribution line) only when status is
      `AWAITING_ROUTING_APPROVAL`.
- [ ] Approve AI → `AI_ROUTED`; Switch to Manual → `MANUAL_ROUTED`; each writes
      `routingDecision` / `routingDecidedBy` / `routingDecidedAt` + one `AuditLog` row, all in one
      transaction; admin-only and idempotent.
- [ ] A "Trigger Manual Workflow" override is available outside the deadline gate and routes
      manual with an auditable, override-flagged decision.
- [ ] Schema gains the `Event` routing fields, the `EventStatus` additions, and the
      `RoutingDecision` enum; migration is additive.
- [ ] Unit + integration tests (§9) pass; integration tests skip cleanly under `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; no `process.env`
      outside `src/config/`.

---

## 2. Scope

### In scope (this story)

- **The deterministic analyzer module** — a pure `analyzeEvent(eventWithSubmissions) →
  RoutingResult` (`architecture.md` §6.4 signature), each §5.6 signal a pure function; the score
  aggregation → recommendation (threshold) + confidence; the supporting/opposing partition.
- **The live-preview run** — re-run after each per-submission analysis job completes (Story 11
  hook); compute-only, surfaced read-only in the admin detail, **not persisted** as canonical,
  **no** approval buttons.
- **The canonical deadline run** — persists `Event.routingRecommendation` / `routingConfidence`
  / `routingSignals`, flips `EventStatus` → `AWAITING_ROUTING_APPROVAL`, fires `event.routing_ready`
  admin notification.
- **The admin approval card** on `/admin/events/[id]` (extends Story 7's detail) per the §5.6
  mock: recommendation + confidence%, supporting signals, opposing signals, **Approve AI Routing**
  / **Switch to Manual** buttons, decision-attribution line; states (live-preview, awaiting,
  decided, error).
- **The two approval-action server actions** (admin-only): Approve AI → `AI_ROUTED`, Switch to
  Manual → `MANUAL_ROUTED`, each recording `routingDecision` / `routingDecidedBy` /
  `routingDecidedAt` + `AuditLog`, in one transaction, idempotent.
- **The "Trigger Manual Workflow" override** — manual routing available outside the gate
  (`requirements.md` §5.5), audited as an explicit override.
- **Schema growth** — `Event` routing fields, `EventStatus` enum additions
  (`AWAITING_ROUTING_APPROVAL`, `AI_ROUTED`, `MANUAL_ROUTED`), `RoutingDecision` enum
  (`AI` | `MANUAL`); additive migration.
- **Audit** — `routing.approved` / `routing.switched` (+ an override action) with the §6.4
  metadata shape.
- **Config** — the AI threshold and per-signal weights live in a versioned in-code constants
  module (a "ruleset version"); only operationally-tunable knobs (if any) go in `src/config`
  (§7).
- **Seed** — events with submission mixes that exercise each signal, both recommendations, and
  the `AWAITING_ROUTING_APPROVAL` state.
- **Tests** — unit (each signal, scoring, confidence, partition, transitions, audit) +
  integration (deadline run persists + flips + notifies), gated by `SKIP_INTEGRATION`.

### Out of scope (deferred — with owners)

| Deferred item | Owner / where | Note |
|---|---|---|
| **What `AI_ROUTED` triggers** (Claude Opus storyboard → narration → assembly) | Story 16/17 | Story 12 only sets the status + leaves the seam; it enqueues **nothing** downstream |
| **What `MANUAL_ROUTED` triggers** (brief ZIP, editor JWT links, editor email, assignment panel) | Story 13 | Story 12 only sets the status + leaves the seam |
| **Editor-assignment UI** ("assign from internal pool") | Story 13 | The approval card's Switch-to-Manual sets status only; the assignment panel is Story 13 |
| **LLM-based "second opinion" routing** | MVP 2 (`architecture.md` §6.4) | MVP 1 is rule-based only |
| **Per-submission approve/reject** + `submission.*` audit actions | Story 8 | Consumed (the analyzer reads `Submission.status`), not built |
| **The deadline-reached organizer/admin reminders + the `ACTIVE → DEADLINE_PASSED` flip** | Story 18 | The analyzer's canonical run is **chained off** that flip (§5.4); Story 12 does not re-implement the deadline sweep |
| **The `event.routing_ready` email template polish + Resend wiring** | Reuses Story 18's `Channel`/dispatcher | Story 12 adds the **trigger + template content**, not the dispatcher |
| **Override-rate dashboard** | Observability story | Story 12 emits the audit rows the metric is computed from (§11) |

---

## 3. Dependencies & Sequence

### Must already be on `main`

- **Story 1 (Foundation):** typed `config` (`src/config/env.ts` + `src/config/index.ts`), Prisma
  singleton `src/lib/db.ts`, Redis singleton `src/lib/redis.ts`, `logger`, worker entry
  `src/workers/index.ts`, CI, `SKIP_INTEGRATION` convention, `@/` alias, ESLint ban on
  `process.env` outside `src/config/env.ts`, brand tokens/fonts in `layout.tsx`/`globals.css`.
- **Story 3 (Event creation):** `Event` model (esp. `occasionType: OccasionType`,
  `submissionDeadline: DateTime`, `expectedContributors: Int`, `status: EventStatus`,
  `organizerId`), `OccasionType` (incl. `BUSINESS_EVENT`), `EventStatus`, `PaymentStatus` enums.
- **Story 5 (Contributor submission):** `Submission` model (`eventId`, `status:
  SubmissionStatus`, text fields, `email?`) — the analyzer iterates submissions per event.
- **Story 6 (Media uploads):** `MediaItem` model + `MediaType` enum (`VIDEO` / `VOICE` /
  `PHOTO`), `width`/`height` (for orientation), the per-submission media relation.
- **Story 7 (Admin dashboard read-only):** the admin auth gate (`requireAdmin`, Google OAuth,
  `ADMIN_EMAIL_DOMAINS`, `role=ADMIN`), the `/admin/events/[id]` detail page + layout the
  approval card slots into.
- **Story 8 (Submission approval):** the **`AuditLog`** model + the "write audit row in the same
  transaction as the state change" pattern. Story 12 reuses this substrate; it adds new action
  names (`routing.*`), not a new audit mechanism.
- **Story 9 (Workers + quality):** the BullMQ **queue registry + `enqueue` helper + idempotency
  `jobId` convention**, the worker process; and the populated `MediaItem.qualityScore` /
  `qualityFlags` the analyzer reads to compute the quality-flag rate.
- **Story 11 (Claude analysis):** the `analysis` queue + the per-submission analysis job. Its
  **completion is the live-preview hook** (§5.4). (Story 11 also writes
  `Submission.sentiment`/`extractedQuotes`/`tags`, which the analyzer does **not** consume.)
- **Story 18 (Reminders):** the **`Channel` interface + shared notification dispatcher +
  `NotificationLog` dedupe**, and the **deadline-reached flow that flips `ACTIVE →
  DEADLINE_PASSED`** — which Story 18 §5.3.3 explicitly calls "the signal Story 12's
  analyzer/routing picks up." Story 12 chains its canonical run off that signal (§5.4).

> **Dependency flags.**
> 1. As of writing, the live `prisma/schema.prisma` has only `User` + `Role`. This design assumes
>    Stories 3/5/6/7/8/9/11/18 land `Event`, `Submission`, `MediaItem`, `AuditLog`,
>    `NotificationLog`, the enums, and the queue infra exactly as in `architecture.md` §7.1/§8.
>    Reconcile §6 against the merged schema before migrating.
> 2. Story 12 **does not own the deadline sweep**. If Story 18 has not landed, Story 12 cannot
>    rely on the `DEADLINE_PASSED` flip and must define how the canonical run is triggered
>    (§5.4 offers two wirings; the Story-18-chained one is preferred). Flagged §13 Q2.
> 3. The **live-preview hook** is owned at the tail of the Story 11 analysis job (the DAG's
>    "score complexity" step). If Story 11's job names differ, reconcile §5.4. Flagged §13 Q1.

### Provides to later stories

- The **routing decision** (`Event.status` ∈ {`AI_ROUTED`, `MANUAL_ROUTED`} +
  `Event.routingDecision`) is the **start signal** for Story 13 (manual) and Story 16 (AI). Each
  reads the status/decision Story 12 sets; neither runs before the gate.
- The persisted `Event.routingSignals` JSON is the record the admin/audit views read.

### Sequence within this story

```
1. Schema: add Event routing fields + EventStatus values + RoutingDecision enum
   → verify: prisma migrate runs; generate clean
2. Analyzer: pure analyzeEvent() + each signal as a pure fn; scoring/confidence/partition
   → verify: unit tests per signal + scoring/threshold/confidence
3. Live-preview hook: re-run analyzer at tail of Story 11 analysis job (compute-only)
   → verify: integration — result available to admin detail, not persisted/actionable
4. Canonical deadline run: chained off Story 18 DEADLINE_PASSED → persist + flip + notify
   → verify: integration — fields persisted, status AWAITING_ROUTING_APPROVAL, one notify
5. Approval card UI on /admin/events/[id]: recommendation/confidence/signals/2 actions
   → verify: render states (live, awaiting, decided, error)
6. Approval actions: Approve AI / Switch to Manual / Trigger-Manual override + audit
   → verify: unit (authz, transition, audit mapping) + integration (persist + audit)
7. Seed: events exercising each signal + both recs + AWAITING state
   → verify: card renders both recommendations locally
8. Tests + DoD → verify: lint/typecheck/test green
```

---

## 4. Frontend / UI Design

All copy honors `branding.md` §3/§10: **warm, confident, clear**; **no exclamation marks** in
this operational surface; honoree name **spelled exactly as entered** ("honoree's name is
sacred"); occasion-aware nouns; title case for headings, sentence case for buttons/labels; Lucide
outline icons (20px default); palette tokens from `globals.css`. The signature gradient/gold is
**not** used here (reserved for delivery moments). This is an **admin-only, authenticated**
surface (Story 7 gate); it is never honoree-facing.

> **On-brand tone for the recommendation** (`branding.md` §3 example): say "This event looks
> straightforward — AI can handle the editing", **not** "Our advanced AI has determined…". The
> analyzer explains itself in plain words.

### 4.1 Where it lives

A new **Routing** section on the existing `/admin/events/[id]` detail page (Story 7), placed
above or alongside the submissions list. No new route. The section renders **one of three
mutually-exclusive states** depending on `Event.status` (§4.5).

### 4.2 The approval card (status `AWAITING_ROUTING_APPROVAL`)

Realizes the `requirements.md` §5.6 mock. Card contents, top to bottom:

| Element | Content / source |
|---|---|
| Event identity line | `honoreeName` + occasion-aware label (e.g. "Riya's Graduation"); status chip "Awaiting Routing Approval" |
| Recommendation banner | "Recommended: AI Routing" or "Recommended: Manual Routing", with **confidence%** = `round(routingConfidence × 100)` (e.g. "confidence: 87%"). Accent = `--brand-deep-saffron` for the recommended path |
| **"Why this fits this event"** (supporting) | A list of `routingSignals.supporting[]` — each row a check icon + the signal's `message` (e.g. "12 of 14 contributors uploaded video clips"). These are the signals whose `direction == recommendation` |
| **"Why a human editor might be better"** (opposing) | A list of `routingSignals.opposing[]` — each row a neutral/bullet icon + `message` (e.g. "2 contributors uploaded photos only"). These are the signals whose `direction != recommendation`. **Always shown when present** — this is the deliberate confirmation-bias guard (`requirements.md` §5.6, `architecture.md` §6.4) |
| Action buttons | **[ Approve AI Routing ]** (primary) and **[ Switch to Manual ]** (secondary). When the recommendation is `MANUAL`, the labels/emphasis flip: **[ Approve Manual Routing ]** primary + **[ Switch to AI ]** secondary. **[CONFIRM]** label set — §13 Q3 |
| Attribution line | "Decision will be recorded with your name and the time." (post-decision: "Routed to AI by {admin name} on {date, time}.") |

The opposing-signals heading is **relative to the recommendation**: if the recommendation is AI,
the opposing heading reads "Why a human editor might be better"; if MANUAL, it reads "Why AI might
be enough". **[CONFIRM]** heading copy — §13 Q4.

**Empty opposing set:** if there are no opposing signals (rare — a perfectly clean event),
render the opposing section header with a calm line ("No counter-signals — this event looks
clearly suited to {AI / a human editor}.") rather than omitting it, so the admin still registers
that the system looked for counter-arguments. **[CONFIRM]** show-empty vs hide — §13 Q5.

### 4.3 Live analyzer preview (status `ACTIVE` / `DEADLINE_PASSED`, pre-gate)

During collection the admin sees a **non-actionable** preview (`requirements.md` §5.5 "Live
analyzer preview during collection window — admin can see the recommendation trending … without
acting on it"):

| Element | Behavior |
|---|---|
| Trending recommendation + confidence | Same recommendation/confidence display as the card, labeled clearly as a **preview** ("Preview — recommendation may change as submissions arrive"). Computed live (§5.4), not from persisted fields |
| Supporting / opposing signals | Optionally shown (collapsed by default) so the admin can see *why* it is trending — read-only |
| **No action buttons** | Approve / Switch are **absent** before the gate. The only manual control present pre-gate is the **"Trigger Manual Workflow"** override (§4.4) |
| "Submissions still open" hint | "Submissions close {short date/time}. The final recommendation is set at the deadline." |

The preview is explicitly informational. The canonical decision happens only at/after the
deadline (status `AWAITING_ROUTING_APPROVAL`).

### 4.4 "Trigger Manual Workflow" override (available outside the gate)

Per `requirements.md` §5.5, manual routing is **also** available as an override at any time, not
just at the deadline gate. UI:

| Element | Behavior |
|---|---|
| Button | "Trigger Manual Workflow" — secondary/warning-tinted (`--warning`). Visible while status ∈ {`ACTIVE`, `DEADLINE_PASSED`, `AWAITING_ROUTING_APPROVAL`} **[CONFIRM]** allowed-from set — §13 Q6 |
| Confirm step | Lightweight inline confirm ("Route this event to a human editor now? This skips AI routing.") with Confirm / Cancel — because it pre-empts the analyzer recommendation |
| Effect | Sets `Event.status = MANUAL_ROUTED`, `routingDecision = MANUAL`, attribution fields, and an `AuditLog` row flagged as an **override** (§11). If invoked before the canonical run persisted a recommendation, `routingRecommendation` may be null — the audit records `recommendation: null, chosen: MANUAL, override: true` |

This override is the manual-quality-control escape hatch (`requirements.md` §5.7 "when Admin
chooses manual quality control").

### 4.5 States (mutually exclusive, keyed on `Event.status`)

| `Event.status` | Routing section renders |
|---|---|
| `DRAFT` / payment pending | Nothing (no submissions yet) — or a muted "Routing analysis begins once collection starts." **[CONFIRM]** — §13 Q7 |
| `ACTIVE` | Live preview (§4.3) + "Trigger Manual Workflow" (§4.4). No persisted result, no Approve/Switch |
| `DEADLINE_PASSED` (post-sweep, pre-canonical-run; transient) | Live preview or a brief "Finalizing recommendation…" placeholder until the canonical run flips to `AWAITING_ROUTING_APPROVAL` (§5.4 ordering) |
| `AWAITING_ROUTING_APPROVAL` | The approval card (§4.2) with both action buttons + override |
| `AI_ROUTED` | Decided state: "Routed to AI by {admin} on {date}." + a read-only recap of the signals shown. No action buttons. (Downstream AI pipeline status is Story 16's surface) |
| `MANUAL_ROUTED` | Decided state: "Routed to a human editor by {admin} on {date}." + signal recap. The editor-assignment panel is **Story 13's** addition below this |
| `EDITOR_ASSIGNED` … `DELIVERED` | Decided recap only (collapsed); routing is settled |

### 4.6 Interaction / optimistic + confirmation states

| State | Trigger | UI |
|---|---|---|
| Idle (awaiting) | status `AWAITING_ROUTING_APPROVAL` | Both buttons enabled; recommendation + signals shown |
| Confirm | Click either action | Lightweight inline confirm naming the consequence ("Approve AI routing? The AI generation pipeline will start." / "Switch to manual? A human editor will be assigned."). Both actions confirm because both are consequential and start downstream work. **[CONFIRM]** confirm-on-both vs only-on-switch — §13 Q8 |
| Pending (optimistic) | Action submitted | Buttons disabled with a subtle spinner; status chip optimistically shows the target ("AI Routed" / "Manual Routed") |
| Success | Server confirms | Card collapses to the decided-state recap (§4.5) with the attribution line; calm inline note ("Routed to AI."); page revalidates |
| Error | Server rejects (§5.7) | Optimistic chip reverts to `AWAITING_ROUTING_APPROVAL`; inline calm error (§4.7); buttons re-enabled. No partial state |

Optimistic update is purely visual; the **server is authoritative** (§5). The action revalidates
`/admin/events/[id]`.

### 4.7 Error copy (admin-facing, calm voice)

| Case | Message |
|---|---|
| Event not found / stale | "This event could not be found. Refresh and try again." |
| Forbidden (shouldn't reach UI) | "You don't have access to do that." |
| Wrong status (already decided / not yet awaiting) | "This event isn't awaiting a routing decision." |
| Race (decided by another admin) | "This event was just routed by another admin. Refreshing to show the current state." |
| Unexpected | "Something went wrong. Try again." |

### 4.8 Accessibility & branding

- Buttons are real `<button>`s with discernible names ("Approve AI routing for {honoreeName}");
  status/recommendation are not color-only (icon + text).
- Confidence is announced as text ("Recommended: AI routing, confidence 87 percent").
- Action result announced via an `aria-live="polite"` region.
- Supporting/opposing lists are semantic lists with icons that are decorative (`aria-hidden`),
  the meaning carried by the `message` text.
- Keyboard-operable end to end; visible focus; WCAG AA contrast on all palette pairs.

---

## 5. Backend Design

### 5.1 The analyzer module — types & signature

Per `architecture.md` §6.4. The analyzer is a **pure function** (no DB, no network, no clock
beyond a passed/now `computedAt`) operating on an already-loaded event aggregate, so it is
trivially unit-testable and runs in sub-second time.

**`Signal`** (one per rule):

| Field | Type | Meaning |
|---|---|---|
| `name` | string (stable id, e.g. `consistent_media_type`) | The rule's stable identifier (for tests, audit, metrics) |
| `direction` | `'AI' \| 'MANUAL'` | Which way a triggered signal pushes |
| `weight` | number `0..1` | The signal's contribution magnitude (§5.3 table) |
| `triggered` | boolean | Whether the trigger condition held for this event |
| `message` | string | Human-readable, data-filled (e.g. "12 of 14 contributors uploaded video clips") for the admin UI |
| `value` | (optional) string/number | The raw measured value behind the message (e.g. `0.86` for the media-type-consistency ratio), to satisfy `requirements.md` §5.6's `{name, value, impact, message}` shape — see §5.6 mapping note |

**`RoutingResult`:**

| Field | Type | Meaning |
|---|---|---|
| `recommendation` | `'AI' \| 'MANUAL'` | The deterministic verdict (§5.4 scoring) |
| `confidence` | number `0..1` | How decisive the verdict is (§5.4) |
| `signalsSupporting` | `Signal[]` | Triggered signals whose `direction == recommendation` ("Why this fits") |
| `signalsOpposing` | `Signal[]` | Triggered signals whose `direction != recommendation` ("Why the other might be better") |
| `computedAt` | Date | When this result was computed |

**Signature:** `analyzeEvent(eventWithSubmissions) → RoutingResult`, where `eventWithSubmissions`
is the event plus its submissions plus each submission's media items (with `type`, `width`,
`height`, `qualityFlags`/`qualityScore`) and `occasionType` + `expectedContributors`. The
analyzer reads **only counts/metadata** — never transcripts, sentiment, or quotes.

> **Pure-function discipline.** Split as: (a) a set of per-signal pure evaluators `(features) →
> Signal`; (b) a `deriveFeatures(eventWithSubmissions) → AnalyzerFeatures` adapter that reduces
> the aggregate to the scalar inputs each signal needs (the only place that touches the Prisma
> shape); (c) `aggregate(signals[]) → {recommendation, confidence, supporting, opposing}`. The
> evaluators and aggregate are unit-tested with plain feature/Signal fixtures, no DB.

### 5.2 Population eligibility — which submissions/media count

The analyzer must define its denominator precisely:

| Question | Decision | Rationale |
|---|---|---|
| Which submissions count? | **`APPROVED` and `PENDING`** submissions; **exclude `REJECTED`** (incl. auto-rejected `<20` quality, Story 9). **[CONFIRM]** APPROVED-only vs APPROVED∪PENDING — §13 Q9 | At the deadline most submissions may still be `PENDING` (admin hasn't finished review); excluding them would distort counts. Rejected media is genuinely absent from the deliverable so it is excluded. Mirrors the open question in Story 8 §13 Q4 — must be resolved consistently |
| "Contributor count" | Count of **eligible submissions** (one submission per contributor, enforced `@@unique([eventId, email])`) | The `≤15` / `>40` thresholds are about contributors, i.e. submissions |
| Which media count for media-mix / orientation / quality-flag signals | Media items belonging to **eligible** submissions only | Don't let a rejected blurry video flip an orientation/quality signal |
| Orientation of a video | `width > height` → landscape; `height > width` → portrait; `width == height` (square) → **[CONFIRM]** treat as neither / its own bucket — §13 Q10 | Story 9 already sets a `portrait` flag; orientation here is derived from `width`/`height` so it works even if the flag is absent |
| Empty event (0 eligible submissions / 0 media) | Analyzer returns a defined default — **recommendation `MANUAL`, low confidence, all signals untriggered** **[CONFIRM]** — §13 Q11 | A deadline with no submissions is an edge case a human should look at; defaulting to MANUAL is the safe (human-in-loop) choice |

### 5.3 The full MVP 1 signal ruleset

Every signal from `requirements.md` §5.6, each a pure function with an exact trigger, a direction,
a proposed weight, and a message template. **All weights are proposals for production tuning
(`requirements.md` §5.6: "Exact thresholds tuned in production based on admin override rates") —
flagged §13 Q12.** Weights are versioned in-code (a `ROUTING_RULESET_VERSION` constant recorded
with each result, mirroring `AiArtifact.promptVersions` thinking) so a weight change is a reviewed
code change, not a silent env tweak (§7).

Let `N` = eligible contributor (submission) count; `V` = count of contributors with ≥1 video;
`flagRate` = (media items with non-empty `qualityFlags`, excluding the purely-informational
`portrait` flag) ÷ (total eligible media items); `distinctMediaTypes` = number of distinct
`MediaType` values present across eligible media (VIDEO/VOICE/PHOTO; text-only counts as a "text"
type for the mixed-media count — **[CONFIRM]** whether text counts toward "3+ media types" —
§13 Q13).

#### 5.3.1 AI-leaning signals (`direction = AI`)

| # | `name` | Triggers when | Weight (proposed) | `message` template |
|---|---|---|---|---|
| S1 | `consistent_media_type` | ≥80% of eligible contributors uploaded the **same** dominant media type (max share across {video, voice, photo} ≥ 0.80) | **0.20** | "{k} of {N} contributors uploaded {dominantType}" |
| S2 | `all_video_submissions` | **Every** eligible contributor uploaded **at least one** video (`V == N` and `N ≥ 1`) | **0.25** | "All {N} contributors uploaded video clips" |
| S3 | `consistent_orientation` | There **is** ≥1 video and **all** videos share one orientation (all landscape OR all portrait) | **0.15** | "All videos in {landscape/portrait} orientation" |
| S4 | `low_contributor_count` | `N ≤ 15` (and `N ≥ 1`) | **0.15** | "Small contributor count ({N})" |
| S5 | `clean_quality` | `flagRate < 0.10` (and ≥1 eligible media item) | **0.20** | "No quality flags raised" (or "{flaggedCount} of {mediaCount} files flagged" when >0 but <10%) |

#### 5.3.2 Manual-leaning signals (`direction = MANUAL`)

| # | `name` | Triggers when | Weight (proposed) | `message` template |
|---|---|---|---|---|
| S6 | `mixed_media_event` | `distinctMediaTypes ≥ 3` across eligible contributors | **0.25** | "Submissions include {distinctMediaTypes} media types" |
| S7 | `mixed_orientations` | There exist **both** ≥1 portrait video **and** ≥1 landscape video | **0.20** | "Both portrait and landscape videos present" |
| S8 | `business_event` | `Event.occasionType == BUSINESS_EVENT` | **0.25** | "Business event — typically needs creative editing" |
| S9 | `high_quality_flag_rate` | `flagRate ≥ 0.25` | **0.20** | "{flaggedCount} of {mediaCount} files have quality issues" |
| S10 | `high_contributor_count` | `N > 40` | **0.20** | "Large contributor count ({N})" |

> **Notes on the ruleset.**
> - **S2 vs S1:** "all video" (S2) is a stronger, distinct AI signal than "consistent media type"
>   (S1); both may trigger together (consistent type = video AND all video). That double-push is
>   intentional — a uniformly-video event is the canonical easy AI case.
> - **S3 vs S7 are complementary:** S3 (all-same orientation) only triggers when there is no mix;
>   S7 (mixed) only when there is. They cannot both trigger. Both require ≥1 video.
> - **`portrait` is informational, not a defect** (Story 9 §5.5): it never feeds `flagRate`
>   (S5/S9), only orientation signals (S3/S7).
> - **Square videos** (`width == height`) are excluded from the portrait/landscape mix decision
>   per §13 Q10 unless confirmed otherwise.
> - All thresholds (0.80, 0.10, 0.25, 15, 40, 3) are **the literal §5.6 values**; the **weights**
>   are this doc's proposal (§13 Q12).

#### 5.3.3 Untriggered signals

Every signal is still **returned** in the full evaluation (with `triggered: false`) for unit
testing and metrics, but only **triggered** signals contribute to the score and appear in the
supporting/opposing lists shown to the admin.

### 5.4 Scoring → recommendation → confidence

A deterministic weighted tally over **triggered** signals:

1. `aiScore` = Σ `weight` over triggered signals with `direction == AI`.
2. `manualScore` = Σ `weight` over triggered signals with `direction == MANUAL`.
3. **Recommendation:**
   - Normalize: `aiShare = aiScore / (aiScore + manualScore)` (when the denominator > 0).
   - If `aiShare ≥ AI_THRESHOLD` → `recommendation = AI`; else `MANUAL`.
   - **`AI_THRESHOLD` proposed = 0.55** **[CONFIRM]** (§13 Q14). A value >0.5 biases ties and
     near-ties toward MANUAL (human-in-loop), matching the product's "when in doubt, a human
     looks" posture.
   - **Denominator 0** (no triggered signals at all) → default per §5.2 empty-event rule
     (MANUAL, low confidence).
4. **Confidence** = how decisive the verdict is, in `0..1`. **Proposed:** `confidence =
   |aiShare − 0.5| × 2`, clamped to `[0,1]` (0.5 share → 0 confidence; 1.0 or 0.0 share → 1.0
   confidence). **[CONFIRM]** confidence formula — §13 Q15. (Alternative considered: confidence =
   `max(aiScore,manualScore)/(aiScore+manualScore)` = `max(aiShare, 1−aiShare)`, which ranges
   `0.5..1`; the `×2` centering gives a more intuitive `0..1`. The mock's "87%" is reproducible
   under the chosen formula given the example signal set.)

> **Why a share, not a raw threshold on `aiScore`.** Normalizing to a share makes the
> recommendation invariant to how many signals happened to trigger and keeps `AI_THRESHOLD`
> interpretable (a fraction). It also makes confidence a clean function of the same quantity.

5. **Supporting/opposing partition:** `signalsSupporting` = triggered signals with `direction ==
   recommendation`; `signalsOpposing` = triggered signals with `direction != recommendation`.
   (So when AI is recommended, AI-leaning triggered signals support and MANUAL-leaning triggered
   signals oppose — and vice-versa.) Sort each list by descending `weight` so the strongest
   reasons render first.

### 5.5 Where it runs — the two run modes

#### 5.5.1 Live-preview run (after each submission analysis)

- **Hook:** at the **tail of the Story 11 per-submission `analysis` job** (the DAG's "score
  complexity / recalculate event-level routing" step, `architecture.md` §6.3). When a
  submission's analysis completes, re-derive features for the event and run `analyzeEvent`.
- **Output:** **compute-only.** The result is **NOT** written to the canonical `Event.routing*`
  fields and **does not** change `Event.status`. It is surfaced to the admin live preview
  (§4.3). **[CONFIRM]** how the live result reaches the admin UI — three options (§13 Q16):
  (a) **on-demand recompute** — the `/admin/events/[id]` server component calls `analyzeEvent`
  itself when status is pre-gate (no storage, always fresh; recommended — the analyzer is
  sub-second and pure); (b) cache the latest preview in a non-canonical column/cache; (c) push
  via the worker. **Recommendation: (a)** — simplest, no extra column, no staleness, no extra
  job side effect. The Story 11 job then needs **no** routing side effect at all for the preview;
  "runs after each submission" is satisfied because the admin page recomputes on view. (If a
  trending value must update without a page load, revisit with (b)/(c).)
- **Idempotency:** trivially idempotent — it is a pure read-compute, no writes.

#### 5.5.2 Canonical deadline run

- **Trigger:** chained off the **Story 18 deadline-reached flow** that flips `ACTIVE →
  DEADLINE_PASSED` (Story 18 §5.3.3, which names this "the signal Story 12's analyzer/routing
  picks up"). **Preferred wiring:** the deadline-reached handler, **after** flipping to
  `DEADLINE_PASSED` and sending its organizer/admin reminders, **enqueues** a
  `routing.finalize` job (queue `analysis`, **[CONFIRM]** queue choice — §13 Q17) keyed by the
  event. The job performs the canonical run. (Alternative: the deadline handler flips straight
  to `AWAITING_ROUTING_APPROVAL` and the routing job does the rest — but keeping Story 18's flip
  to `DEADLINE_PASSED` unchanged and chaining a Story-12-owned job keeps the two stories'
  responsibilities clean.)
- **Idempotency key** (Story 9 convention): `{eventId}::routing.finalize` (no submission
  segment — this is event-level). Re-running overwrites the same `Event.routing*` fields with the
  same computed values (output-by-key), and the status flip + notification are guarded against
  duplication (below).
- **The job's steps (one DB transaction for the persist+flip):**
  1. Load the event aggregate (event + eligible submissions + media). If status is **not** in the
     allowed set ({`DEADLINE_PASSED`} — and tolerate `AWAITING_ROUTING_APPROVAL` as a re-run
     no-op, and `MANUAL_ROUTED`/`AI_ROUTED` as "already decided → skip") → no-op success
     (idempotent; covers a missed/duplicate sweep). **[CONFIRM]** allowed-from set — §13 Q18.
  2. `result = analyzeEvent(eventAggregate)` with `computedAt = now`.
  3. **Transaction:** set `Event.routingRecommendation = result.recommendation`,
     `routingConfidence = result.confidence`, `routingSignals = { supporting:
     result.signalsSupporting, opposing: result.signalsOpposing, rulesetVersion, computedAt }`,
     and `Event.status = AWAITING_ROUTING_APPROVAL`. Do **not** set `routingDecision` /
     `routingDecidedBy` / `routingDecidedAt` here — those are set only by the human gate (§5.6).
  4. **After commit**, fire the admin notification `event.routing_ready` via the Story 18
     dispatcher (`recipientType = admin`, recipient = `ADMIN_NOTIFY_EMAIL`, deduped by
     `NotificationLog` on `(eventId, 'event.routing_ready')` so a re-run doesn't re-notify). The
     honoree-suppression filter still applies (recipient is admin, never honoree).
  5. Optionally write a **system** `AuditLog` row `routing.analyzed` (`actorId: null`,
     `metadata: { recommendation, confidence, signals, rulesetVersion }`) recording the canonical
     analyzer output as of the deadline (distinct from the human decision). **[CONFIRM]** include
     the system audit row — §13 Q19.
- **Why a transaction for persist+flip:** the persisted recommendation and the
  `AWAITING_ROUTING_APPROVAL` status must be consistent — never a card with no recommendation,
  never a stored recommendation the admin can't act on.

> **Ordering vs Story 18.** Story 18 sends the deadline-reached organizer/admin reminders, flips
> to `DEADLINE_PASSED`, then (this story) enqueues `routing.finalize`. So the admin gets the
> generic "ready for review" deadline alert from Story 18 **and**, once the analyzer finalizes,
> the routing-specific `event.routing_ready`. **[CONFIRM]** whether these should be merged into a
> single admin alert to avoid two emails — §13 Q20. Recommendation: keep them distinct (one says
> "collection closed", the other says "a routing decision is waiting"); they may fire seconds
> apart.

### 5.6 The two approval actions (the gate)

Two admin-only **Server Actions** (App Router, consistent with Story 8's pattern), invoked from
the approval card. A third action implements the "Trigger Manual Workflow" override (§4.4).

**Common inputs (Zod-validated; actor derived server-side, never from the client):**

| Field | Type | Required | Notes |
|---|---|---|---|
| `eventId` | string (cuid) | yes | The event to route |
| (action implied by the entry point) | — | — | `approveAiRouting`, `switchToManual`, `triggerManualOverride` are distinct actions, not a `chosen` param, so the chosen direction can't be tampered with |

**Algorithm (authoritative order, shared):**

1. **AuthN/AuthZ.** Resolve session; require `role == ADMIN` (+ allowlisted domain, Story 7
   guard). Else → **FORBIDDEN** (E2). Nothing read/written.
2. **Load** the event by `eventId`. Not found → **EVENT_NOT_FOUND** (E1).
3. **Status check.** For `approveAiRouting` / `switchToManual`, require
   `status == AWAITING_ROUTING_APPROVAL`. For `triggerManualOverride`, require `status ∈
   {ACTIVE, DEADLINE_PASSED, AWAITING_ROUTING_APPROVAL}` (§4.4 / §13 Q6). Otherwise →
   **INVALID_ROUTING_STATE** (E3).
4. **Idempotent no-op / race.** If status is already a terminal routing state matching the
   intended decision (e.g. `approveAiRouting` on an already `AI_ROUTED` event) → success no-op
   (no second audit row). If it's the *other* terminal state (already `MANUAL_ROUTED` when
   approving AI) → **ROUTING_ALREADY_DECIDED** (E4) so the UI shows "decided by another admin"
   (§4.7). (Last-writer-loses on the second click; the first decision stands.)
5. **Transaction (single DB transaction):**
   a. `Event.status` = `AI_ROUTED` (approve-AI) | `MANUAL_ROUTED` (switch / override).
   b. `Event.routingDecision` = `AI` | `MANUAL`.
   c. `Event.routingDecidedBy` = session user id; `Event.routingDecidedAt` = now.
   d. Insert one `AuditLog` row (§11): `action` = `routing.approved` (chose the recommended
      path) | `routing.switched` (chose against the recommendation) | `routing.manual_override`
      (the off-gate override), `actorId` = session user id, `eventId`, `metadata` = the §6.4
      shape (recommendation, confidence, chosen, signalsShown, override flag, timestamp).
   - State change and audit insert **succeed or fail together**.
6. **After commit:** **enqueue nothing downstream in this story.** The status is the seam:
   Story 16 watches for `AI_ROUTED`, Story 13 for `MANUAL_ROUTED`. (When those land, the enqueue
   of the storyboard / brief job is added **here**, after commit — flagged as the handoff point,
   §13 Q21.) Revalidate `/admin/events/[id]`.

**`routing.approved` vs `routing.switched` mapping** (`architecture.md` §6.4 uses both):

| Action invoked | Recommendation was | Chosen | `AuditLog.action` |
|---|---|---|---|
| Approve AI Routing | `AI` | `AI` | `routing.approved` |
| Approve (Manual recommended) | `MANUAL` | `MANUAL` | `routing.approved` |
| Switch to Manual | `AI` | `MANUAL` | `routing.switched` |
| Switch to AI | `MANUAL` | `AI` | `routing.switched` |
| Trigger Manual Workflow (off-gate) | (any / null) | `MANUAL` | `routing.manual_override` |

i.e. `routing.approved` = chosen matches the recommendation; `routing.switched` = chosen differs
(this is exactly the override-rate numerator, §11). **[CONFIRM]** whether the off-gate override
is `routing.manual_override` or folded into `routing.switched` — §13 Q22.

> **`requirements.md` §5.6 return shape vs `architecture.md` §6.4 type — reconciliation.**
> Requirements specifies `signals: [{name, value, impact, message}]` (a flat list with an
> `impact`); architecture specifies `{direction, weight, triggered}` per `Signal` plus a
> supporting/opposing split. These are the **same data, two views**: `impact` ≈ `direction`
> (which way it pushes) optionally combined with `weight` (how hard). This doc adopts the
> **architecture `Signal` shape** as canonical (it is richer and is what the schema/UI consume),
> and treats `requirements`' `value`/`impact` as derived: `impact = direction` (and the UI may
> show magnitude from `weight`); `value` = the optional raw measurement (§5.1). The persisted
> `routingSignals` JSON stores the architecture shape. **[CONFIRM]** — §13 Q23.

### 5.7 Error cases

Server Actions don't set HTTP codes; the "HTTP-equiv" column is the contract a thin JSON route
would honor and what integration tests assert on.

| # | Case | Detection | Error code | HTTP-equiv | Admin sees | Side effects |
|---|---|---|---|---|---|---|
| E1 | Event not found / stale id | step 2 | `EVENT_NOT_FOUND` | 404 | "could not be found…" | none |
| E2 | Caller not admin (no session / wrong role / domain) | step 1 | `FORBIDDEN` | 403 | "don't have access…" | log (warn) |
| E3 | Wrong status for the action | step 3 | `INVALID_ROUTING_STATE` | 409 | "isn't awaiting a routing decision" | none |
| E4 | Already decided the other way (race) | step 4 | `ROUTING_ALREADY_DECIDED` | 409 | "just routed by another admin…" | none; UI refreshes |
| E5 | Unexpected (DB/txn failure) | any | `INTERNAL` | 500 | "Something went wrong…" | log (error); txn rolled back (no partial write) |

**Analyzer / canonical-run error cases (worker side):**

| Case | Handling |
|---|---|
| `analyzeEvent` throws (should be impossible — pure, total over any input incl. empty) | Treated as a code bug: the `routing.finalize` job fails, retries (Story 9 policy: `attempts=3`, exp backoff), then lands in `failed`; the event stays `DEADLINE_PASSED` (no card) and an alert is logged so an operator notices. Status is **not** flipped on failure (no card with no recommendation) |
| Notification dispatch fails (after commit) | Status is already `AWAITING_ROUTING_APPROVAL` (committed); the card is visible regardless. The notification retries per Story 18's dispatcher policy; a permanently-failed notify logs `failed` in `NotificationLog` but does **not** roll back the routing state (the admin can still find the event via the dashboard SLA list) |
| Re-run after status already `AWAITING_ROUTING_APPROVAL` or already decided | No-op success per §5.5.2 step 1 (idempotent) |

---

## 6. Database Design

Story 12 adds the **`Event` routing fields**, the **`EventStatus`** values, and the
**`RoutingDecision`** enum from `architecture.md` §7.1. It **reuses** `AuditLog` (Story 8) and
`NotificationLog` (Story 18) unchanged.

### 6.1 `Event` routing fields (added this story)

| Field | Type | Null? | Default | Written by | Meaning |
|---|---|---|---|---|---|
| `routingRecommendation` | `RoutingDecision?` | yes | — | canonical run (§5.5.2) | Analyzer verdict (`AI` \| `MANUAL`); null until the deadline run |
| `routingConfidence` | `Float?` | yes | — | canonical run | `0..1`; null until the deadline run |
| `routingSignals` | `Json?` | yes | — | canonical run | `{ supporting: Signal[], opposing: Signal[], rulesetVersion, computedAt }` — the exact signals shown to the admin |
| `routingDecision` | `RoutingDecision?` | yes | — | **approval gate only** (§5.6) | The admin's approved decision (`AI` \| `MANUAL`); set only after a human acts. Distinct from `routingRecommendation` so we retain both system recommendation AND human choice (`architecture.md` §7.1 note, override analytics) |
| `routingDecidedBy` | `String?` | yes | — | approval gate | The deciding admin's `User.id` (plain string, mirrors `AuditLog.actorId` convention — no FK **[CONFIRM]** §13 Q24) |
| `routingDecidedAt` | `DateTime?` | yes | — | approval gate | When the human decided |

> **`routingRecommendation` (system) vs `routingDecision` (human) are deliberately separate**
> (`architecture.md` §7.1 / §6.4). The override rate (§11) is computed from rows where
> `routingDecision != routingRecommendation`. The analyzer never writes `routingDecision`; the
> gate never writes `routingRecommendation`.

### 6.2 `EventStatus` enum additions

`architecture.md` §7.1 declares the full enum. Story 12 ensures these three values exist (added
by whichever earlier story first needed them; if absent, this migration adds them):

| Value | Set by | Meaning |
|---|---|---|
| `AWAITING_ROUTING_APPROVAL` | canonical run (§5.5.2) | Deadline passed, analyzer finalized, admin must decide |
| `AI_ROUTED` | approve-AI action | Admin chose AI; Story 16 pipeline may start |
| `MANUAL_ROUTED` | switch / override action | Admin chose manual; Story 13 workflow may start |

`ACTIVE` and `DEADLINE_PASSED` are pre-existing (Stories 3/18). The transition graph this story
introduces:

```
ACTIVE ──(Story 18 deadline sweep)──► DEADLINE_PASSED
   │                                       │
   │ (Trigger Manual override)             │ (Story 12 canonical run)
   ▼                                       ▼
MANUAL_ROUTED                       AWAITING_ROUTING_APPROVAL
                                          │
                              ┌───────────┴───────────┐
                         Approve AI              Switch to Manual
                              ▼                        ▼
                          AI_ROUTED              MANUAL_ROUTED
```

(The off-gate override can fire from `ACTIVE` / `DEADLINE_PASSED` / `AWAITING_ROUTING_APPROVAL`,
all → `MANUAL_ROUTED`.)

### 6.3 `RoutingDecision` enum (added this story)

`enum RoutingDecision { AI MANUAL }` (`architecture.md` §7.1). Used by both
`Event.routingRecommendation` and `Event.routingDecision`.

### 6.4 `routingSignals` JSON shape (persisted)

```
{
  supporting: [ { name, direction, weight, triggered: true, message, value? }, ... ],
  opposing:   [ { name, direction, weight, triggered: true, message, value? }, ... ],
  rulesetVersion: "v1",          // ROUTING_RULESET_VERSION at compute time
  computedAt: "2026-05-20T..."   // ISO; the canonical run's RoutingResult.computedAt
}
```

Only **triggered** signals are persisted (the supporting/opposing lists are what the admin saw).
`recommendation` and `confidence` are first-class columns (`routingRecommendation`,
`routingConfidence`), not duplicated inside the JSON. **[CONFIRM]** whether to also persist the
full untriggered set for audit — recommend **no** (the columns + triggered lists are sufficient;
the ruleset version lets us recompute) — §13 Q25.

### 6.5 `AuditLog` usage (no schema change)

Reuses the Story 8 `AuditLog` model. New `action` values only (§11). The `Event.auditLog`
back-relation already exists (Story 3/8). No new columns.

### 6.6 Indexes & migration notes

| Index | On | Reason |
|---|---|---|
| (reuse) `@@index([status, submissionDeadline])` | `Event` (Story 3/18) | The canonical-run trigger and the admin SLA list both query by status; no new index needed |
| (optional) `@@index([status])` | `Event` | Only if the admin "events awaiting routing" filter needs it at scale — **[CONFIRM]** defer (§13 Q26) |

- Migration name: `add_event_routing_fields` (e.g. `<ts>_add_event_routing_fields`).
- **Additive only:** add the six nullable `Event` columns, the `RoutingDecision` enum, and the
  three `EventStatus` values (if not already present). All nullable / enum-extension → safe
  `prisma migrate deploy` against `swara_prd`, **no backfill** (existing events keep null routing
  fields; they predate routing and will route via the override if ever needed).
- The migration references `Event` and the enums; confirm Story 3's `Event` + `EventStatus`
  precede it in history.
- Run `prisma generate` after migrate so the new fields/enums are available to web + workers.

---

## 7. External Services / Integrations / Config

**No new external service.** The analyzer is pure and local; the only outbound action is the
`event.routing_ready` admin notification, which reuses **Story 18's `Channel` interface + shared
dispatcher + `NotificationLog`** (Resend in prod / Mailpit in dev). Story 12 adds the **trigger
name + email template content**, not the dispatcher.

### 7.1 Config

| Where | Key | Purpose |
|---|---|---|
| In-code versioned constants (`src/services/routing/ruleset.ts` **[CONFIRM location]**, not env) | `ROUTING_RULESET_VERSION`, per-signal `weight`s, `AI_THRESHOLD`, the confidence formula | Weights/threshold are **reviewed code changes**, recorded with each result for tuning correlation. Keeping them out of env prevents a silent prod tweak from shifting every routing decision unaudited |
| Reused from Story 18 | `ADMIN_NOTIFY_EMAIL`, `RESEND_*` / dev SMTP | The `event.routing_ready` recipient + transport |
| Reused from Story 9 | queue concurrency, BullMQ wiring | The `routing.finalize` job runs in the existing worker on the `analysis` queue (§5.5.2 / §13 Q17) |

**No `process.env` outside `src/config/`** (Story 1 ESLint rule). If any routing knob is later
deemed operationally tunable, add it to **both** `src/config/env.ts` and `src/config/index.ts`;
none is proposed for MVP 1.

### 7.2 The `event.routing_ready` notification

| Field | Value |
|---|---|
| Trigger name | `event.routing_ready` (`architecture.md` §6.4) |
| Recipient | admin (`ADMIN_NOTIFY_EMAIL`); `recipientType = admin` |
| Dedupe key | `(eventId, 'event.routing_ready')` in `NotificationLog` — at most once per event |
| Body (brand voice, §branding §3) | Names the honoree/occasion, states the recommendation in plain words ("This event looks straightforward — AI can handle the editing" / "This event looks complex — a human editor may be the better fit"), links to `/admin/events/[id]`. No exclamation marks. Never includes a honoree contact |
| Channel | `EmailChannel` (the only MVP 1 `Channel`) |

---

## 8. Seed Data

Extend the existing `npm run seed` so every signal, both recommendations, and the
`AWAITING_ROUTING_APPROVAL` state are exercisable locally. All seeds idempotent (upsert by slug);
an `ADMIN` actor user already exists (Story 8 seed). **Do not** seed `AuditLog` rows (audit is
produced by acting).

Proposed seeded events (each with appropriately-shaped submissions/media):

| Seed event | Shape | Exercises | Expected |
|---|---|---|---|
| `riyas-graduation` (the mock) | 14 contributors, 12 with landscape video, 2 photo-only, no quality flags | S1 (≥80% video), S2 *not* (not all video), S3 (consistent landscape), S4 (≤15), S5 (clean) supporting; one opposing (photo-only) | **AI**, high confidence; status `AWAITING_ROUTING_APPROVAL` |
| `acme-25th-anniversary` | `BUSINESS_EVENT`, 50 contributors, mixed video+voice+photo, mixed orientations, ~30% flagged | S6, S7, S8, S9, S10 (all manual) | **MANUAL**, high confidence; status `AWAITING_ROUTING_APPROVAL` |
| `small-birthday-photos` | 6 contributors, photos only, clean | S1 (consistent), S4 (low count), S5 (clean) | **AI** |
| `wedding-montage` | 60 contributors, video, mixed orientations | S7, S10 manual; S2 AI — exercises a contested score near the threshold | **MANUAL** (tunes `AI_THRESHOLD`) |
| `borderline-mixed` | ~16 contributors, 2 media types, one orientation, ~12% flags | a near-tie to validate the threshold/confidence math | recommendation depends on weights — useful for tuning |
| `active-collecting` | status `ACTIVE`, partial submissions | the **live preview** (no card, no decision) + the override button | preview only |
| `already-ai-routed` | status `AI_ROUTED`, decision fields set | the **decided-state recap** | recap only |

At least one event in `AWAITING_ROUTING_APPROVAL` with persisted `routingRecommendation` /
`routingConfidence` / `routingSignals` (both supporting and opposing populated) so the card
renders without first running the worker. **[CONFIRM]** whether the seed pre-persists the
canonical result or the dev runs `routing.finalize` to produce it — §13 Q27.

---

## 9. Testing

Follows the project pattern (Vitest, `tests/unit` + `tests/integration`). DB/Redis-touching tests
guarded by **`SKIP_INTEGRATION`**. The analyzer being a **pure function** means the bulk of the
coverage is fast unit tests with feature/Signal fixtures — no DB, no FFmpeg, no LLM.

### 9.1 Unit tests (no infra; pure logic)

| Test | Asserts |
|---|---|
| **Each signal fires correctly** (S1–S10) | For each signal: a fixture that satisfies the trigger → `triggered: true`, correct `direction`, `weight`, and a data-filled `message`; a fixture just below the threshold → `triggered: false`. One test per signal (10) plus boundary tests at the exact §5.6 thresholds (0.80, 0.10, 0.25, 15/16, 40/41, 3) |
| Dominant-media-type math (S1) | max-share computation across {video,voice,photo}; ≥0.80 boundary |
| All-video (S2) | triggers only when every contributor has ≥1 video; N=0 → false |
| Orientation (S3/S7) | all-landscape → S3 only; all-portrait → S3 only; mixed → S7 only; no video → neither; square handling per §13 Q10 |
| Quality-flag rate (S5/S9) | `flagRate` excludes `portrait`; <0.10 → S5; ≥0.25 → S9; in-between → neither |
| Business event (S8) | `occasionType == BUSINESS_EVENT` → true; others → false |
| Contributor count (S4/S10) | ≤15 → S4; >40 → S10; 16..40 → neither |
| **Score aggregation** | `aiScore`/`manualScore` sum only triggered signals' weights |
| **Recommendation threshold** | `aiShare ≥ AI_THRESHOLD` → AI; just below → MANUAL; denominator 0 → empty-event default |
| **Confidence calculation** | the §5.4 formula maps share→confidence (0.5→0, 1.0/0.0→1); reproduces the mock's ~87% for the example signal set |
| **Supporting/opposing partition** | supporting = triggered ∧ direction==recommendation; opposing = the rest; lists sorted by descending weight; opposing non-empty when a counter-signal triggered |
| Empty / single-submission / all-rejected event | defined defaults; rejected submissions excluded from counts (§5.2) |
| Eligibility denominator | rejected media excluded from media-mix/orientation/flag math; PENDING included per §5.2 decision |
| Determinism / purity | same input → identical `RoutingResult` (no clock dependence beyond injected `computedAt`); no network/DB calls |
| Ruleset version recorded | `RoutingResult`/persisted JSON carries `ROUTING_RULESET_VERSION` |
| **Approval-action authz** (mocked session) | non-admin / no session → FORBIDDEN before any read/write; admin → proceeds |
| **Approval status check** | approve/switch require `AWAITING_ROUTING_APPROVAL`; override allowed-from set; wrong status → INVALID_ROUTING_STATE; already-other-decision → ROUTING_ALREADY_DECIDED |
| **Audit action mapping** | recommendation×chosen → `routing.approved` / `routing.switched`; off-gate → `routing.manual_override` (§5.6 table) |
| Audit metadata shape | `{ recommendation, confidence, chosen, signalsShown, override, timestamp }` (§11) |

### 9.2 Integration tests (`SKIP_INTEGRATION` guards DB + Redis)

| Test | Flow |
|---|---|
| **Canonical deadline run persists + flips + notifies** | Seed a `DEADLINE_PASSED` event with submissions/media → run `routing.finalize` → assert `Event.routingRecommendation`/`routingConfidence`/`routingSignals` persisted, `status == AWAITING_ROUTING_APPROVAL`, exactly one `NotificationLog` `event.routing_ready` row; `routingDecision`/`DecidedBy`/`DecidedAt` remain **null** |
| Canonical run idempotency | Run `routing.finalize` twice → fields identical, status unchanged, **no** duplicate notification (dedupe) |
| Canonical run skips already-decided | Event already `MANUAL_ROUTED` → `routing.finalize` no-ops (no field/status change) |
| **Approve AI persists + audits** | `AWAITING_ROUTING_APPROVAL` (rec=AI) → approve → `status=AI_ROUTED`, `routingDecision=AI`, `DecidedBy`/`DecidedAt` set, **one** `AuditLog` `routing.approved` with correct metadata |
| **Switch to Manual persists + audits** | `AWAITING_ROUTING_APPROVAL` (rec=AI) → switch → `status=MANUAL_ROUTED`, `routingDecision=MANUAL`, one `AuditLog` `routing.switched` (override numerator) |
| Approve when recommendation is MANUAL | rec=MANUAL → "Approve" → `MANUAL_ROUTED`, audit `routing.approved` (chosen matches rec) |
| Off-gate override | `ACTIVE` event → trigger-manual override → `MANUAL_ROUTED`, audit `routing.manual_override`, recommendation may be null |
| Atomicity | Force the audit insert to fail → the status/decision update is rolled back (no decision without an audit row) |
| Non-admin blocked | Non-admin session → FORBIDDEN; no read/write; nothing in `AuditLog` |
| Race / already-decided | Two approvals on the same event → first wins; second returns `ROUTING_ALREADY_DECIDED`; one decision, one audit row |
| Live preview compute-only | `ACTIVE` event → admin detail recompute returns a `RoutingResult`; assert **no** `Event.routing*` write and status unchanged |

### 9.3 Notes

- The analyzer is tested as a pure function fed feature/Signal fixtures; the canonical-run worker
  test exercises the DB persist + status flip + notification (mocking the `Channel` send, asserting
  the `NotificationLog` row), reusing the Story 18 dispatcher test seam.
- CI: unit always; integration via the existing Redis service (Story 1) + test DB; else
  `SKIP_INTEGRATION=true`.

---

## 10. Security & Surprise Integrity

| Concern | Control |
|---|---|
| Admin-only decisions | Both approval actions + the override assert authenticated `role == ADMIN` (+ allowlisted domain) **server-side** before any read/write (Story 7 guard). UI gating is not relied upon (E2) |
| No auto-routing | The system **never** sets `AI_ROUTED` / `MANUAL_ROUTED` without a human action. The canonical run only reaches `AWAITING_ROUTING_APPROVAL`; the terminal routing states require the gate. This is the core control — enforced by the status machine (§6.2) and the action authz |
| Actor not spoofable | `routingDecidedBy` + `AuditLog.actorId` come from the **session**, never client input; the chosen direction is encoded in **which action** is called, not a tamperable param (§5.6) |
| Audit of every decision | Every routing decision (recommendation + chosen + signals shown) writes an immutable `AuditLog` row in the **same transaction** as the status change — no unaudited routing. Append-only (Story 8 §6.1) |
| No honoree exposure | The analyzer reads counts/metadata only; it sends **no** contributor/honoree communication. The single notification (`event.routing_ready`) goes to the **admin** and routes through the dispatcher so the honoree-suppression filter (`architecture.md` §10.1) still applies. The approval card is admin-only and shows honoree **name** (admin is an internal operator, §requirements §5.5) but never a honoree contact. No bytes/URLs/PII in worker logs |
| Input handling | Signal `message` strings are system-generated from counts (no user free-text injected); rendered as text. The persisted `routingSignals` JSON is system-produced |
| CSRF | Next.js Server Actions are origin-checked by the framework |
| Least privilege | Admins are global routers; no per-event ownership escalation introduced |
| Surprise integrity of downstream | Nothing downstream (no Claude Opus spend, no editor brief, no encoder jobs) runs until the gate — preventing accidental honoree-visible artifacts before a human signs off (`architecture.md` §6.4 "no surprise charges … no editor brief built") |

---

## 11. Observability / Audit

### 11.1 `AuditLog` action names (this story)

| Trigger | `AuditLog.action` | `actorId` |
|---|---|---|
| Approve the recommended path | `routing.approved` | admin id |
| Choose against the recommendation (Switch) | `routing.switched` | admin id |
| Off-gate "Trigger Manual Workflow" | `routing.manual_override` | admin id |
| (optional) System canonical run finalized | `routing.analyzed` | `null` (system) — §13 Q19 |

These follow the dotted convention (`architecture.md` §7.1 lists `routing.override`; §6.4 uses
`routing.approved` / `routing.switched`). **[CONFIRM]** the exact override action name vs the
architecture's `routing.override` — §13 Q22.

### 11.2 `AuditLog.metadata` shape (matches `architecture.md` §6.4)

```
{
  recommendation: 'AI' | 'MANUAL' | null,   // analyzer's verdict at decision time (null for an off-gate override before the canonical run)
  confidence: number | null,                // 0..1
  chosen: 'AI' | 'MANUAL',                   // the admin's choice
  signalsShown: Signal[],                    // the supporting+opposing the admin saw (from Event.routingSignals)
  override: boolean,                         // true when chosen != recommendation, OR the off-gate override
  rulesetVersion: string,
  timestamp: string (ISO)
}
```

`actorId` and `eventId` are first-class columns, not nested (Story 8 §11.2 convention). Honoree
name / contributor PII is **not** copied into metadata.

### 11.3 Override-rate metric (the key product signal)

`architecture.md` §6.4 / §13: the **override rate** = fraction of AI-recommended events the admin
switches to Manual. Derivable from `AuditLog`:

- Numerator: `routing.switched` rows where `metadata.recommendation == 'AI'` and `chosen ==
  'MANUAL'` (plus, optionally, off-gate `routing.manual_override` on AI-recommended events).
- Denominator: all decisions on AI-recommended events (`recommendation == 'AI'`).
- A sustained override rate above a threshold ("X%") means the rules/weights need tuning or events
  are genuinely harder than the analyzer thinks — the signal that triggers a `ROUTING_RULESET_VERSION`
  revision (§7.1).

Also track: **recommendation distribution** (AI vs MANUAL), **confidence distribution**, and
**time-to-decision** (`routingDecidedAt − routingSignals.computedAt`) as editorial-throughput
metrics. These are read-only aggregations over `Event` + `AuditLog`; no new metrics table.

### 11.4 Structured logs (Story 1 `logger`)

| Signal | Level | Fields |
|---|---|---|
| Canonical run finalized | info | `eventId`, `recommendation`, `confidence`, `triggeredSignalCount`, `rulesetVersion`, duration |
| Routing decision (approve/switch/override) | info | `eventId`, `actorId`, `recommendation`, `chosen`, `override` |
| Forbidden attempt (E2) | warn | `actorId?`, `eventId` |
| Invalid state / race (E3/E4) | debug | `eventId`, current `status`, attempted action |
| Canonical-run failure | error | full error; event stays `DEADLINE_PASSED` |

Trace correlation: include `event_id` as a span/log attribute so routing slots into the
submission → analysis → routing → (Story 13/16) trace (`architecture.md` §13).

---

## 12. Definition of Done

Story 12 is done only when all are true:

- [ ] `prisma/schema.prisma` has the six `Event` routing fields (§6.1), the `RoutingDecision` enum,
      and the three `EventStatus` values; migration `add_event_routing_fields` created and applied
      to `swara_dev`, applied to `swara_test` in CI and `swara_prd` on deploy; `prisma generate` run.
- [ ] A pure `analyzeEvent(eventWithSubmissions) → RoutingResult` exists implementing **all ten**
      §5.6 signals with the exact triggers, directions, and (versioned) weights; returns
      recommendation + confidence + supporting/opposing split; sub-second; no network/LLM/DB call.
- [ ] The analyzer re-runs as a **live preview** (compute-only, recommended on-view recompute);
      the admin detail shows a non-actionable trending recommendation pre-gate.
- [ ] The **canonical deadline run** (chained off the Story 18 `DEADLINE_PASSED` flow) persists
      `routingRecommendation`/`routingConfidence`/`routingSignals`, flips status to
      `AWAITING_ROUTING_APPROVAL` in one transaction, and fires exactly one `event.routing_ready`
      admin notification (deduped); it is idempotent and skips already-decided events.
- [ ] The **approval card** renders on `/admin/events/[id]` only at `AWAITING_ROUTING_APPROVAL`,
      showing recommendation + confidence%, "Why this fits" supporting signals, "Why the other
      might be better" opposing signals, and the two action buttons + attribution line.
- [ ] **Approve AI → `AI_ROUTED`**, **Switch to Manual → `MANUAL_ROUTED`**, each writing
      `routingDecision`/`routingDecidedBy`/`routingDecidedAt` + one `AuditLog` row
      (`routing.approved` / `routing.switched`) in one transaction; admin-only; idempotent; race
      returns `ROUTING_ALREADY_DECIDED`.
- [ ] A **"Trigger Manual Workflow" override** is available outside the gate, audited as
      `routing.manual_override`.
- [ ] **Nothing downstream is enqueued** by this story; the status is the only handoff seam for
      Stories 13/16.
- [ ] All error cases (§5.7) handled with calm admin-facing copy (§4.7).
- [ ] Weights/threshold/confidence live in a versioned in-code module recorded with each result;
      no `process.env` outside `src/config/`.
- [ ] Seed produces events exercising each signal, both recommendations, and a renderable
      `AWAITING_ROUTING_APPROVAL` card; seed idempotent; no `AuditLog` rows seeded.
- [ ] Unit tests (each signal, scoring, threshold, confidence, partition, eligibility, authz,
      transitions, audit mapping/shape) pass; integration tests (canonical run persist+flip+notify,
      idempotency, approve/switch/override + audit, atomicity, non-admin, race, live-preview
      compute-only) pass and honor `SKIP_INTEGRATION`.
- [ ] Accessibility (§4.8): real buttons with accessible names, color-independent
      recommendation/status, `aria-live` announcements, keyboard operability.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; deploy succeeds.
- [ ] No TODO comments left in committed code; `docs/stories.md` Story 12 row marked done.

---

## 13. Open Questions / Assumptions

| # | Question / Assumption | This doc's default / proposal | Needs |
|---|---|---|---|
| Q1 | **Story 11 analysis-complete hook** name/shape (the live-preview trigger) | Hook at the tail of Story 11's per-submission `analysis` job (the DAG "score complexity" step); but the live preview can be on-view recompute (Q16), needing no Story 11 side effect | **[CONFIRM]** reconcile with Story 11 design |
| Q2 | **Canonical-run trigger if Story 18 absent** | Chain off Story 18's `DEADLINE_PASSED` flip (preferred). If Story 18 hasn't landed, Story 12 needs its own deadline detector | **[CONFIRM]** sequencing |
| Q3 | **Button labels when recommendation is MANUAL** | Approve Manual Routing (primary) + Switch to AI (secondary), mirroring the AI-recommended layout | **[CONFIRM]** |
| Q4 | **Opposing-signals heading copy** (relative to recommendation) | "Why a human editor might be better" (AI rec) / "Why AI might be enough" (MANUAL rec) | **[CONFIRM]** |
| Q5 | **Empty opposing set** — show header with a calm "no counter-signals" line vs hide | Show it (reinforces the bias-guard) | **[CONFIRM]** |
| Q6 | **Allowed-from set for the off-gate override** | `ACTIVE` / `DEADLINE_PASSED` / `AWAITING_ROUTING_APPROVAL` | **[CONFIRM]** |
| Q7 | **Routing section in DRAFT/pre-collection** | Muted "analysis begins once collection starts" or render nothing | **[CONFIRM]** |
| Q8 | **Confirm step on both actions vs only Switch** | Confirm on both (both start downstream work) | **[CONFIRM]** |
| Q9 | **Submission eligibility** — APPROVED only vs APPROVED∪PENDING (must match Story 8 §13 Q4) | APPROVED∪PENDING; exclude REJECTED | **[CONFIRM]** consistently across 8/12/13/16 |
| Q10 | **Square video orientation** (`width==height`) | Exclude from the portrait/landscape mix decision (neither bucket) | **[CONFIRM]** |
| Q11 | **Empty event default** (0 eligible submissions/media at deadline) | Recommendation MANUAL, low confidence, all signals untriggered (human-in-loop safe) | **[CONFIRM]** |
| Q12 | **Exact signal weights** (S1–S10) | The §5.3 proposed weights; tune in prod from override rate | **[CONFIRM]** + production tuning |
| Q13 | **Does text-only count toward "3+ media types" (S6)?** | Count text as a type for the mixed-media signal (text+video+photo = 3) | **[CONFIRM]** |
| Q14 | **`AI_THRESHOLD`** (on `aiShare`) | 0.55 (biases near-ties to MANUAL / human-in-loop) | **[CONFIRM]** + production tuning |
| Q15 | **Confidence formula** | `\|aiShare − 0.5\| × 2`, clamped `[0,1]` | **[CONFIRM]** |
| Q16 | **How the live preview reaches the admin UI** | On-view recompute in the server component (no extra column/job); revisit with a cached column if a live-updating trend is needed | **[CONFIRM]** |
| Q17 | **Queue for the `routing.finalize` job** | Reuse `analysis` (or a dedicated `routing` queue); event-level, sub-second | **[CONFIRM]** |
| Q18 | **Allowed-from status for the canonical run** | `DEADLINE_PASSED` (run); `AWAITING_ROUTING_APPROVAL`/decided → no-op | **[CONFIRM]** |
| Q19 | **System `routing.analyzed` audit row on the canonical run** | Yes — record the analyzer output as of the deadline (distinct from the human decision) | **[CONFIRM]** |
| Q20 | **Merge the Story 18 "ready for review" alert with `event.routing_ready`** | Keep distinct (collection-closed vs decision-waiting) | **[CONFIRM]** |
| Q21 | **Where the downstream enqueue is added** | In the approve/switch action **after commit**, when Stories 16/13 land (the handoff point); none in Story 12 | **[CONFIRM]** at 13/16 |
| Q22 | **Off-gate override action name** — `routing.manual_override` vs architecture's `routing.override` vs folding into `routing.switched` | `routing.manual_override` (distinct, off-gate) | **[CONFIRM]** reconcile with §7.1 `routing.override` |
| Q23 | **`requirements` `{name,value,impact,message}` vs `architecture` `Signal`** | Adopt the architecture `Signal` shape as canonical; `impact = direction`, `value` = optional raw measurement | **[CONFIRM]** |
| Q24 | **`routingDecidedBy` FK to `User` or plain string** | Plain `String?` (mirrors `AuditLog.actorId`; survives user deletion) | **[CONFIRM]** |
| Q25 | **Persist untriggered signals in `routingSignals`** | No — persist only triggered supporting/opposing + ruleset version (recompute possible) | **[CONFIRM]** |
| Q26 | **`@@index([status])` on `Event`** | Defer (reuse `@@index([status, submissionDeadline])`) | Defer |
| Q27 | **Seed pre-persists canonical result vs dev runs `routing.finalize`** | Seed pre-persists at least one `AWAITING_ROUTING_APPROVAL` event so the card renders without a worker run | **[CONFIRM]** |
| Q28 | **Schema not yet on `main`** (only `User` exists) | Assume Stories 3/5/6/7/8/9/11/18 land their models/enums/infra before this migration | **[CONFIRM]** — those must merge first |
