# Sequence 10 / Story 13 — Manual Workflow: Brief ZIP + Editor Assignment

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (the assignment action; the streaming brief-ZIP contents + multipart-to-S3 assembly;
the editor JWT claim shape, signing, verification, and expiry; the editor email template; the
queues/jobs; status transitions; error cases incl. no-approved-media) so a later code-generation
step implements exactly this and nothing more. Where a value is a proposal awaiting confirmation
it is flagged **[CONFIRM]**; genuine ambiguities are listed in §13, not silently chosen. **No code
appears in this document.**

| Field | Value |
|---|---|
| Story number / title | Story 13 — Manual workflow: brief ZIP + editor assignment |
| Epic | G — Manual Path |
| Sequence number | 10 (this is the 10th design in build order) |
| Depends on | Story 12 (Routing analyzer + admin approval gate — fires only after `MANUAL_ROUTED`; the off-gate "Trigger Manual Workflow" override is also a Story 12 entry point) |
| Parallel with | Story 16 (AI storyboard + narration script — designed in parallel; its `AiArtifact` outputs are the brief's AI inputs and may be **absent** when this story runs — §5.4) |
| Also assumes on `main` | Story 1 (config `src/config/env.ts` + `src/config/index.ts`, `db`, `redis`, `logger`, worker scaffold, CI, `SKIP_INTEGRATION`, `@/` alias, ESLint ban on `process.env` outside `src/config/env.ts`, brand tokens), Story 3 (`Event` + `OccasionType`/`EventStatus`/`PaymentStatus`; `eventDate`/`deliveryDate`/`theme`/`musicMood`), Story 5 (`Submission` + `SubmissionStatus`, `consentGiven`/`consentAt`), Story 6 (`MediaItem` + `MediaType`, the **storage service** + key helpers + `S3_*` config), Story 7 (admin auth gate `requireAdmin` + `/admin/events/[id]` detail layout), Story 8 (`AuditLog` + audit-in-transaction pattern; `APPROVED` is the inclusion gate), Story 9 (BullMQ **queue registry + `enqueue` helper + idempotency `jobId` convention** + a worker `getObjectStream`/`downloadToFile` read path), Story 12 (`MANUAL_ROUTED` status + `Event.routingDecision`; the approve/switch action's after-commit handoff seam where this story's enqueue is added), Story 18 (the **`Channel` interface + shared notification dispatcher + `NotificationLog` dedupe**, Resend prod / Mailpit dev) |
| Unlocks | Story 14 (editor upload-back + admin review — consumes the `upload` JWT, `EditorAssignment`, and the upload link this story emails), Story 15 (delivery, downstream of 14) |
| Complexity | L (3–5 days) |

> **Sources of truth honored:** `docs/requirements.md` §5.7 (manual editing workflow: admin
> triggers; system prepares the editor brief = approved media organized by contributor/type + AI
> storyboard + narration script + subtitles + event metadata + metadata CSV; admin assigns from
> the internal pool [primary] or external email [fallback]; secure time-limited download link +
> deadline; **editors have no portal login — secure email links only**; upload links expire after
> delivery date + 7d), §5.5 (export package contents; editor assignment panel; "Trigger Manual
> Workflow" override; the admin status field incl. `Editor Assigned`/`Editing In Progress`), §2
> (Video Editor role), §6 (Editor Assignment logical model), §8 (consent records exportable for
> compliance). `docs/architecture.md` §6.5 (create `EditorAssignment` status `ASSIGNED`; enqueue
> the **streaming multipart** brief ZIP to S3 — never hold the large ZIP in memory; email the
> editor with brief-download + upload links; the `{kind, event_id, assignment_id, exp, iat}` JWT
> signed with `EDITOR_TOKEN_SECRET`, verified on `/editor-portal/*`), §7.1 (`EditorAssignment`
> model + `AssignmentStatus` enum), §7.2 (storage layout `editor-brief/brief_{assignment_id}.zip`),
> §8.1 (queue `brief_zip` concurrency 2, Normal), §8.2 (idempotency contract), §10.4 (editor token
> security — HMAC JWT, `exp = delivery_date + 7d`, verify every request, 410 on expiry, IP/UA
> logging), §10.1/§10.2 (surprise integrity + the editor's "signed JWT in URL, no session" auth
> row), §14 (`EDITOR_TOKEN_SECRET`, `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS=7`, `RESEND_*`). Also:
> `docs/branding.md` (editor email voice — warm, calm, no exclamation marks, "by Swara Media"
> footer), `docs/stories.md`, `docs/stories/story-01-foundation.md` (doc + config style),
> `CLAUDE.md`, `prisma/schema.prisma` (current: `User` + `Role`), and the sibling designs
> `seq09-story12-routing-analyzer-approval.md` (the `MANUAL_ROUTED` trigger + after-commit handoff
> seam), `seq06-story08-submission-approval.md` (`APPROVED` inclusion gate + audit substrate +
> transaction pattern), `seq06-story09-workers-quality-scoring.md` (the BullMQ queue/idempotency
> pattern reused here), `seq06-story18-reminder-automation.md` (the `Channel`/dispatcher +
> `NotificationLog` dedupe + email-template inventory pattern).

> **Note on parallel stories.** Story 16 (AI storyboard/narration/subtitles) is being designed in
> parallel. This story **designs for** its `AiArtifact` outputs (`storyboardJson`,
> `narrationScript`, `introText`/`outroText`, subtitles in `artifacts/`) being present and folds
> them into the brief, but it **tolerates their absence** (a `MANUAL_ROUTED` event may be routed to
> a human precisely because AI generation was skipped, or because the admin overrode before any AI
> ran). The brief manifest records which AI artifacts were included vs. absent (§5.3.3). Flagged
> §13 Q1. Story 14 owns the *upload-back* path — this story only **mints and emails** the `upload`
> JWT and leaves the `EditorAssignment` ready to receive it.

---

## 1. Story Summary

By the end of Story 12 an admin can route an event to a human editor: the status becomes
`MANUAL_ROUTED` (via the approval gate's "Switch to Manual" or the off-gate "Trigger Manual
Workflow" override), `Event.routingDecision = MANUAL`, with an audit row. Story 12 explicitly
enqueues **nothing** downstream — it leaves the *handoff seam* for this story.

Story 13 builds the manual handoff (`architecture.md` §6.5, `requirements.md` §5.7):

1. **An editor-assignment action + panel** on `/admin/events/[id]`. After an event is
   `MANUAL_ROUTED`, the admin picks an editor — from Swara Magical's **internal editor pool**
   (primary flow) or by **external email** (fallback for overflow/specialty) — sets/confirms the
   deadline, and triggers the workflow. This creates an `EditorAssignment` (status `ASSIGNED`),
   computes `briefExpiresAt` / `uploadExpiresAt` = `deliveryDate + buffer days`, flips the event to
   `EDITOR_ASSIGNED`, and writes an audit row.

2. **A streaming brief-ZIP assembly job** (`brief_zip` queue, concurrency 2). A worker assembles
   the editor brief and uploads it **streamed, multipart, directly to S3** at
   `editor-brief/brief_{assignment_id}.zip` — **never holding the whole ZIP (potentially multiple
   GB of approved video) in memory** (`architecture.md` §6.5, §12). The brief contains: approved
   media organized by contributor/type, the AI storyboard, the narration script, intro/outro text,
   subtitle files, event metadata, and a metadata CSV (contributor names, relationships, **consent
   records** for compliance — `requirements.md` §5.5/§8). On success it writes
   `EditorAssignment.briefPackagePath`.

3. **An editor-email job.** Once the brief is built, mint two HMAC-signed JWTs — `kind: "brief"`
   (download) and `kind: "upload"` — both `{kind, event_id, assignment_id, exp = deliveryDate + 7d,
   iat}` signed with `EDITOR_TOKEN_SECRET` (`architecture.md` §6.5, §10.4). Send the editor (via
   the Story 18 `Channel`/dispatcher, Resend) an assignment email carrying a **secure
   time-limited brief-download link**, the **upload link** (for Story 14), the **deadline**, and a
   short **brief summary**. The links resolve under `/editor-portal/*`, which verifies the JWT on
   **every** request (Story 14 builds the actual portal pages; this story defines the token contract
   they enforce).

**Editors have no portal login.** Every editor interaction is a signed-JWT-in-URL link
(`architecture.md` §10.2, `requirements.md` §5.7/§9). This story owns the **trigger → assignment →
streaming brief ZIP → editor email** slice. It does **not** build the editor upload-back page or
the admin review of the uploaded video (Story 14), nor does it generate the AI storyboard/script
(Story 16) — it only packages whatever AI artifacts exist.

### Success criteria

- [ ] On a `MANUAL_ROUTED` event, an admin-only **assign-editor action** creates an
      `EditorAssignment` (status `ASSIGNED`) with `editorName`/`editorEmail` (from pool or external
      email), `briefExpiresAt` = `uploadExpiresAt` = `deliveryDate + EDITOR_TOKEN_EXPIRY_BUFFER_DAYS`,
      flips `Event.status` → `EDITOR_ASSIGNED`, and writes one `AuditLog` row — all in one
      transaction; enqueues the brief job after commit.
- [ ] A `brief_zip` job (concurrency 2) assembles the brief and uploads it **streamed/multipart**
      to `editor-brief/brief_{assignment_id}.zip`, never buffering the full archive; on success it
      writes `EditorAssignment.briefPackagePath`. The ZIP contains approved media organized by
      contributor/type + AI storyboard + narration script + subtitles + event metadata + metadata
      CSV (with consent records), plus a manifest.
- [ ] After the brief is built, an editor-email job mints `brief` + `upload` JWTs (HMAC,
      `EDITOR_TOKEN_SECRET`, `exp = deliveryDate + 7d`, `iat`) and sends the editor a brand-voice
      email with the brief-download link, upload link, deadline, and brief summary — via the Story
      18 dispatcher; recorded in `NotificationLog`, deduped, honoree-suppression filter applied.
- [ ] `/editor-portal/*` requests verify the JWT every time (HMAC + `exp`); expired/invalid → 410
      Gone (the verification contract is owned here; the pages are Story 14).
- [ ] Schema gains the `EditorAssignment` model + `AssignmentStatus` enum + the `Event @unique`
      relation; migration is additive.
- [ ] Config adds `EDITOR_TOKEN_SECRET`, `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS` (default 7), and the
      brief/notification knobs in **both** `src/config/env.ts` and `src/config/index.ts`; no
      `process.env` outside `src/config/`.
- [ ] The "no approved media" case is handled (assignment not auto-progressed; admin alerted) —
      §5.7.
- [ ] Unit + integration tests (§9) pass; integration tests skip cleanly under `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green.

---

## 2. Scope

### In scope (this story)

- **The editor-assignment panel** on `/admin/events/[id]` (extends Story 7/12's detail), visible
  when `Event.status == MANUAL_ROUTED` (and a decided recap when later): pick **internal pool**
  editor (primary) or **external email** (fallback), set/confirm the **deadline**, trigger; show
  assignment status + brief-ready state; the "Trigger Manual Workflow" override (Story 12's button)
  is the entry that produces `MANUAL_ROUTED` — this story renders the panel that appears after it.
- **The assign-editor Server Action** (admin-only): create `EditorAssignment` (`ASSIGNED`), compute
  `briefExpiresAt`/`uploadExpiresAt`, flip `Event.status` → `EDITOR_ASSIGNED`, write `AuditLog`, all
  in one transaction; enqueue the `brief_zip` job after commit.
- **The `brief_zip` queue + job** (concurrency 2, Normal): **streaming/multipart** assembly of the
  brief ZIP to S3; write `briefPackagePath`; then enqueue the editor-email job.
- **The brief ZIP contents + manifest + metadata CSV** (with consent records), organized by
  contributor/type.
- **The editor-email job**: mint `brief` + `upload` JWTs (HMAC, `EDITOR_TOKEN_SECRET`, expiry =
  `deliveryDate + buffer`), send via the Story 18 `Channel`/dispatcher with the links + deadline +
  brief summary; `NotificationLog` record + dedupe + honoree filter.
- **The editor JWT contract**: claim shape, signing, verification (verify on every
  `/editor-portal/*` request), expiry, 410-on-expiry — and a reusable `signEditorToken` /
  `verifyEditorToken` utility (consumed by Story 14's pages and download/upload routes).
- **The `editor-brief/brief_{assignment_id}.zip` storage path** + a presigned-GET helper for the
  `brief` link's resolution (the download route may live here as a thin `/editor-portal/brief/...`
  resolver, or be deferred to Story 14 — §13 Q2).
- **Schema growth**: `EditorAssignment` model, `AssignmentStatus` enum, the `Event.editorAssignment`
  `@unique` relation, the `EDITOR_ASSIGNED`/`EDITING_IN_PROGRESS` `EventStatus` values (if not
  already present); additive migration.
- **Config**: `EDITOR_TOKEN_SECRET`, `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS`, brief/queue knobs,
  `RESEND_*` reuse — both config files.
- **Internal editor pool representation** — a simple `Editor` table (recommended) or a config list
  (§6.3).
- **Audit**: `assignment.created` (+ optionally `assignment.brief_ready`, `assignment.emailed`).
- **Seed**: editor-pool entries; a `MANUAL_ROUTED` event with approved submissions + AI artifacts;
  an `EditorAssignment`.
- **Tests**: unit (JWT sign/verify/expiry, brief manifest, metadata CSV shape, status transitions)
  + integration (trigger → assignment + ZIP to MinIO + email mocked), `SKIP_INTEGRATION`.

### Out of scope (deferred — with owners)

| Deferred item | Owner / where | Note |
|---|---|---|
| **Editor upload-back** (token-gated `/editor-portal/upload` page, MP4 validation, `EditorAssignment.finalVideoPath`/`uploadedAt`, status → `UPLOADED`) | **Story 14** | This story mints + emails the `upload` JWT and leaves the assignment ready; the page is Story 14 |
| **Admin review of the uploaded video** (approve → delivery / request revision → `REVISION_REQUESTED`, `adminFeedback`) | **Story 14** | The `APPROVED`/`REVISION_REQUESTED` assignment states exist in the enum but are **set by Story 14** |
| **AI storyboard / narration / intro-outro / subtitle generation** | **Story 16** | This story **consumes** `AiArtifact` outputs into the brief; it does not generate them; absence is tolerated (§5.4) |
| **Editor SLA dashboard + reassignment workflow** + the delivery_date−48h "no upload" alert | MVP 2 / observability (`architecture.md` §11.1, §18) | This story records `assignedAt`/expiry; the SLA computation/UI is later |
| **Editor compensation / billing** | Permanently out (`architecture.md` §15) | Paid offline; no Stripe Connect, no editor billing |
| **Final delivery** (share page, download link, organizer delivery email) | Story 15 | Downstream of Story 14 |
| **Token revocation UI** (admin "revoke this assignment's links") | MVP 2 (`architecture.md` §10.5 mentions "admin can revoke assignment") — flagged §13 Q12 | The schema/seam allows it; the UI is later |
| **The `Channel`/dispatcher/`NotificationLog` plumbing** | Story 18 | Reused; this story adds the **editor trigger + template**, not the dispatcher |

---

## 3. Dependencies & Sequence

### Must already be on `main`

- **Story 1 (Foundation):** typed `config` (`src/config/env.ts` + `src/config/index.ts`), Prisma
  singleton `src/lib/db.ts`, Redis singleton `src/lib/redis.ts`, `logger`, the worker entry
  `src/workers/index.ts`, CI, `SKIP_INTEGRATION`, `@/` alias, ESLint `no-restricted-syntax` ban on
  `process.env` outside `src/config/env.ts`, brand tokens.
- **Story 3 (Event creation):** `Event` model — esp. `deliveryDate: DateTime` (the expiry anchor),
  `eventDate`, `theme`, `musicMood`, `occasionType`, `honoreeName`, `slug`, `status: EventStatus`.
- **Story 5 (Contributor submission):** `Submission` model — `contributorName`, `relationship`,
  `email?`, the text fields, `consentGiven`/`consentAt`, `status: SubmissionStatus`.
- **Story 6 (Media uploads):** `MediaItem` model + `MediaType` enum, the **storage service**
  (key helpers + read access), `S3_*` config. This story needs a worker **read/stream**
  (`getObjectStream(key)` / `downloadToFile`) and a **multipart upload** capability on the storage
  service (§5.3.4, §7.3) — add if Story 6/9 didn't expose them.
- **Story 7 (Admin dashboard read-only):** the admin auth guard (`requireAdmin`, Google OAuth,
  `ADMIN_EMAIL_DOMAINS`, `role=ADMIN`) and the `/admin/events/[id]` detail layout the panel slots
  into.
- **Story 8 (Submission approval):** the **`AuditLog`** model + audit-in-transaction pattern, and
  the decision that **`APPROVED` is the inclusion gate** for the brief (Story 8 §13 Q4 — only
  `APPROVED` media/submissions go in the package; reconcile consistently — §13 Q3).
- **Story 9 (Workers + quality):** the **queue registry + `enqueue` helper + idempotency `jobId`
  convention** + the worker process bootstrap; the worker S3 read path. This story adds the
  `brief_zip` processor (and an editor-email job) following that pattern verbatim.
- **Story 12 (Routing):** the `MANUAL_ROUTED` status + `Event.routingDecision = MANUAL`, and the
  **after-commit handoff seam** in the approve/switch/override actions. Story 12 §5.6 step 6 / §13
  Q21 say the downstream enqueue is added *there* when this story lands. **Decision for this story:**
  routing to manual does **not** auto-assign an editor — assignment is a **separate, explicit admin
  action** (the admin chooses the editor + deadline). So Story 12's after-commit seam enqueues
  **nothing** for the manual path; the panel appears at `MANUAL_ROUTED` and the admin acts. (This
  keeps editor choice human, matching `requirements.md` §5.7 step 3.) Flagged §13 Q4.
- **Story 18 (Reminders):** the **`Channel` interface + dispatcher + `NotificationLog` dedupe** and
  the Resend/Mailpit `EmailChannel`. This story adds the **editor** `recipientType`, the editor
  triggers, and the editor template — not new plumbing.

> **Dependency flags.**
> 1. The live `prisma/schema.prisma` has only `User` + `Role`. This design assumes Stories
>    3/5/6/7/8/9/12/18 land `Event`, `Submission`, `MediaItem`, `AuditLog`, `NotificationLog`, the
>    queue infra, and the enums as in `architecture.md` §7.1/§8 before this migration. Reconcile §6
>    against the merged schema before migrating. (§13 Q15.)
> 2. **Story 16 may be absent** when this runs: the brief must build with **no** `AiArtifact`
>    (storyboard/script/subtitles omitted, manifest notes them absent). §5.4 / §13 Q1.
> 3. The storage service may need a **multipart-upload** method and a **stream-download** method
>    added (§7.3) if Story 6/9 only exposed presign/head/get. Flagged §13 Q6.

### Provides to later stories

- The **`EditorAssignment`** row + its `brief`/`upload` JWTs + `briefPackagePath` are Story 14's
  inputs (the upload page verifies the `upload` JWT against the assignment; admin review reads/sets
  `finalVideoPath`/`uploadedAt`/`status`/`adminFeedback`).
- The **`signEditorToken` / `verifyEditorToken`** utility + the `/editor-portal/*` verification
  contract (verify-every-request, 410-on-expiry) are reused by every Story 14/15 editor-facing
  route.
- The **`AssignmentStatus`** lifecycle (`ASSIGNED → IN_PROGRESS → UPLOADED → APPROVED |
  REVISION_REQUESTED`) is the manual-path state machine Story 14 advances.

### Sequence within this story

```
1. Schema: EditorAssignment model + AssignmentStatus enum + Event @unique relation + EventStatus values
   → verify: prisma migrate runs; generate clean
2. Config: EDITOR_TOKEN_SECRET, EDITOR_TOKEN_EXPIRY_BUFFER_DAYS, brief/queue knobs in env.ts + index.ts
   → verify: config parses; Zod requires the secret in prod
3. JWT util: signEditorToken / verifyEditorToken (HMAC, claims, exp, 410 contract)
   → verify: unit — sign→verify round-trip; expired→reject; tampered→reject; wrong kind→reject
4. Editor pool: Editor table (or config list) + a resolver (poolId | externalEmail → {name,email})
   → verify: unit — resolves both modes; validates email
5. Assign-editor action: create EditorAssignment + compute expiries + flip status + audit (txn); enqueue brief_zip
   → verify: unit (authz, transition, expiry math, audit) + integration (row + status + job)
6. brief_zip job: streaming/multipart ZIP assembly → S3; manifest + metadata CSV; write briefPackagePath; enqueue email
   → verify: integration (MinIO) — ZIP present, openable, contains expected entries; no-approved-media path
7. editor-email job: mint brief+upload JWTs; send via dispatcher; NotificationLog + dedupe + honoree filter
   → verify: unit (template render, links carry JWTs) + integration (email captured, one log row)
8. Editor-assignment panel UI on /admin/events/[id]: pool/external select, deadline, trigger; states
   → verify: render states (manual-routed, assigned, brief-building, brief-ready, error)
9. Seed: editor pool + a MANUAL_ROUTED event w/ approved media + artifacts + an assignment
   → verify: panel renders; worker run produces a ZIP locally
10. Tests + DoD → verify: lint/typecheck/test green
```

---

## 4. Frontend / UI Design

All copy honors `branding.md` §3/§10: **warm, confident, clear**; **no exclamation marks** in this
operational surface; honoree name **spelled exactly as entered**; occasion-aware nouns; title case
for headings, sentence case for buttons/labels; Lucide outline icons (20px); palette tokens from
`globals.css`. The signature gradient/gold is **not** used here (reserved for delivery). This is an
**admin-only, authenticated** surface (Story 7 gate); it is never honoree-facing. The **editor
email** (§5.6) is the only editor-facing artifact; the editor portal pages are Story 14.

### 4.1 Where it lives

A new **Editor assignment** section on `/admin/events/[id]` (extends Story 7/12's detail), rendered
**below** Story 12's routing recap. It is the panel `requirements.md` §5.5 calls the "editor
assignment panel" and §5.7 step 3 describes. It renders **one of several states** keyed on
`Event.status` + the presence/`status` of `EditorAssignment` (§4.5).

### 4.2 The assignment panel (status `MANUAL_ROUTED`, no assignment yet)

| Element | Content / behavior |
|---|---|
| Section heading | "Assign a video editor" + an event identity line ("{honoreeName}'s {occasion} — routed to a human editor by {admin} on {date}", from Story 12's recap) |
| Editor source toggle | Two modes: **"From editor pool"** (primary, default) and **"External editor (by email)"** (fallback). `requirements.md` §5.7 step 3 — pool is the primary flow |
| Pool select | When "From editor pool": a select of internal `Editor` rows (name + email + optional specialty/availability badge). One required. **[CONFIRM]** show availability/specialty — §13 Q7 |
| External email + name | When "External editor": an email input (validated) + a name input. The fallback path |
| Deadline field | A date(-time) field for the editor's deadline, **pre-filled** from `Event.deliveryDate` (the SLA anchor), editable to set an earlier internal deadline. Display the computed **link expiry** ("Secure links expire {deliveryDate + 7 days}") as read-only context so the admin understands access is tied to delivery + buffer, not this field. **[CONFIRM]** whether the deadline field is the editor's *work* deadline only (display) vs. also feeding expiry — expiry is **always** `deliveryDate + buffer` per §10.4, independent of this field — §13 Q8 |
| Trigger button | "Assign editor and prepare brief" (primary, `--brand-deep-saffron`). On click → confirm step (§4.6) → the action (§5.5) |
| Note (read-only) | "The editor receives a secure download link and an upload link by email. Editors do not sign in." (sets expectations; surprise-safe — never offers to contact the honoree) |

### 4.3 Assigned / brief states (an `EditorAssignment` exists)

Once assigned, the panel shows the assignment + brief progress (it does **not** offer to re-assign
in MVP 1 — reassignment is MVP 2, §13 Q12):

| Sub-state | Source | UI |
|---|---|---|
| Assigned, brief building | `status=ASSIGNED`, `briefPackagePath == null` | "Editor: {name} ({email}). Preparing the brief package…" with a subtle spinner; deadline + link-expiry shown |
| Assigned, brief ready, email pending/sent | `status=ASSIGNED`, `briefPackagePath != null` | "Brief package ready. Assignment email sent to {email}." + a `NotificationLog`-derived "emailed {time}" line (read-only). Optionally an admin **"Download brief"** link (presigned GET, admin-only) to inspect what the editor received — **[CONFIRM]** include admin download — §13 Q9 |
| In progress | `status=IN_PROGRESS` (set by Story 14 on first portal visit/upload start) | "Editor is working. Deadline {date}." |
| Uploaded / approved / revision | `UPLOADED` / `APPROVED` / `REVISION_REQUESTED` (Story 14) | Read-only recap; the review controls are Story 14's |
| Brief failed | brief job exhausted retries (§5.7) | Calm error: "Preparing the brief ran into a problem. {Retry} or check the logs." + an admin **Retry** control that re-enqueues the `brief_zip` job (idempotent) — **[CONFIRM]** retry control vs auto-retry-only — §13 Q10 |

### 4.4 The "Trigger Manual Workflow" override (Story 12) → this panel

Per `requirements.md` §5.5, "Trigger Manual Workflow" is available as an override at any time. That
**button lives in Story 12's routing section** (Story 12 §4.4) and produces `MANUAL_ROUTED`. This
story's contribution is that **once the event is `MANUAL_ROUTED` (by gate or override), the editor
assignment panel (§4.2) appears**. There is no separate trigger in this story beyond the
"Assign editor and prepare brief" action — assignment is the explicit step (§3 dependency note,
§13 Q4).

### 4.5 States (keyed on `Event.status` + `EditorAssignment`)

| Condition | Panel renders |
|---|---|
| `status ∉ {MANUAL_ROUTED, EDITOR_ASSIGNED, EDITING_IN_PROGRESS, FINAL_VIDEO_UPLOADED, …}` | Nothing (the manual panel is irrelevant for AI-routed / pre-routing events) |
| `MANUAL_ROUTED`, no `EditorAssignment` | The assignment panel (§4.2) — pick editor, set deadline, trigger |
| `EDITOR_ASSIGNED`, assignment `ASSIGNED` | Assigned + brief-building / brief-ready (§4.3) |
| `EDITING_IN_PROGRESS` … later | Assignment recap (§4.3) — read-only here; review is Story 14 |

### 4.6 Interaction / optimistic + confirmation states

| State | Trigger | UI |
|---|---|---|
| Idle | `MANUAL_ROUTED`, no assignment | Source toggle + select/email + deadline + trigger enabled |
| Confirm | Click "Assign editor and prepare brief" | Lightweight inline confirm naming the consequence: "Assign {name} and email them the brief? They will receive secure links that expire {expiry}." Confirm / Cancel (consequential — it emails an external party) |
| Pending (optimistic) | Action submitted | Button disabled + spinner; panel optimistically shows "Assigned to {name} — preparing the brief…" |
| Success | Server confirms | Panel switches to the assigned/brief-building state (§4.3); calm inline note "Editor assigned."; page revalidates |
| Error | Server rejects (§5.8) | Optimistic state reverts; calm inline error (§4.7); inputs re-enabled; no partial state |

Optimistic update is purely visual; the **server is authoritative** (§5). The action revalidates
`/admin/events/[id]`.

### 4.7 Error copy (admin-facing, calm voice)

| Case | Message |
|---|---|
| Event not found / stale | "This event could not be found. Refresh and try again." |
| Forbidden (shouldn't reach UI) | "You don't have access to do that." |
| Wrong status (not manual-routed) | "This event isn't routed to a human editor yet." |
| Already assigned (race) | "An editor is already assigned to this event. Refreshing to show the current state." |
| No approved media | "There's no approved media to send yet. Approve at least one submission, then assign an editor." |
| Invalid editor selection | "Choose an editor from the pool, or enter a valid editor email." |
| Unexpected | "Something went wrong. Try again." |

### 4.8 Accessibility & branding

- Real `<button>`s and `<select>`/`<input>`s with discernible names ("Assign editor for
  {honoreeName}"); status is icon + text, not color-only.
- Action result announced via `aria-live="polite"`.
- Editor email/deadline inputs labeled; expiry context is text, not just a tooltip.
- Keyboard-operable end to end; visible focus; WCAG AA contrast.

---

## 5. Backend / Worker Design

The flow mirrors `architecture.md` §6.5: an admin **assign** action (web) creates the assignment +
flips status + audits in a transaction, then enqueues a **`brief_zip`** worker job that **streams**
the ZIP multipart to S3, which on success enqueues an **editor-email** job that mints the JWTs and
sends via the Story 18 dispatcher. Three idempotent units; the status + `briefPackagePath` are the
seams between them.

### 5.1 The assign-editor Server Action (the trigger)

An admin-only **Server Action** (App Router, consistent with Stories 8/12), invoked from the panel.

**Inputs (Zod-validated; actor derived server-side, never from the client):**

| Field | Type | Required | Notes |
|---|---|---|---|
| `eventId` | string (cuid) | yes | The `MANUAL_ROUTED` event |
| `editorSource` | enum `POOL` \| `EXTERNAL` | yes | Which assignment mode |
| `editorId` | string (cuid) | when `POOL` | An `Editor` row id (internal pool) |
| `externalEmail` | string (email) | when `EXTERNAL` | Normalized lowercase; the fallback path |
| `externalName` | string | when `EXTERNAL` | Display name for the email greeting |
| `deadline` | DateTime | yes (or default) | The editor's work deadline; defaults to `Event.deliveryDate` if omitted. **Does not** drive link expiry (§5.2) |

`editorName`/`editorEmail` are **resolved server-side** (from the `Editor` row for `POOL`; from
`externalName`/`externalEmail` for `EXTERNAL`) — the client never supplies the stored
`editorEmail` for a pool editor (prevents pointing a pool assignment at an arbitrary address).

**Algorithm (authoritative order):**

1. **AuthN/AuthZ.** Resolve session; require `role == ADMIN` (+ allowlisted domain, Story 7 guard).
   Else → **FORBIDDEN** (E2). Nothing read/written.
2. **Validate input** (§5.1 Zod). On failure → **INVALID_REQUEST** (E6). Nothing written.
3. **Load** the event by `eventId`. Not found → **EVENT_NOT_FOUND** (E1).
4. **Status check.** Require `Event.status == MANUAL_ROUTED`. Otherwise → **INVALID_ASSIGNMENT_STATE**
   (E3). (`AI_ROUTED`, pre-routing, or already-`EDITOR_ASSIGNED` are refused here.)
5. **Already-assigned guard.** Because `EditorAssignment.eventId` is `@unique` (§6.1), a second
   assign attempt would violate the constraint. Check first: if an `EditorAssignment` already exists
   for the event → **ALREADY_ASSIGNED** (E4) so the UI shows "already assigned" (§4.7). (Reassignment
   is MVP 2, §13 Q12.)
6. **Resolve the editor.** `POOL` → load the `Editor` by `editorId`; not found → **EDITOR_NOT_FOUND**
   (E7); use its `name`/`email`. `EXTERNAL` → use `externalName`/`externalEmail`.
7. **Approved-media precondition.** Count `APPROVED` submissions with ≥1 media item for the event
   (the brief's content). If **zero** → **NO_APPROVED_MEDIA** (E5): do **not** create the assignment;
   surface §4.7's "no approved media" copy. (A brief with no media is not worth sending; the admin
   must approve first.) **[CONFIRM]** whether to block creation, or create-but-don't-enqueue and let
   the admin approve then "Prepare brief" — §13 Q11. **Default: block creation.**
8. **Compute expiries.** `briefExpiresAt = uploadExpiresAt = Event.deliveryDate +
   EDITOR_TOKEN_EXPIRY_BUFFER_DAYS` (default 7) — `architecture.md` §10.4, `requirements.md` §5.7.
   Both equal (same expiry for both link kinds). Stored on the row and used as the JWT `exp`.
9. **Transaction (single DB transaction):**
   a. Insert `EditorAssignment`: `eventId`, `editorName`, `editorEmail`, `briefPackagePath = null`,
      `briefExpiresAt`, `uploadExpiresAt`, `status = ASSIGNED`, `assignedAt = now`. (`finalVideoPath`,
      `uploadedAt`, `editorNote`, `adminFeedback` null.) Persist the work `deadline` too if a column
      is added (§6.1 [CONFIRM]).
   b. `Event.status = EDITOR_ASSIGNED`.
   c. Insert one `AuditLog` row `assignment.created` (§11): `actorId` = session user id, `eventId`,
      `metadata = { assignmentId, editorSource, editorEmail (the recipient — admin-internal record),
      deadline, briefExpiresAt, approvedSubmissionCount }`.
   - Assignment insert + status flip + audit **succeed or fail together**.
10. **After commit:** `enqueue('brief_zip', 'brief.build', { eventId, assignmentId })` (idempotent
    jobId — §5.3.2). Enqueue happens **after** commit (never inside the txn) so a rolled-back
    assignment never produces a phantom job, and a Redis hiccup never rolls back a valid assignment
    (Story 9 §5.3 pattern). If enqueue fails (Redis down) → log + leave a recoverable state (the
    admin Retry control / a sweep can re-enqueue — §5.7, §13 Q10). Revalidate `/admin/events/[id]`.

### 5.2 Expiry & the "buffer days" anchor

- **Anchor:** `Event.deliveryDate` (the SLA the organizer paid against, `architecture.md` §1).
- **Buffer:** `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS` (config, default **7** — `architecture.md` §14,
  §10.4; `requirements.md` §5.7 "Upload links expire after delivery date + 7 days").
- **Both** `briefExpiresAt` and `uploadExpiresAt` = `deliveryDate + buffer` (one expiry for both
  link kinds). The JWT `exp` (§5.5.1) is set to the **same** instant, so the persisted column and
  the token agree (verification checks both — §10).
- The panel's editable **work deadline** (§4.2) is an *operational* date shown to the editor; it
  does **not** shorten the cryptographic expiry (the editor may legitimately upload up to
  `deliveryDate + buffer`). Flagged §13 Q8.

### 5.3 The `brief_zip` job — streaming multipart assembly

**Queue:** `brief_zip`, concurrency **2**, priority Normal (`architecture.md` §8.1). IO-heavy;
declared in the Story 9 registry; this story adds the **processor**.

#### 5.3.1 Job name & payload

| Job name (`job_type`) | Queue | Payload | Purpose |
|---|---|---|---|
| `brief.build` | `brief_zip` | `{ eventId, assignmentId }` | Assemble + upload the brief ZIP for one assignment |

Payload carries **only ids** (Story 9 §5.3 / `architecture.md` §8.2 — re-read authoritative rows at
run time; no blobs/URLs/secrets in payloads, which logs may capture).

#### 5.3.2 Idempotency key

Per Story 9's convention (`{event_id}:{submission_id}:{job_type}`), brief assembly is **event-level**
(no submission segment). Key: `{eventId}::brief.build:{assignmentId}` (the `assignmentId` segment
keeps it unique if an event were ever re-assigned in MVP 2). A single canonical `buildJobKey()`
produces it. BullMQ dedups in-flight by `jobId`; the **output-by-key overwrite** (the ZIP at the
deterministic S3 path + the `briefPackagePath` write) makes re-runs safe across retention windows.

#### 5.3.3 Processor flow

1. **Re-fetch** the `EditorAssignment` + `Event` + `APPROVED` submissions (with their `MediaItem`s,
   ordered by contributor) + the `AiArtifact` (may be null) (§5.4). If the assignment is gone
   (deleted between enqueue and run) → **no-op success**.
2. **No-approved-media re-check.** If there are zero approved media at run time → do **not** write a
   ZIP; mark the brief failed-soft and alert the admin (§5.7) (covers media being un-approved
   between assign and run). The assignment stays `ASSIGNED` with `briefPackagePath = null`.
3. **Open a streaming ZIP archiver** wired to a **multipart-upload sink** to S3 at
   `editor-brief/brief_{assignment_id}.zip` (§5.3.4). The archiver's output stream is the multipart
   upload's input — bytes flow archiver → S3 in chunks; the full archive is **never** held in
   memory (`architecture.md` §6.5, §12).
4. **Add entries** (§5.3.3 layout below). Each approved `MediaItem` is **streamed** from storage
   (`getObjectStream(storagePath)`) directly into the archive entry — media bytes flow
   storage → archiver → S3 without buffering whole files. AI artifacts and the generated CSV/manifest
   are small and added as in-memory buffers or short streams.
5. **Finalize** the archive; **complete** the multipart upload. On any error, **abort** the multipart
   upload (no orphan partial object) and throw (retry — §5.7).
6. **Write `EditorAssignment.briefPackagePath`** = the S3 key (output-by-key; deterministic) — the
   "brief ready" seam.
7. **Enqueue the editor-email job** (`enqueue('notifications', 'editor.assignment_email', {
   eventId, assignmentId })` — §5.6). After the path write, so the email never references a
   non-existent ZIP.
8. (Optional) write an `assignment.brief_ready` `AuditLog`/log line (§11, §13 Q13).

**Brief ZIP internal layout** (realizes `requirements.md` §5.5 export contents / §5.7 step 2 +
`architecture.md` §7.2 `artifacts/` + `editor-brief/`):

```
brief_{assignment_id}.zip
  README.txt                      # plain-text orientation: what this is, deadline, how to upload back
  manifest.json                   # machine-readable index (§5.3.3 manifest)
  metadata.csv                    # contributor names, relationships, consent records (§5.3.5)
  event/
    event.json                    # occasion, theme, music mood, event date, delivery date, honoree name
  media/
    {contributorSlug}/            # one folder per approved contributor (name + short id)
      video/   {originalName or media_id}.mp4|mov
      voice/   {...}.mp3|m4a
      photo/   {...}.jpg|png
  text/
    {contributorSlug}.txt|.md     # that contributor's text message / funny memory / advice / professional note
  ai/                             # PRESENT only if AiArtifact exists (§5.4)
    storyboard.json               # AiArtifact.storyboardJson
    narration-script.md           # AiArtifact.narrationScript
    intro-outro.txt               # AiArtifact.introText / outroText
  subtitles/                      # PRESENT only if subtitle artifacts exist
    {media_id}.srt
```

> Folder/file naming **[CONFIRM]** — §13 Q5. Contributor folders are organized **by contributor and
> then by media type** per `requirements.md` §5.5/§5.7 ("organized by contributor and type"). Use a
> stable, filesystem-safe `{contributorSlug}` (e.g. sanitized name + short submission id) to avoid
> collisions when two contributors share a name.

**`manifest.json`** (the brief's index — also the basis for the email's "brief summary" §5.6):

```
{
  assignmentId, eventId, honoreeName, occasionType,
  theme, musicMood, eventDate, deliveryDate, deadline,
  generatedAt,
  contributors: [ { contributorSlug, name, relationship, mediaCounts: {video, voice, photo}, hasText: bool } ],
  totals: { contributors, videos, voices, photos, textOnly },
  ai: { storyboardIncluded: bool, narrationScriptIncluded: bool, introOutroIncluded: bool, subtitleCount: int },
  consentNote: "All included contributors gave consent; see metadata.csv for records.",
  briefSchemaVersion: "v1"
}
```

#### 5.3.4 Streaming multipart upload (the load-bearing constraint)

`architecture.md` §6.5 / §12: "Brief assembly is streaming. The ZIP is built in chunks and uploaded
multipart to S3. Holding a 5GB ZIP in memory is not acceptable."

| Concern | Decision |
|---|---|
| Archive format | ZIP (per `architecture.md` §7.2 `.zip`). Use a **streaming** ZIP writer that emits a readable output stream as entries are appended (no full-archive buffering). **[CONFIRM]** library — §13 Q6 |
| Upload mechanism | **S3 multipart upload** (`CreateMultipartUpload` → `UploadPart×N` → `CompleteMultipartUpload`), fed from the archiver's output stream split into ≥5MB parts (S3 minimum part size, except the last). A managed multipart uploader (e.g. the AWS SDK's `Upload`/lib-storage) that consumes a stream and handles part sizing/concurrency is acceptable as long as it **streams** (does not buffer the whole body). |
| Media entries | Each approved media file is **streamed in** from storage (`getObjectStream`) — never downloaded whole to memory; a bounded temp-file spill is acceptable if a stream-through isn't feasible for the archiver, cleaned up in `finally`. **[CONFIRM]** stream-through vs temp-file spill — §13 Q6 |
| Failure | On any error mid-assembly → **abort** the multipart upload (no orphaned parts/partial object) and throw → retry (§5.7). The deterministic key means a retry overwrites cleanly. |
| Part-size / concurrency knobs | Config (§7.2): part size (default 8MB), upload concurrency (default 4). |
| Memory ceiling | The worker's resident set must not scale with archive size — only with the chosen part-buffer × concurrency. Documented as a §12-relevant invariant. |

#### 5.3.5 Metadata CSV (consent records — compliance)

`requirements.md` §5.5 ("Metadata CSV (contributor names, relationships, consent records)") + §8
("Consent records must be stored and exportable for compliance"). One row per **approved**
submission included in the brief:

| Column | Source | Notes |
|---|---|---|
| `contributor_name` | `Submission.contributorName` | exact, not auto-capitalized (branding §10) |
| `relationship` | `Submission.relationship` | occasion-aware label as stored |
| `email` | `Submission.email` | may be empty (optional field) |
| `consent_given` | `Submission.consentGiven` | always `true` for included rows (consent is mandatory to submit, `requirements.md` §5.2) — present for the record |
| `consent_at` | `Submission.consentAt` | ISO timestamp; the auditable consent record (`architecture.md` §7.1 "never null when consentGiven=true") |
| `submission_id` | `Submission.id` | join key |
| `media_video` / `media_voice` / `media_photo` | counts from `MediaItem` | per-type counts for the editor |
| `has_text` | derived | whether any text field is present |
| `quality_overall` | `Submission.overallQualityScore` | optional, for the editor's reference **[CONFIRM]** include — §13 Q14 |

CSV is RFC-4180 (quote fields containing commas/quotes/newlines), UTF-8 with header row. **[CONFIRM]**
exact columns/order — §13 Q14.

### 5.4 AI artifacts present vs absent (Story 16 parallel)

- When `AiArtifact` exists (Story 16 ran for this event before manual routing), include
  `storyboard.json`, `narration-script.md`, `intro-outro.txt`, and any `subtitles/*.srt` (from the
  `artifacts/` prefix, `architecture.md` §7.2). The manifest's `ai` block records `*Included: true`.
- When `AiArtifact` is **absent or partially populated** (a `MANUAL_ROUTED` event whose AI step was
  skipped, or the admin overrode to manual before any AI ran), **omit** the missing files and set
  the manifest `ai` flags `false`. The README notes "AI storyboard/script not generated for this
  event — please storyboard from the media and metadata." The brief **still builds and sends** —
  approved media + metadata + CSV are the irreducible core. (Flagged §13 Q1.)
- Subtitle availability is independent of the storyboard/script (subtitles come from Story 10/16's
  per-media alignment); include whatever `.srt` exist.

### 5.5 The editor JWT contract (links with no editor account)

Per `architecture.md` §6.5 + §10.4 + §10.2 (editor auth = "signed JWT in URL; no session"). Two
token kinds, one per link.

#### 5.5.1 Claim shape (exact)

```
{
  "kind":          "brief" | "upload",
  "event_id":      "<cuid>",
  "assignment_id": "<cuid>",
  "iat":           <unix seconds, issue time>,
  "exp":           <unix seconds = deliveryDate + EDITOR_TOKEN_EXPIRY_BUFFER_DAYS>
}
```

- Claims are **exactly** `architecture.md` §6.5: `kind`, `event_id`, `assignment_id`, `exp`, `iat`.
  No editor email, no PII, no honoree data in the token (it travels in URLs/logs).
- `exp` equals the persisted `briefExpiresAt`/`uploadExpiresAt` (§5.2) so the column and token agree.
- **Algorithm: HMAC** (HS256) with `EDITOR_TOKEN_SECRET` (`architecture.md` §10.4 "HMAC-signed JWT";
  §14 "64-byte random; rotate annually"). Symmetric is correct — the same service signs and verifies.
- **No `jti`/single-use:** `architecture.md` §6.5 — "Single-use is not enforced; editors may revisit
  the brief multiple times." Both links are reusable until `exp`.

#### 5.5.2 Signing & verification utility

A single module (proposed `src/lib/editor-token.ts` **[CONFIRM location]**) exports
`signEditorToken({ kind, eventId, assignmentId, expiresAt }) → string` and
`verifyEditorToken(token) → { ok: true, claims } | { ok: false, reason }`. It is the **only** place
the secret is used; web routes/pages call it, never re-implement JWT.

**Verification (run on EVERY `/editor-portal/*` request — `architecture.md` §6.5, §10.4):**

1. Parse + verify HMAC signature with `EDITOR_TOKEN_SECRET`. Bad signature → reject.
2. Check `exp` (now ≤ exp). Expired → reject as **expired** (→ **410 Gone**, §10).
3. Check `kind` matches the route's expected kind (a `brief` token must not work on the upload route
   and vice-versa).
4. Cross-check against the DB: load the `EditorAssignment` by `assignment_id`; require it exists,
   `event_id` matches, and (defense-in-depth) `now ≤ briefExpiresAt`/`uploadExpiresAt` for the kind.
   A token whose assignment was deleted → reject (404/410). This makes the persisted expiry the
   backstop even if a token were somehow minted with a longer `exp`.
5. On success, the route gets `{ eventId, assignmentId, kind }` and proceeds (Story 14's pages).

> **Story 14 builds the `/editor-portal/*` pages**; this story owns the **token contract +
> utility + the verify-every-request + 410-on-expiry rule** so Story 14 (and any download resolver
> shipped here, §13 Q2) consume a single, tested verifier. IP/UA are **logged on first use**
> (`architecture.md` §10.4 — mismatch warns admin, does not block; editors travel) — the logging
> hook is defined here; the admin-warn surfacing is Story 14/observability.

### 5.6 The editor-email job

**Queue:** `notifications` (Story 18). **Job name:** `editor.assignment_email`. Payload
`{ eventId, assignmentId }`. Idempotency jobId `{eventId}::editor.assignment_email:{assignmentId}`.

**Flow:**

1. Re-fetch `EditorAssignment` + `Event`. If `briefPackagePath == null` (brief not ready) →
   **defer/throw** so it retries after the brief job finishes (or rely on the §5.3.3 ordering that
   only enqueues this after the path write). No email without a ready brief.
2. **Mint both JWTs** via `signEditorToken` (§5.5): a `brief` token and an `upload` token, each
   `exp = deliveryDate + buffer`.
3. **Build the links:**
   - Brief download: `{NEXT_PUBLIC_APP_URL}/editor-portal/brief?token={briefJwt}` (resolves to a
     presigned GET of `briefPackagePath`, §5.3 / §13 Q2).
   - Upload: `{NEXT_PUBLIC_APP_URL}/editor-portal/upload?token={uploadJwt}` (Story 14's page).
   **[CONFIRM]** exact route paths/param name — §13 Q2.
4. **Dispatch via the Story 18 dispatcher** with `recipientType = editor`, `recipientEmail =
   editorEmail`, `trigger = editor.assignment` (or split `editor.brief_ready` — §13 Q13),
   `channel = email`, `templateId = editor.assignment`, `templateVars` (§5.6 below). The dispatcher
   applies the **honoree-suppression filter** (editor is never the honoree, but the filter still
   runs — `architecture.md` §10.1) and records/dedupes in `NotificationLog` on `(eventId,
   'editor.assignment', editorEmail)` so a retry/double-enqueue never double-emails.
5. On success → `NotificationLog` `sent`. On permanent failure → `failed` + admin alert (Story 18
   §5.6). The assignment stays `ASSIGNED` (Story 14 advances it).

**Email template** (`templateId = editor.assignment`; brand voice, `branding.md` §3/§10 — warm,
calm, **no exclamation marks**, exact honoree name, occasion-aware noun, short functional dates,
"by Swara Media" footer). HTML + plaintext.

| Element | Content |
|---|---|
| Subject | "Editing brief for {honoreeName}'s {occasionNoun} tribute" |
| Greeting | "Hi {editorName}," |
| Body | "You've been assigned to edit the tribute video for {honoreeName}'s {occasionNoun}. The brief package — approved media organized by contributor, the storyboard and script where available, subtitles, and event details — is ready to download." |
| Brief summary | A few lines from `manifest.json`: "{contributors} contributors · {videos} videos · {voices} voice messages · {photos} photos. Theme: {theme}. Music mood: {musicMood}." |
| Deadline | "Please deliver by {deadlineLong}." (and: "Your secure links stay live until {expiryShort}.") |
| Buttons / links | **[Download brief package]** → brief link · **[Upload final video]** → upload link |
| Instructions | "Upload the finished video (MP4) using the link above when you're ready. You can revisit the brief any time before the link expires. There's no account to sign in to." |
| Footer | "— Swara Magical Memories / by Swara Media" |

Template **never** references or exposes the honoree's contact and never suggests contacting the
honoree (surprise integrity, §10). `templateVars`: `editorName`, `honoreeName`, `occasionNoun`,
`theme`, `musicMood`, `contributors`, `videos`, `voices`, `photos`, `deadlineLong`, `expiryShort`,
`briefLink`, `uploadLink`.

### 5.7 Status transitions, idempotency & error cases

**Status transitions (this story owns the first two):**

```
Event:   MANUAL_ROUTED ──(assign action)──► EDITOR_ASSIGNED
                                              (Story 14: ─► EDITING_IN_PROGRESS ─► FINAL_VIDEO_UPLOADED ─► …)

Assignment:  (none) ──(assign action)──► ASSIGNED
             ASSIGNED  ──(Story 14: editor opens portal / starts upload)──► IN_PROGRESS
             IN_PROGRESS ──(Story 14: upload complete)──► UPLOADED
             UPLOADED ──(Story 14 admin)──► APPROVED | REVISION_REQUESTED
             REVISION_REQUESTED ──(Story 14: re-upload)──► UPLOADED
```

This story sets only **`ASSIGNED`** (and flips `Event` → `EDITOR_ASSIGNED`). It does **not** set
`IN_PROGRESS`/`UPLOADED`/`APPROVED`/`REVISION_REQUESTED` (Story 14). **[CONFIRM]** whether the
brief-ready/email-sent milestones warrant a sub-state vs. being derivable from `briefPackagePath` +
`NotificationLog` — **default: derivable, no extra status** (keep the enum exactly as
`architecture.md` §7.1) — §13 Q13.

**Idempotency:**
- Assign action: guarded by the `EditorAssignment.eventId @unique` (E4) — at most one assignment per
  event; the action is not re-runnable into a duplicate.
- `brief.build`: jobId-deduped in flight; output-by-key (deterministic S3 path + `briefPackagePath`
  write) safe across retries/retention. Re-running overwrites the same ZIP.
- `editor.assignment_email`: jobId-deduped + `NotificationLog` dedupe on `(eventId,
  'editor.assignment', editorEmail)` — at most one email ever.

**Error cases — assign action (Server Action; "HTTP-equiv" is the contract a thin route honors):**

| # | Case | Detection | Error code | HTTP-equiv | Admin sees | Side effects |
|---|---|---|---|---|---|---|
| E1 | Event not found / stale | step 3 | `EVENT_NOT_FOUND` | 404 | "could not be found…" | none |
| E2 | Caller not admin | step 1 | `FORBIDDEN` | 403 | "don't have access…" | log (warn) |
| E3 | Wrong status (not `MANUAL_ROUTED`) | step 4 | `INVALID_ASSIGNMENT_STATE` | 409 | "isn't routed to a human editor yet" | none |
| E4 | Already assigned (race / `@unique`) | step 5 / DB constraint | `ALREADY_ASSIGNED` | 409 | "already assigned…" ; UI refreshes | none (the first assignment stands) |
| E5 | No approved media | step 7 | `NO_APPROVED_MEDIA` | 409 | "no approved media…" | none (assignment **not** created) |
| E6 | Validation (bad email, missing editor) | step 2 | `INVALID_REQUEST` | 422 | field/summary error | none |
| E7 | Pool editor id not found | step 6 | `EDITOR_NOT_FOUND` | 404 | "Choose an editor…" | none |
| E8 | Unexpected (DB/txn) | any | `INTERNAL` | 500 | "Something went wrong…" | log (error); txn rolled back (no partial write) |

**Error cases — `brief.build` (worker):**

| Case | Handling |
|---|---|
| Approved media disappeared at run time (un-approved between assign and run) | No ZIP written; assignment stays `ASSIGNED` (`briefPackagePath` null); admin alert (`assignment.brief_failed` log + optional admin notification); panel shows the failed state with Retry (§4.3, §13 Q10) |
| A media object missing in storage (deleted/orphan key) | Skip that entry + record it in the manifest's `warnings[]`; do **not** fail the whole brief for one missing file **[CONFIRM]** skip-vs-fail — §13 Q5; if it leaves zero media, treat as no-approved-media |
| Multipart assembly throws (storage/network/archiver) | **Abort** the multipart upload (no partial object), throw → BullMQ retry (`attempts=3`, exp backoff, Story 9 §5.8). After exhausting → `failed` set; assignment stays `ASSIGNED`; admin alert; the email job is **not** enqueued (no ready brief) |
| `EDITOR_TOKEN_SECRET` missing | Config Zod fails at boot (prod) — never reaches the job; in dev a clear startup error (§7.1) |
| Re-run after `briefPackagePath` already set | Safe: overwrites the ZIP at the same key + re-writes the same path; the email job dedupes so no second email |

**Error cases — `editor.assignment_email` (worker):**

| Case | Handling |
|---|---|
| Brief not ready (`briefPackagePath` null) | Throw → retry; or (preferred) it is only enqueued after the path write so this is a guard, not the norm |
| Channel send fails (retryable) | Story 18 dispatcher retry (3×); on permanent fail → `NotificationLog` `failed` + admin alert; assignment stays `ASSIGNED`; a sweep/admin Retry can re-enqueue |
| Honoree-equals-recipient (should be impossible — editor ≠ honoree) | Suppressed + logged `suppressed_surprise` + critical alert (the filter still runs — `architecture.md` §10.1, §13) |
| Re-enqueue (retry/double) | `NotificationLog` dedupe → no second email |

---

## 6. Database Design

Story 13 introduces the **`EditorAssignment`** model + the **`AssignmentStatus`** enum from
`architecture.md` §7.1, the `Event.editorAssignment` `@unique` back-relation, and (if not already
present) the `EDITOR_ASSIGNED`/`EDITING_IN_PROGRESS` `EventStatus` values. It introduces a simple
**`Editor`** pool table (§6.3). It **reuses** `AuditLog` (Story 8) and `NotificationLog` (Story 18)
unchanged.

### 6.1 `EditorAssignment` model — fields (architecture §7.1)

| Field | Type | Null? | Default | Written by | Meaning |
|---|---|---|---|---|---|
| `id` | String (cuid) | no | `cuid()` | create | PK; also the `{assignment_id}` in the S3 path + JWT |
| `eventId` | String | no | — | create | FK → `Event.id`, `onDelete: Cascade`; **`@unique`** (one assignment per event, §6.2) |
| `event` | relation `Event` | — | — | — | `@relation(fields:[eventId], references:[id], onDelete: Cascade)` |
| `editorName` | String | no | — | create | Resolved from pool or `externalName` |
| `editorEmail` | String | no | — | create | Resolved from pool or `externalEmail`; the email recipient |
| `briefPackagePath` | String? | yes | — | brief job | S3 key `editor-brief/brief_{id}.zip`; **null until built** (the brief-ready seam) |
| `briefExpiresAt` | DateTime | no | — | create | `deliveryDate + buffer`; brief link expiry (JWT `exp` backstop) |
| `uploadExpiresAt` | DateTime | no | — | create | `deliveryDate + buffer`; upload link expiry (Story 14) |
| `status` | `AssignmentStatus` | no | `ASSIGNED` | create (Story 14 advances) | Lifecycle (§5.7) |
| `editorNote` | String? | yes | — | Story 14 | Editor handover message on upload |
| `adminFeedback` | String? | yes | — | Story 14 | Revision notes |
| `finalVideoPath` | String? | yes | — | Story 14 | Uploaded MP4 path |
| `uploadedAt` | DateTime? | yes | — | Story 14 | When the editor uploaded |
| `assignedAt` | DateTime | no | `now()` | create | Assignment time (SLA anchor for "hours since assignment", `architecture.md` §11.2) |

> **`deadline` field [CONFIRM] — §13 Q8.** `architecture.md` §7.1's `EditorAssignment` has **no**
> separate work-deadline column (only the two `*ExpiresAt`). The panel's editable work deadline
> (§4.2) can be (a) **not stored** (shown to the editor in the email only, defaulting to
> `deliveryDate`), or (b) stored as a new `deadline DateTime?` column. **Default: do not add a
> column** — keep the model exactly as architecture §7.1; the editor's deadline shown in the email
> defaults to `Event.deliveryDate` unless we later add the column. Flagged §13 Q8.

> Field names/types are taken **verbatim** from `architecture.md` §7.1 so Story 14 reuses them
> unchanged. Do not rename. `briefPackagePath`/`finalVideoPath` are S3 **keys** (private ACL,
> presigned on access), never public URLs.

### 6.2 `Event` relation & status

- **Relation:** `editorAssignment EditorAssignment?` on `Event` (the `@unique` side is on
  `EditorAssignment.eventId`), matching `architecture.md` §7.1's `Event.editorAssignment
  EditorAssignment?`. One-to-one (an event has at most one assignment in MVP 1).
- **`EventStatus` values used/added:** `MANUAL_ROUTED` (set by Story 12, the entry condition),
  `EDITOR_ASSIGNED` (set by this story's assign action), `EDITING_IN_PROGRESS` &
  `FINAL_VIDEO_UPLOADED` (used by Story 14; declared in the enum if not already present). Story 12
  added `MANUAL_ROUTED`; the enum in `architecture.md` §7.1 already lists all of these — this
  migration ensures `EDITOR_ASSIGNED`/`EDITING_IN_PROGRESS`/`FINAL_VIDEO_UPLOADED` exist.

### 6.3 Internal editor pool representation (recommendation)

`requirements.md` §5.7 / `architecture.md` §17 ("Swara Magical maintains an internal pool of
editors. Admin assigns from the pool. External-by-email invite remains supported as an edge case").
Two options:

| Option | Shape | Trade-off |
|---|---|---|
| **(A) `Editor` table (recommended)** | `Editor { id, name, email @unique, active Boolean @default(true), specialty String?, createdAt }` | A real, queryable, manageable pool; the panel's select reads it; future SLA/availability hangs off it. Small additive table. **Recommended.** |
| (B) Config list | An array in `src/config` (name/email pairs) | No migration, but editors are deploy-time only; no per-editor metadata; awkward to manage. Rejected for MVP 1 (pool is a first-class product concept). |

**Decision: (A) a minimal `Editor` table.** No login, no auth fields (editors never sign in — the
table is an admin-managed roster, not an account). The assign action's `POOL` mode reads it; the
`EXTERNAL` mode bypasses it. **[CONFIRM]** the exact `Editor` fields (specialty/availability) —
§13 Q7. (No relation from `Editor` → `EditorAssignment` is required; the assignment snapshots
`editorName`/`editorEmail` at assign time so a later roster edit doesn't rewrite history. **[CONFIRM]**
whether to also store `editorId` on the assignment for analytics — §13 Q7.)

### 6.4 `AssignmentStatus` enum (architecture §7.1)

`enum AssignmentStatus { ASSIGNED IN_PROGRESS UPLOADED APPROVED REVISION_REQUESTED }` — exactly
`architecture.md` §7.1. This story sets only `ASSIGNED`; Story 14 sets the rest.

### 6.5 Indexes & migration notes

| Index / constraint | On | Reason |
|---|---|---|
| `@unique` on `EditorAssignment.eventId` | `EditorAssignment` | One assignment per event (§6.2); also the race guard (E4) |
| `@@index([status])` on `EditorAssignment` | (optional) | Only if an "events in editing" admin list needs it at scale — **[CONFIRM]** defer — §13 Q16 |
| `email @unique` on `Editor` | `Editor` | No duplicate pool entries |

- Migration name: `add_editor_assignment` (e.g. `<ts>_add_editor_assignment`) — creates
  `editor_assignment` (+ FK `eventId → Event.id` `ON DELETE CASCADE`, the `@unique`), the
  `AssignmentStatus` enum, the `Event.editorAssignment` back-relation (virtual), the `Editor`
  table, and any missing `EventStatus` values.
- **Additive only** — new tables + nullable columns + enum extensions; no backfill; safe
  `prisma migrate deploy` against `swara_prd` (Story 1 pooled/direct-URL convention).
- The migration references `Event.id`/`Event.deliveryDate`/`EventStatus`; Story 3's `Event` (+ Story
  12's `MANUAL_ROUTED`) must precede it in history.
- Run `prisma generate` after migrate so `EditorAssignment`/`Editor`/`AssignmentStatus` are available
  to web + workers; `npm run typecheck` clean.

---

## 7. External Services / Integrations / Config

### 7.1 External services

- **S3 / R2** — the brief ZIP is written here (multipart). Workers need **read** (stream media) +
  **write/multipart** (the ZIP). Reuse the Story 6 storage service; add `getObjectStream` and a
  multipart-upload capability if absent (§7.3). Path: `editor-brief/brief_{assignment_id}.zip`
  (`architecture.md` §7.2), private ACL; the brief link resolves via a **presigned GET** (15-min
  expiry, `architecture.md` §7.2) minted only after JWT verification.
- **Resend (prod) / Mailpit (dev)** — the editor email, via the Story 18 `EmailChannel`. No new
  email infra; this story adds the `editor.assignment` template + the `editor` recipient type.
- **Redis / BullMQ** — the `brief_zip` queue (new processor) + the `notifications` queue (existing)
  for the email job. Reuse the Story 9 registry + `enqueue` helper.
- **No new external vendor.**

### 7.2 Config — add in BOTH `src/config/env.ts` and `src/config/index.ts`

Per the load-bearing convention (no `process.env` outside `src/config/env.ts`; raw read in `env.ts`,
typed/validated in `index.ts`; add to `.env.example`).

**Raw reads to add in `src/config/env.ts`:**
`EDITOR_TOKEN_SECRET`, `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS`, `WORKER_CONCURRENCY_BRIEF_ZIP`,
`BRIEF_ZIP_PART_SIZE_BYTES`, `BRIEF_ZIP_UPLOAD_CONCURRENCY`. (Reuse existing `S3_*` (Story 6),
`RESEND_API_KEY`/`RESEND_FROM_ADDRESS`/SMTP/`ADMIN_NOTIFY_EMAIL` (Story 18), `NEXT_PUBLIC_APP_URL`
(Story 1).)

**Typed block to add in `src/config/index.ts`:**

| Config field | Env var | Type | Default | Notes |
|---|---|---|---|---|
| `editor.tokenSecret` | `EDITOR_TOKEN_SECRET` | string (min length ≥ 32; **required in prod**) | — | HMAC key (`architecture.md` §14 "64-byte random; rotate annually"). Zod refine: required when `config.env == production`; a dev default may be allowed for local only **[CONFIRM]** — §13 Q17 |
| `editor.tokenExpiryBufferDays` | `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS` | int | `7` | `architecture.md` §14; the `deliveryDate + N` buffer |
| `worker.concurrency.briefZip` | `WORKER_CONCURRENCY_BRIEF_ZIP` | int positive | `2` | `brief_zip` Worker concurrency (`architecture.md` §8.1) |
| `briefZip.partSizeBytes` | `BRIEF_ZIP_PART_SIZE_BYTES` | int | `8388608` (8MB) | S3 multipart part size (≥5MB) (§5.3.4) |
| `briefZip.uploadConcurrency` | `BRIEF_ZIP_UPLOAD_CONCURRENCY` | int | `4` | multipart part upload concurrency (§5.3.4) |

- `.env.example` gets all of the above with safe local defaults (a clearly-placeholder
  `EDITOR_TOKEN_SECRET` for dev, `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS=7`).
- `EDITOR_TOKEN_SECRET` + `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS` match `architecture.md` §14 names exactly.
- The secret is read **only** through `config.editor.tokenSecret`; the JWT util imports config, never
  `process.env` (Story 1 ESLint rule).

### 7.3 Storage service additions (coordinate with Story 6/9)

- `getObjectStream(key) → ReadableStream` (or `downloadToFile`) — to **stream** each approved media
  file into the archive without buffering (§5.3.4). Story 9 likely added a read path; reuse it.
- A **multipart-upload** capability that accepts a **stream** and writes to a key, handling part
  sizing/concurrency and abort-on-error (e.g. the SDK's managed `Upload`). If Story 6 only exposed
  presigned PUT/POST + head, add this server-side multipart method here. **[CONFIRM]** §13 Q6.
- A `presignGet(key, ttl)` for the brief download (15-min). Likely exists (Story 7 admin downloads);
  reuse.

---

## 8. Seed Data

Extend the idempotent dev/test seed (Stories 3/5/6/8/12). Seed only in non-production (guard on
`config.env`); upsert by stable keys. Goal: the assignment panel renders, and a worker run produces
a real ZIP in MinIO locally.

| Seed fixture | Setup | Exercises |
|---|---|---|
| **Editor pool** | 2–3 `Editor` rows (e.g. `priya.editor@swara.media`, `sam.editor@swara.media`, one inactive) | the panel's pool select; `POOL` assignment |
| **`acme-25th-anniversary`** (reuse Story 12's MANUAL seed) | `status=MANUAL_ROUTED`, `routingDecision=MANUAL`, several **APPROVED** submissions with real tiny media (valid mp4/mp3/jpg in MinIO, per Story 9's "genuinely parseable" note) across video+voice+photo + text, mixed contributors; **with** an `AiArtifact` (storyboard JSON + narration markdown + a couple `.srt`) | the full brief (media + AI artifacts + CSV) |
| **`manual-no-ai`** | `status=MANUAL_ROUTED`, APPROVED media, **no `AiArtifact`** | the AI-absent brief path (§5.4) — manifest flags `ai.*Included=false` |
| **`manual-no-approved`** | `status=MANUAL_ROUTED`, only PENDING/REJECTED submissions | the `NO_APPROVED_MEDIA` (E5) path |
| **`already-assigned`** | `status=EDITOR_ASSIGNED` with a pre-seeded `EditorAssignment` (`ASSIGNED`, `briefPackagePath` set to a seeded ZIP key, expiries = `deliveryDate+7`) | the assigned/brief-ready panel state without running a worker; Story 14 has an assignment to consume |

Also:
- The `EDITOR_TOKEN_SECRET` in `.env.example` is a fixed dev placeholder so seeded/minted tokens
  verify locally.
- Document the local recipe: `docker compose up -d` (Redis + MinIO + Mailpit), `npm run seed`,
  `npm run workers`, then trigger an assignment in the admin UI (or a small `npm run
  enqueue:brief -- <assignmentId>` dev helper) → the `brief_zip` worker produces the ZIP; the email
  appears in Mailpit. **[CONFIRM]** add the dev enqueue helper — §13 Q18.
- **Do not** seed `AuditLog` rows (audit is produced by acting — Story 8 §8 convention).

---

## 9. Testing

Follows the project pattern (Vitest, `tests/unit` + `tests/integration`). DB/Redis/MinIO-touching
tests guarded by **`SKIP_INTEGRATION`**. The JWT util, manifest/CSV builders, expiry math, and
status/transition checks are **pure** and get the bulk of fast unit coverage; the email is mocked in
unit tests.

### 9.1 Unit tests (no infra; pure logic)

| Test | Asserts |
|---|---|
| **JWT sign → verify round-trip** | `signEditorToken(...)` then `verifyEditorToken` returns `ok:true` with the exact `{kind, event_id, assignment_id, iat, exp}` claims |
| **JWT expiry** | `exp` = `deliveryDate + EDITOR_TOKEN_EXPIRY_BUFFER_DAYS` (e.g. delivery + 7d); a token with `exp` in the past → verify rejects as **expired** (the 410 trigger) |
| **JWT tamper / wrong secret** | a token signed with a different secret, or with a mutated payload, → verify rejects (bad signature) |
| **JWT kind enforcement** | a `brief` token presented where `upload` is expected → rejected; and vice-versa |
| **Expiry math** | `briefExpiresAt == uploadExpiresAt == deliveryDate + buffer`; buffer default 7; honors a configured buffer |
| **Editor resolver** | `POOL` resolves `editorId` → `{name,email}`; `EXTERNAL` uses `externalName/Email`; invalid email rejected; missing pool id → `EDITOR_NOT_FOUND` |
| **Assign authz / transition** | non-admin → FORBIDDEN before any read/write; wrong status (not `MANUAL_ROUTED`) → INVALID_ASSIGNMENT_STATE; existing assignment → ALREADY_ASSIGNED; zero approved media → NO_APPROVED_MEDIA |
| **Audit metadata shape** | `assignment.created` metadata = `{assignmentId, editorSource, editorEmail, deadline, briefExpiresAt, approvedSubmissionCount}` (§11) |
| **Brief manifest** | given fixtures (contributors/media/AI), `manifest.json` has the right `contributors[]`, `totals`, and `ai.*Included` flags (true when artifact present, false when absent — §5.4) |
| **Metadata CSV shape** | one row per approved submission; exact columns/order (§5.3.5); `consent_given=true` + `consent_at` present; commas/quotes/newlines escaped (RFC-4180); UTF-8 header |
| **Brief layout / paths** | media organized as `media/{contributorSlug}/{type}/...`; contributor slug is filesystem-safe + collision-resistant; AI files only present when artifact exists |
| **Email template render** | `editor.assignment` renders with sample vars: contains `honoreeName` verbatim, correct `occasionNoun`, both links carrying the right JWT kind, the deadline + expiry lines, **no exclamation mark**, "by Swara Media" footer; HTML + plaintext both produced; never references a honoree contact |
| **Idempotency keys** | `buildJobKey` produces the documented `brief.build` / `editor.assignment_email` keys; stable per assignment |

### 9.2 Integration tests (`SKIP_INTEGRATION` guards DB + Redis + MinIO)

| Test | Flow |
|---|---|
| **Assign → assignment + status + job** | `MANUAL_ROUTED` event with approved media → assign action → assert `EditorAssignment` row (`ASSIGNED`, expiries = delivery+7, editor from pool), `Event.status == EDITOR_ASSIGNED`, one `AuditLog` `assignment.created`, and a `brief_zip` job enqueued |
| **Brief ZIP built (streamed) to MinIO** | run the `brief.build` job → assert an object exists at `editor-brief/brief_{id}.zip`, it **opens as a valid ZIP**, and contains the expected entries (manifest.json, metadata.csv, media/{contributor}/{type}/*, ai/* when present), and `EditorAssignment.briefPackagePath` is written |
| **Streaming invariant (sanity)** | the brief job for a fixture with a large-ish media file completes without buffering the whole archive (assert via the multipart path / a bounded-memory smoke check) **[CONFIRM]** how to assert — §13 Q19 |
| **AI-absent brief** | the `manual-no-ai` fixture → ZIP builds, manifest `ai.*Included=false`, no `ai/` entries, README notes absence |
| **No approved media (E5 / run-time)** | assign on `manual-no-approved` → action returns `NO_APPROVED_MEDIA`, no assignment created; and (separately) media un-approved between assign and run → job writes no ZIP, assignment stays `ASSIGNED`, admin alert |
| **Editor email sent once** | after the brief is built → the `editor.assignment_email` job mints both JWTs, sends via the mocked/Mailpit channel, writes one `NotificationLog` (`recipientType=editor`, `trigger=editor.assignment`, `status=sent`), and the email body's links carry verifiable `brief`/`upload` tokens |
| **Idempotent re-runs** | re-enqueue `brief.build` → same ZIP overwritten, `briefPackagePath` unchanged; re-enqueue `editor.assignment_email` → **no** second email (`NotificationLog` dedupe) |
| **Multipart abort on failure** | force a mid-assembly error → assert the multipart upload is aborted (no partial object at the key) and the job retries/fails per policy; assignment stays `ASSIGNED` |
| **Already-assigned race** | two assign actions on the same event → first wins; second → `ALREADY_ASSIGNED`; exactly one `EditorAssignment` (the `@unique` enforces it) |
| **JWT verify against DB** | a valid `upload` token whose `EditorAssignment` was deleted → verify rejects (the §5.5.2 step-4 DB cross-check) |

### 9.3 Notes

- The JWT util, manifest builder, and CSV builder are pure → unit-tested with fixtures (no infra).
  The streaming archiver + multipart upload are exercised in integration against MinIO.
- The `Channel` send is **mocked** in unit tests and asserted against Mailpit (or a captured-send
  fake) in integration, reusing the Story 18 dispatcher test seam.
- CI: unit always; integration via the existing Redis service + MinIO + a test DB; else
  `SKIP_INTEGRATION=true`.

---

## 10. Security & Surprise Integrity

| Concern | Control |
|---|---|
| **Editor auth = signed JWT in URL, no account** | Editors never sign in (`architecture.md` §10.2, `requirements.md` §5.7/§9). Access is solely the HMAC-signed `brief`/`upload` JWT; there is no editor session, password, or portal login |
| **HMAC + short expiry** | Tokens are HMAC-signed with `EDITOR_TOKEN_SECRET` (`architecture.md` §10.4); `exp = deliveryDate + 7d` (a bounded, short-lived window tied to the SLA, not indefinite) |
| **Verified on every `/editor-portal/*` request** | `verifyEditorToken` runs on **every** request (signature + `exp` + `kind` + DB cross-check, §5.5.2) — `architecture.md` §6.5/§10.4. Verification is server-side and not bypassable by the client |
| **410 on expiry** | An expired (or invalid) token returns **410 Gone** (`architecture.md` §10.4) — the contract owned here, enforced by Story 14's pages and any download resolver |
| **Time-limited brief link** | The brief download resolves to a **presigned GET** (15-min, `architecture.md` §7.2) minted **only after** JWT verification — even a leaked URL grants nothing without a valid, unexpired token, and the presigned URL itself expires fast |
| **No editor PII / honoree data in the token** | Claims are only `{kind, event_id, assignment_id, iat, exp}`; the token in URLs/logs leaks no email or honoree information |
| **Consent records for compliance** | The brief's `metadata.csv` carries `consent_given` + `consent_at` per included contributor (`requirements.md` §5.5/§8) — consent is captured at submit (mandatory) and exported with the brief for the editor's/Swara's compliance record |
| **No honoree contact, ever** | The editor email is fine (the editor is an allowed actor); the honoree is never emailed. The dispatcher's honoree-suppression filter still runs on the editor send (`architecture.md` §10.1), and the email template never references or offers to contact the honoree (surprise integrity) |
| **Admin-only trigger** | The assign action asserts `role == ADMIN` (+ allowlisted domain) server-side before any read/write (Story 7 guard); `actorId`/editor identity are resolved server-side, never trusted from the client |
| **Audit of assignment** | `assignment.created` is written in the same transaction as the assignment (no unaudited handoff); append-only (Story 8 §6.1) |
| **No surprise leak via the brief** | The brief contains only approved media + metadata the contributors consented to; it is private-ACL S3 reachable only via a verified, expiring link; the share page / honoree-facing flow is not involved (out of scope, `architecture.md` §15) |
| **IP/UA logging** | Logged on first token use (`architecture.md` §10.4); a mismatch warns the admin but does **not** block (editors travel) — the logging hook is defined here, the warn surfacing is Story 14/observability |
| **Secret handling** | `EDITOR_TOKEN_SECRET` lives in host env (Story 1 §16); read only via `config`; rotate annually (a rotation invalidates outstanding links — acceptable, links are short-lived; flagged §13 Q20) |
| **CSRF** | The assign Server Action is origin-checked by Next.js; the editor links are GET resolvers gated by token verification (the upload POST is Story 14) |

---

## 11. Observability / Audit

### 11.1 `AuditLog` action names (this story)

| Trigger | `AuditLog.action` | `actorId` |
|---|---|---|
| Admin assigns an editor | `assignment.created` | admin id |
| (optional) Brief ZIP built | `assignment.brief_ready` | `null` (system/worker) — **[CONFIRM]** §13 Q13 |
| (optional) Editor email sent | `assignment.emailed` | `null` (system/worker) — or rely on `NotificationLog` only — **[CONFIRM]** §13 Q13 |
| (optional) Brief build failed | `assignment.brief_failed` | `null` (system) |

Dotted convention (`architecture.md` §7.1). The required row is `assignment.created`; the
brief/email milestones are derivable from `briefPackagePath` + `NotificationLog`, so the optional
audit rows are belt-and-braces (default: log + `NotificationLog`, no extra audit rows — §13 Q13).

### 11.2 `AuditLog.metadata` shape (`assignment.created`)

```
{
  assignmentId: string,
  editorSource: "POOL" | "EXTERNAL",
  editorEmail:  string,          // admin-internal record of who was assigned (not honoree PII)
  deadline:     string (ISO),
  briefExpiresAt: string (ISO),
  approvedSubmissionCount: number,
  timestamp:    string (ISO)
}
```

`actorId` + `eventId` are first-class columns (Story 8 §11.2). No honoree/contributor PII copied in.

### 11.3 `NotificationLog` (editor email)

One row per editor send: `recipientType = editor`, `recipientEmail = editorEmail`,
`channel = email`, `trigger = editor.assignment` (`architecture.md` §7.1 notes `recipientType` may
be `editor`; Story 18 §6.1 lists it). `status ∈ {sent, failed, suppressed_surprise}`; deduped on
`(eventId, 'editor.assignment', editorEmail)` (§5.6). This is the durable "editor emailed" record
the panel + SLA views read.

### 11.4 Structured logs (Story 1 `logger`)

| Signal | Level | Fields |
|---|---|---|
| Editor assigned | info | `eventId`, `assignmentId`, `actorId`, `editorSource`, `approvedSubmissionCount` (no editor email at info if treated as PII — **[CONFIRM]** §13 Q21) |
| Brief build start/finish | info | `eventId`, `assignmentId`, entry count, total bytes, duration; **never** media bytes/URLs |
| Brief build failure | error | full error; assignment stays `ASSIGNED` |
| Editor email sent/failed | info/warn | `eventId`, `assignmentId`, `status`; honoree-suppression → critical alert (§10) |
| Token verification failure | debug/warn | `assignmentId?`, reason (`expired`/`bad_sig`/`wrong_kind`); never the token |

Trace correlation: `event_id` (+ `assignment_id`) as span/log attributes so the manual handoff slots
into the submission → routing → manual → (Story 14) trace (`architecture.md` §13).

### 11.5 Metrics (read-only aggregations; OTel/Honeycomb per `architecture.md` §13)

- **Brief build duration / size** (per assignment) and **failure rate** — capacity/cost signal for
  the `brief_zip` pool (`architecture.md` §12 "many manual workflows triggered same day").
- **Time-to-assign** (`MANUAL_ROUTED` → `assignedAt`) and **manual-path volume** (assignments per
  period) — editorial-throughput signals.
- **Hours since assignment** vs `deliveryDate` (SLA risk, `architecture.md` §11.2) — the input to the
  MVP 2 "no upload by delivery−48h" alert (out of scope here; this story records the anchors).
- No new metrics table; all derivable from `EditorAssignment` + `AuditLog` + `NotificationLog`.

---

## 12. Definition of Done

Story 13 is done only when all are true:

- [ ] `prisma/schema.prisma` has the `EditorAssignment` model (fields per §6.1, `eventId @unique`,
      `onDelete: Cascade`), the `AssignmentStatus` enum, the `Event.editorAssignment` relation, the
      `Editor` pool table, and any missing `EventStatus` values; migration `add_editor_assignment`
      created and applied to `swara_dev`, applied to `swara_test` in CI and `swara_prd` on deploy;
      `prisma generate` run.
- [ ] Config adds `EDITOR_TOKEN_SECRET` + `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS` (default 7) + the
      `brief_zip` knobs in **both** `src/config/env.ts` and `src/config/index.ts` + `.env.example`;
      Zod requires the secret in prod; no `process.env` outside `src/config/`.
- [ ] A `signEditorToken` / `verifyEditorToken` utility exists with the exact §5.5.1 claim shape,
      HMAC signing with `EDITOR_TOKEN_SECRET`, `exp = deliveryDate + buffer`, and the verify-every-
      request + `kind`-check + DB-cross-check + 410-on-expiry contract (§5.5.2, §10).
- [ ] An admin-only **assign-editor Server Action** creates the `EditorAssignment` (`ASSIGNED`,
      expiries = delivery+buffer, editor from pool or external email), flips `Event.status` →
      `EDITOR_ASSIGNED`, writes one `assignment.created` `AuditLog` row — all in one transaction —
      and enqueues `brief.build` after commit; all §5.8 error cases handled with calm copy (§4.7),
      incl. `NO_APPROVED_MEDIA`.
- [ ] A `brief_zip` job (concurrency 2) assembles the brief **streamed/multipart** to
      `editor-brief/brief_{assignment_id}.zip` (never buffering the whole archive), containing
      approved media organized by contributor/type + AI artifacts (when present) + subtitles + event
      metadata + `metadata.csv` (consent records) + `manifest.json`; writes `briefPackagePath`; aborts
      the multipart upload on error; then enqueues the editor-email job.
- [ ] An `editor.assignment_email` job mints `brief` + `upload` JWTs and sends the editor a
      brand-voice email (links + deadline + brief summary) via the Story 18 dispatcher; one
      `NotificationLog` row; deduped; honoree filter applied.
- [ ] The **editor-assignment panel** renders on `/admin/events/[id]` for `MANUAL_ROUTED` (pick
      pool/external editor, set deadline, trigger) and shows assigned / brief-building / brief-ready
      / error states.
- [ ] The brief builds with AI artifacts **present or absent** (manifest records which); the
      no-approved-media path is handled at both assign-time (E5) and run-time.
- [ ] Editors have **no** portal login anywhere in this story; all editor access is the signed JWT.
- [ ] Unit tests (JWT sign/verify/expiry/kind/tamper, expiry math, editor resolver, assign
      authz/transition, audit shape, manifest, metadata CSV, brief layout, email render, idempotency
      keys) pass; integration tests (assign → row+status+job, ZIP to MinIO + openable + entries,
      AI-absent brief, no-approved-media, email-once, idempotent re-runs, multipart abort,
      already-assigned race, JWT-vs-DB) pass and honor `SKIP_INTEGRATION`.
- [ ] Accessibility (§4.8): real controls with accessible names, color-independent status,
      `aria-live` announcements, keyboard operability.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; deploy succeeds.
- [ ] No TODO comments left in committed code; `docs/stories.md` Story 13 row marked done.

---

## 13. Open Questions / Assumptions

| # | Question / Assumption | This doc's default / proposal | Needs |
|---|---|---|---|
| Q1 | **Story 16 (AI artifacts) absent when this runs.** A `MANUAL_ROUTED` event may have no `AiArtifact`. | Brief builds **without** AI files; manifest flags `ai.*Included=false`; README notes absence; approved media + metadata + CSV are the irreducible core. | **[CONFIRM]** reconcile with the Story 16 design (artifact paths/fields) |
| Q2 | **Brief download route + upload route paths + token param.** | Brief: `/editor-portal/brief?token=…` (resolves to presigned GET); upload: `/editor-portal/upload?token=…` (Story 14). Whether the **brief download resolver** ships in Story 13 or Story 14. | **[CONFIRM]** route paths; **decision** on which story ships the brief resolver (recommend a thin resolver here so the email link works end-to-end before Story 14) |
| Q3 | **Inclusion gate = `APPROVED` only (must match Story 8 §13 Q4 / Story 12 §13 Q9).** | **`APPROVED`** submissions/media only in the brief; `PENDING`/`FLAGGED`/`REJECTED` excluded. | **[CONFIRM]** consistently across 8/12/13/16 |
| Q4 | **Does `MANUAL_ROUTED` auto-assign an editor, or is assignment a separate admin step?** | **Separate explicit admin step** (admin chooses editor + deadline); Story 12's after-commit seam enqueues nothing for manual. | **[CONFIRM]** (matches `requirements.md` §5.7 step 3) |
| Q5 | **Brief ZIP folder/file naming + missing-object handling.** | `media/{contributorSlug}/{type}/…`; slug = sanitized name + short id; a missing storage object is **skipped** + recorded in `manifest.warnings[]` (fail only if zero media remain). | **[CONFIRM]** naming + skip-vs-fail |
| Q6 | **Streaming ZIP library + multipart mechanism + media stream-through vs temp-file spill.** | A streaming ZIP writer (emits a readable stream) → SDK managed multipart `Upload`; media streamed via `getObjectStream`; bounded temp-file spill allowed if stream-through isn't feasible. Add a server-side multipart method to the storage service if absent. | **[CONFIRM]** library choice + storage-service additions |
| Q7 | **`Editor` pool table fields** (specialty/availability) + store `editorId` on the assignment? | Minimal `Editor { id, name, email @unique, active, specialty?, createdAt }`; assignment **snapshots** `editorName`/`editorEmail`; optionally also store `editorId` for analytics. | **[CONFIRM]** fields + whether to store `editorId` |
| Q8 | **Work-deadline column vs display-only; does it affect expiry?** | **No new column** (keep model = architecture §7.1); editor's deadline shown in email defaults to `Event.deliveryDate`; **link expiry is always `deliveryDate + buffer`**, independent of the panel field. | **[CONFIRM]** add a `deadline` column? |
| Q9 | **Admin "Download brief" link** (presigned GET) to inspect what the editor received. | Include it (admin-only, 15-min presign). | **[CONFIRM]** |
| Q10 | **Brief-failed recovery** — admin Retry control vs auto-retry only. | Provide an admin **Retry** that re-enqueues `brief.build` (idempotent), in addition to BullMQ auto-retry. | **[CONFIRM]** |
| Q11 | **No-approved-media: block assignment (E5) vs create-but-defer-brief.** | **Block** creation (E5); admin must approve media first. | **[CONFIRM]** (alt: create assignment, defer brief, "Prepare brief" later) |
| Q12 | **Reassignment / token revocation.** | Out of MVP 1 (one assignment per event via `@unique`); reassignment + revoke = MVP 2 (`architecture.md` §10.5 / §18). | **[CONFIRM]** deferral |
| Q13 | **Sub-states / extra audit rows for brief-ready / emailed.** | Keep `AssignmentStatus` exactly = architecture §7.1 (no extra status); brief-ready/emailed derivable from `briefPackagePath` + `NotificationLog`; optional `assignment.brief_ready`/`emailed`/`brief_failed` system audit rows. | **[CONFIRM]** include optional audit rows? |
| Q14 | **Metadata CSV exact columns/order** + include `quality_overall`? | The §5.3.5 columns; include `quality_overall` for the editor's reference. | **[CONFIRM]** |
| Q15 | **Schema not yet on `main`** (only `User`). | Assume Stories 3/5/6/7/8/9/12/18 land their models/enums/infra before this migration. | **[CONFIRM]** — those must merge first |
| Q16 | **`@@index([status])` on `EditorAssignment`.** | Defer until an "events in editing" admin list needs it. | Defer |
| Q17 | **`EDITOR_TOKEN_SECRET` dev default vs required-in-prod.** | Required (Zod) when `env==production`; a fixed placeholder allowed in dev/test only. | **[CONFIRM]** |
| Q18 | **Dev `enqueue:brief` helper** to exercise the worker without the UI. | Add a small dev script. | **[CONFIRM]** |
| Q19 | **How to assert the streaming/no-buffer invariant in tests.** | Assert via the multipart code path + a bounded-memory smoke test on a large fixture (not a strict memory assertion). | **[CONFIRM]** |
| Q20 | **`EDITOR_TOKEN_SECRET` rotation** invalidates outstanding links. | Acceptable (links are short-lived: delivery+7d); rotate annually (`architecture.md` §14); document the operational impact. | **[CONFIRM]** |
| Q21 | **Editor email as PII in logs.** | Treat editor email as PII: store in `NotificationLog`/audit metadata (admin-internal records), keep out of info-level app logs. | **[CONFIRM]** |
