# Sequence 11 / Story 14 — Editor Upload Back + Admin Review

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (the token-gated editor upload page + JWT verification, the presigned MP4 upload flow,
the server-side ffprobe validation rules, the `EditorAssignment` status transitions, the admin
review actions, the revision loop, and every error case) so a later code-generation step
implements exactly this and nothing more. Where a value is a proposal awaiting confirmation it is
flagged **[CONFIRM]**; genuine ambiguities are listed in §13, not silently chosen. **No code
appears in this document.**

| Field | Value |
|---|---|
| Story number / title | Story 14 — Editor upload back + admin review |
| Epic | G — Manual Editing Workflow |
| Sequence number | 11 (this is the 11th design in build order) |
| Depends on | Story 13 (Manual workflow — brief ZIP + editor assignment; the `EditorAssignment` model, the editor-link **JWT scheme** signed with `EDITOR_TOKEN_SECRET`, and the **`upload`-kind token** are issued there; this story **consumes** that token and the assignment row) |
| Also assumes on `main` | Story 1 (config, `db`, `redis`, `logger`, worker scaffold, CI), Story 3 (`Event` + `EventStatus`), Story 6 (storage service: `buildMediaKey`-style key helper, `createUploadTarget` presign, `headObject`/`objectExists`, plus a worker-side `getObjectStream`/`downloadToFile` added in Story 9), Story 7 (admin auth gate + `requireAdmin` + `/admin/events/[id]` detail layout), Story 8 (`AuditLog` model + audit-in-transaction pattern), Story 9 (BullMQ queue registry + `enqueue` helper + idempotency `jobId` convention + the **ffprobe wrapper** `probeMedia`), Story 18 (the `Channel` interface + shared notification dispatcher + `NotificationLog` dedupe + honoree suppression filter) |
| Parallel with | Story 17 (AI encode variants) — both consume the approve handoff; this story designs only the seam |
| Unlocks | Story 15 (Delivery — share page + delivery email fire on Approve), Story 17 (encode variants fire on Approve) |
| Complexity | M–L (2–4 days) |

> **Sources of truth honored:** `docs/requirements.md` §5.7 steps 5–7 (editor uploads final video
> via secure upload URL [MP4 only]; editor note/handover message; admin reviews → Approve OR
> Request revision → editor re-uploads; upload links expire after delivery date + 7 days), §2
> (Video Editor role; no portal login), §9 (no editor portal login — secure email links only).
> `docs/architecture.md` §6.5 (editor uploads `final.mp4` via signed link; verify JWT + check
> expiry + validate MP4; store in `events/{id}/final/`; `assignment.status=UPLOADED`; enqueue
> notify admin; admin approve → enqueue encode variants [Story 17] + generate share page [Story 15]
> + notify organizer; OR request revision), §10.4 (Editor Token Security — HMAC JWT verified every
> request, expired → 410 Gone, IP/UA logged on first use, admin can revoke), §7.1 (`EditorAssignment`
> incl. `status AssignmentStatus`, `finalVideoPath`, `uploadedAt`, `editorNote`, `adminFeedback`;
> `FinalVideo` incl. `source VideoSource`, `variant VideoVariant`, `storagePath`, `durationSec`,
> `sizeBytes`; the `AssignmentStatus`/`VideoSource`/`VideoVariant` enums), §7.2 (storage layout —
> `final/` paths), §11.1 (final video upload corrupted → ffprobe validate on upload, reject with
> editor notification if invalid; editor non-delivery alert at `delivery_date − 48h`), §10.3 (file
> upload security — MIME validated server-side, don't trust browser). Also: `docs/branding.md`
> (editor-portal + email copy, calm/warm voice, no exclamation marks, honoree-name-sacred,
> occasion-aware nouns, "by Swara Media" footer), `docs/stories.md`,
> `docs/stories/story-01-foundation.md` (doc + config style), `CLAUDE.md`, `prisma/schema.prisma`
> (current: `User` + `Role`), and the sibling designs `seq05-story06-media-uploads.md` (storage
> interface + presign pattern), `seq06-story09-workers-quality-scoring.md` (queue/idempotency +
> ffprobe wrapper), `seq05-story07-admin-dashboard-readonly.md` (admin route/auth/detail layout),
> `seq09-story12-routing-analyzer-approval.md` (admin action + audit-in-transaction style),
> `seq06-story18-reminder-automation.md` (the `Channel` dispatcher + `NotificationLog` dedupe).

> **Note on the Story 13 source.** `docs/design/seq10-story13-manual-brief-editor-assignment.md`
> is **NOT present** in the repo at the time of writing. The `EditorAssignment` model, the editor
> JWT scheme, and the `upload`-kind token that this story consumes are therefore taken from
> `architecture.md` §6.5 (the JWT structure `{kind, event_id, assignment_id, exp, iat}` signed with
> `EDITOR_TOKEN_SECRET`, verified on every `/editor-portal/*` request), §10.4 (token security
> posture), and §7.1 (the `EditorAssignment` schema). **If the Story 13 design lands first and
> names the token claims, the `/editor-portal` route prefix, the `EDITOR_TOKEN_*` config keys, or
> the JWT helper differently, reconcile §5.1 / §7 / §10 against it before generating code.** This is
> flagged loudly in §13 (A1). This story does **not** issue the `brief`-kind token, build the brief
> ZIP, or send the assignment email — those are Story 13. This story consumes the **already-issued**
> `upload` token.

---

## 1. Story Summary

By Story 13 an event has been `MANUAL_ROUTED`, an `EditorAssignment` row exists (status
`ASSIGNED` → `IN_PROGRESS`), the brief ZIP has been built, and the editor has received an email
containing two signed links: a **brief download** link (`kind=brief`) and a **final-video upload**
link (`kind=upload`), both signed with `EDITOR_TOKEN_SECRET` and both expiring at
`delivery_date + 7 days`. The editor has worked offline.

Story 14 implements the **return leg** of the manual workflow (`requirements.md` §5.7 steps 5–7;
`architecture.md` §6.5):

1. **A token-gated editor upload page** at `/editor-portal/upload` (no login, no account). The
   page is reachable only with a valid `upload`-kind JWT in the URL; the token is **verified on
   every request** (`architecture.md` §10.4). It shows a read-only assignment/brief summary, an
   **MP4-only** file picker with upload progress, an optional **handover note** field, and a
   confirm/submit action. Expired or revoked tokens render a **410 Gone** state.

2. **A direct-to-storage presigned upload** for the large final MP4 (reusing the Story 6 storage
   interface + presign pattern — bytes never pass through the app server), targeting
   `events/{eventId}/final/` (`architecture.md` §7.2).

3. **Server-side ffprobe validation** of the uploaded object: confirm it is a real, parseable MP4
   container with a usable video stream (don't trust the extension or the browser MIME —
   `architecture.md` §10.3, §11.1). On success, persist `EditorAssignment.finalVideoPath` /
   `uploadedAt` / `editorNote`, set `status = UPLOADED`, create a `FinalVideo` row
   (`source = EDITOR_UPLOADED`, `variant = MASTER`), and enqueue a **notify-admin** job. On failure,
   reject the upload and **notify the editor** that the file was invalid so they can re-upload.

4. **An admin review flow** on the existing admin event detail (Story 7 surface): preview/play the
   uploaded master, then either **Approve** (status → `APPROVED`; enqueue the downstream handoff —
   encode variants [Story 17] + share page [Story 15] + notify organizer) or **Request Revision**
   (status → `REVISION_REQUESTED`; store `adminFeedback`; notify the editor to re-upload). The
   **revision loop** lets the editor re-upload against the same assignment until the admin approves.

5. **The non-delivery admin alert** at `delivery_date − 48h`: if no upload has landed
   (`status` still `ASSIGNED`/`IN_PROGRESS`), alert the admin so they can chase or reassign
   (`architecture.md` §11.1).

**Scope discipline (the seam, not the destination).** This story designs the **Approve handoff
seam** only: on Approve it enqueues the encode + share-page + organizer-notify jobs and records the
decision. It does **not** implement variant encoding (Story 17) or the share page / delivery email
body (Story 15). It also does **not** issue editor tokens or build briefs (Story 13).

### Success criteria

- [ ] `GET /editor-portal/upload?token=…` with a valid, unexpired, non-revoked `upload` JWT renders
      the assignment summary + MP4-only upload UI; the honoree's contact is never exposed.
- [ ] The same route with an **expired** or **revoked** token renders a **410 Gone** state (no
      assignment data leaked); IP + user-agent are logged on first use (`architecture.md` §10.4).
- [ ] The editor uploads an MP4 via a presigned target into `events/{eventId}/final/`; bytes never
      transit the app server.
- [ ] On submit, the server **ffprobe-validates** the object; a genuine MP4 with a video stream is
      accepted; a non-MP4 / corrupt / extension-spoofed file is **rejected** and the editor is
      notified.
- [ ] On accept: `EditorAssignment.finalVideoPath`/`uploadedAt`/`editorNote` set, `status =
      UPLOADED`, one `FinalVideo` (`EDITOR_UPLOADED`/`MASTER`) row exists, exactly one notify-admin
      notification fires (deduped).
- [ ] The admin event detail shows the uploaded video for review with **Approve** and **Request
      Revision** actions (the latter requires notes); revision history is visible.
- [ ] **Approve** → `status = APPROVED`, decision audited, downstream handoff enqueued (encode +
      share page + organizer notify); admin-only; idempotent.
- [ ] **Request Revision** → `status = REVISION_REQUESTED`, `adminFeedback` stored, editor notified;
      the editor can re-upload against the same assignment (loop back to `UPLOADED`).
- [ ] At `delivery_date − 48h` with no upload, an admin non-delivery alert fires once.
- [ ] Schema gains the `FinalVideo` model + `VideoSource`/`VideoVariant` enums and uses the
      `EditorAssignment` fields (`status`/`finalVideoPath`/`uploadedAt`/`editorNote`/`adminFeedback`);
      migration is additive.
- [ ] Unit + integration tests (§9) pass; integration tests skip cleanly under `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; no `process.env` outside
      `src/config/env.ts`.

### What it unlocks

- **Story 15 (Delivery)** consumes the Approve handoff: the share-page generation + delivery email
  fire from the jobs this story enqueues on Approve.
- **Story 17 (Encode)** consumes the same Approve handoff: the `encoding` jobs that produce the
  Reel / YouTube / thumbnail variants from the approved master are enqueued here.

---

## 2. Scope

### In scope (this story)

- **Token-gated editor upload page** (`/editor-portal/upload`): JWT-gated, no login; assignment/brief
  summary; **MP4-only** upload with progress; optional handover note; expiry/revoked **410** state;
  branding (§4).
- **Upload JWT verification** (`kind=upload`, `assignment_id`, `event_id`, `exp`) on **every**
  request to the page and to the presign/submit endpoints; **410 Gone** on expiry/revocation; IP/UA
  log on first use (§5.1, §10).
- **Presigned upload for the MP4** to `events/{eventId}/final/` reusing the Story 6 storage interface
  + presign pattern (§5.2, §7).
- **Server-side ffprobe validation** of the uploaded object: real-MP4 + has-video-stream rules;
  reject + editor notification on invalid/corrupt (§5.3).
- **Persistence of the uploaded final video**: set `EditorAssignment.finalVideoPath`/`uploadedAt`/
  `editorNote`, `status = UPLOADED`; create `FinalVideo` (`EDITOR_UPLOADED`/`MASTER`); event status
  → `FINAL_VIDEO_UPLOADED` (§5.4, §6).
- **notify-admin** enqueue on a successful upload (via the Story 18 dispatcher) (§5.4, §11).
- **Admin review panel** in `/admin/events/[id]`: play/preview the uploaded video (presigned GET),
  **Approve** / **Request Revision** (with notes), and a **revision history** view (§4.3, §5.5).
- **Approve action**: `status → APPROVED`, audit, and the **handoff enqueue** (encode [Story 17] +
  share page [Story 15] + notify organizer) — **enqueue only, designed as a seam** (§5.5, §5.6).
- **Request-revision action**: `status → REVISION_REQUESTED`, store `adminFeedback`, notify editor;
  the **re-upload loop** back to `UPLOADED` (§5.5, §5.7).
- **Non-delivery admin alert** at `delivery_date − 48h` when no upload landed (§5.8).
- **Status transitions + idempotency + error cases** for all of the above (§5).
- **Schema**: the `FinalVideo` model + `VideoSource`/`VideoVariant` enums; use of the existing
  `EditorAssignment` fields; back-relations (§6).
- **Config**: reuse `EDITOR_TOKEN_SECRET` (+ `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS`) from Story 13;
  any new var (max final size, presign expiry for `final/`) added in **both** config files (§7).
- **AuditLog** (upload / approve / revision) + **NotificationLog** (admin + editor) + the
  non-delivery metric (§11).
- Seed: an assignment in `UPLOADED` (with a `FinalVideo`) and one in `REVISION_REQUESTED` (§8).
- Tests: JWT verify + 410, MP4 validation accept/reject, status transitions incl. the revision loop,
  admin authz, presigned-upload → ffprobe → status integration (§9).

### Out of scope (deferred — with owners)

| Deferred item | Owner / where |
|---|---|
| **Variant encoding** (Reel / YouTube / thumbnail from the approved master) | **Story 17** — this story only **enqueues** the encode handoff on Approve |
| **Share page generation + delivery email body** (the organizer "video ready" send, the `/share/{token}` page) | **Story 15** — this story only **enqueues** the share-page + organizer-notify handoff on Approve |
| **Editor token issuance, the `brief`-kind token, brief ZIP assembly, the assignment email** | **Story 13** — this story consumes the already-issued `upload` token |
| **Editor assignment / reassignment UI** (assigning, re-assigning to a new editor) | **Story 13** (assign) / MVP 2 (reassign/SLA dashboards, `architecture.md` §18) — this story's non-delivery alert only **flags**; it does not reassign |
| **Multipart / chunked / resumable upload** for very large MP4s | Deferred — single-part presigned PUT/POST in MVP 1; revisit if final masters exceed the single-part ceiling (§13 Q1) |
| **AI-generated final video path** (`source = AI_GENERATED`) | **Story 16/17** (AI route) — this story writes only `source = EDITOR_UPLOADED`; the `FinalVideo` model it adds is shared by both sources |
| **ClamAV virus scan of the uploaded MP4** | Deferred (same posture as Story 6) — flagged §10 / §13 Q7 |
| **Editor download of the brief inside `/editor-portal`** (the `brief`-kind page) | **Story 13** |
| **WhatsApp editor notifications** | MVP 2 — editor emails ride the Story 18 `Channel` interface; a `WhatsAppChannel` is additive |

**Surprise-integrity note:** the editor upload page shows the **honoree name** and occasion (the
editor needs them to do the work, and they appear in the brief) but **never** a honoree contact, and
the page is `noindex`/no-referrer. The editor is never the honoree; the honoree filter (§10) still
guards every notification. No share-page token is ever shown to the editor.

---

## 3. Dependencies & Sequence

### Must already be on `main`

- **Story 1 (Foundation):** typed `config` (`src/config/env.ts` raw + `src/config/index.ts` Zod),
  Prisma client (`src/lib/db.ts`), Redis client (`src/lib/redis.ts`), `logger`, the worker entry
  point (`src/workers/index.ts`), CI, `docker-compose` (Redis + MinIO + Mailpit).
- **Story 3 (Event creation):** `Event` model incl. `id`, `slug`, `deliveryDate`, `status:
  EventStatus`, `organizerId` → `User` (the organizer is the recipient of the Approve "video ready"
  notify-seam).
- **Story 6 (Media uploads):** the **storage service** — `createUploadTarget({key, contentType,
  maxBytes, expiresIn})` (presign), `headObject(key) → {exists, contentType, contentLength}`,
  `objectExists(key)`, and a canonical key helper. Story 14 adds a `final/`-scoped key helper
  (`buildFinalKey`, §5.2) alongside the existing `buildMediaKey`. The presign + verify-before-save
  pattern is reused directly (`seq05-story06` §5.1–§5.3, §7.2).
- **Story 7 (Admin dashboard):** the admin auth gate (`requireAdmin`), the `/admin/events/[id]`
  detail layout, and the per-event header into which the review panel is inserted.
- **Story 8 (Submission approval):** the `AuditLog` model + the audit-in-transaction pattern (write
  the status change + audit row in one transaction) reused for the Approve / Request-Revision
  actions.
- **Story 9 (Workers + quality):** the BullMQ **queue registry** + **`enqueue` helper** +
  idempotency `jobId` convention; the **ffprobe wrapper** (`probeMedia(path) → {streams, format, …}`)
  + the worker-side storage read (`getObjectStream`/`downloadToFile`) reused for validation.
- **Story 13 (Manual workflow):** the **`EditorAssignment` model** (incl. `status: AssignmentStatus`,
  `editorName`, `editorEmail`, `briefExpiresAt`, `uploadExpiresAt`, `editorNote`, `adminFeedback`,
  `finalVideoPath`, `uploadedAt`, `eventId @unique`), the **editor JWT scheme** (`EDITOR_TOKEN_SECRET`,
  claims `{kind, event_id, assignment_id, exp, iat}`), and the issued **`upload`-kind token**. If
  Story 13 has not landed when this story is implemented, see §13 A1 — the token verifier + config
  keys may need to be defined here and reconciled later.
- **Story 18 (Reminders/notifications):** the **`Channel` interface** + shared **dispatcher** +
  **`NotificationLog`** dedupe + the **honoree-suppression** filter. Story 14 adds new triggers +
  templates (notify-admin, editor-invalid, editor-revision, organizer "video ready" seam) and a new
  `recipientType = editor`; it adds **no** new dispatch plumbing.

### Sequence within this story

```
1. Schema: add FinalVideo model + VideoSource/VideoVariant enums + Event/EditorAssignment
   back-relations → verify: prisma migrate runs, generate clean, typecheck green
2. Config: confirm EDITOR_TOKEN_SECRET (+ buffer days) present from Story 13; add
   FINAL_VIDEO_MAX_BYTES + final-presign expiry in env.ts + index.ts → verify: config parses
3. Token verify: upload-JWT verifier (kind=upload, exp, assignment_id, event_id) + 410 on
   expiry/revoke + IP/UA log-on-first-use → verify: unit tests (valid / expired / wrong-kind /
   bad-sig / revoked)
4. Presign: final/-scoped presign endpoint (token-gated, MP4 content-type pinned) → verify:
   integration presign → PUT to MinIO
5. ffprobe validation: pure isValidMp4(probeResult) decision + the validate-on-submit flow
   (accept → persist + FinalVideo + notify-admin; reject → notify-editor) → verify: unit +
   integration
6. Editor page: /editor-portal/upload (summary + MP4 upload + note + states incl. 410) → verify:
   render states
7. Admin review: review panel in /admin/events/[id] (preview + Approve / Request Revision +
   revision history) → verify: render + authz
8. Approve handoff seam: status→APPROVED + audit + enqueue encode/sharepage/organizer-notify →
   verify: enqueue asserted, idempotent
9. Revision loop: status→REVISION_REQUESTED + adminFeedback + editor notify + re-upload → verify:
   loop integration
10. Non-delivery alert: delivery_date−48h sweep hook → verify: fires once, deduped
11. Seed + tests + DoD → verify: lint/typecheck/test green
```

### What this unlocks

- **Story 15 / Story 17** both hang off the **Approve handoff** enqueue (§5.6) — they add the
  encode processors and the share-page/delivery templates; they do not change this story's seam.

---

## 4. Frontend / UI Design

Two distinct surfaces: **(A) the editor portal upload page** (public-by-token, no login) and **(B)
the admin review panel** (inside the Story 7 admin detail, behind `requireAdmin`). Both honor
`docs/branding.md`: warm/confident/clear voice, **no exclamation marks**, **honoree name exactly as
stored**, occasion-aware nouns (`GRADUATION→"graduation"`, `BIRTHDAY→"birthday"`, `WEDDING→"wedding"`,
`ANNIVERSARY→"anniversary"`, `RETIREMENT→"retirement"`, `BUSINESS_EVENT→"business event"` — same map
as `seq03-story03` §5.6), short functional dates ("Delivery May 24, 2026"), Fraunces (display) +
Inter (body), Lucide outline icons (20px). The signature gradient/gold is **not** used (this is an
operational surface, not a celebratory one).

### 4.1 Editor portal — routes & access model

| Route (path) | Type | Access | Purpose |
|---|---|---|---|
| `/editor-portal/upload` | Server Component page (+ a client upload widget) | **`upload`-kind JWT in URL only** (no session) | The editor's final-video upload page. |

- The token is read from the URL (query param `?token=…` **[CONFIRM]** — query vs path segment; the
  Story 13 email links determine this; recommend a query param `token` to match a simple signed-URL
  shape, consistent with `architecture.md` §6.5 "signed link"). It is **verified server-side on
  every request** (§5.1) before any assignment data is rendered. **Assumption A2.**
- **No navigation chrome / no login.** The page is a single-purpose, standalone surface (a minimal
  header wordmark + "by Swara Media" footer lockup only). There is no link into the rest of the app.
- `noindex, nofollow` meta + `Referrer-Policy: no-referrer` (the URL carries a signed token; it must
  not leak via referrers or search — mirrors the surprise-integrity posture, §10).

### 4.2 Editor portal — states

| State | When | Rendering |
|---|---|---|
| **Ready (assigned / in-progress / revision)** | valid token; `status ∈ {ASSIGNED, IN_PROGRESS, REVISION_REQUESTED}` | Assignment summary (§4.2.1) + MP4 upload widget (§4.2.2) + handover-note field + submit. If `REVISION_REQUESTED`, show the admin's `adminFeedback` prominently at top ("Requested changes") so the editor knows what to fix. |
| **Uploading** | a file is selected and uploading | Progress bar (% from the direct-to-storage PUT), file name + size, cancel; submit disabled until upload + validation complete. Quietly-purposeful motion (branding §9). |
| **Submitted (awaiting review)** | `status = UPLOADED` (this assignment already has an accepted upload pending admin review) | A calm confirmation: "Your video is in and awaiting review." Show the uploaded file name + `uploadedAt`. **Allow re-upload** while still `UPLOADED`? **[CONFIRM]** — recommend allowing replace-before-review (the editor spotted a mistake) until the admin acts; see §13 Q4. |
| **Approved** | `status = APPROVED` | "This tribute has been approved and is being prepared for delivery." No further upload. (Read-only acknowledgement.) |
| **Invalid file (validation failed)** | last submit was rejected by ffprobe (§5.3) | Inline error in editor voice: "That file couldn't be read as an MP4. Please export an MP4 (H.264 video) and try again." + retry. (Also emailed, §5.7.) |
| **Expired / revoked (410)** | token `exp` passed, OR admin revoked the assignment | A standalone **410 Gone** page: "This upload link has expired." + a line directing them to contact Swara (no app login). **No assignment data is rendered.** (§5.1, §10.) |
| **Invalid token (signature / wrong kind / malformed)** | bad signature, `kind ≠ upload`, missing claims | A generic **404/“invalid link”** page (do **not** distinguish from 410 in a way that aids probing — §10). **[CONFIRM]** 404 vs 410 split: recommend **410** for *expired-but-valid* tokens (semantically "was here, now gone") and **404/“invalid link”** for *unverifiable* tokens. |

#### 4.2.1 Assignment / brief summary (read-only)

Shown on the Ready state so the editor confirms they are uploading to the right job:

| Field | Source | Notes |
|---|---|---|
| Honoree + occasion | `Event.honoreeName` (exact) + occasion-aware noun | e.g. "Riya's graduation tribute". |
| Delivery date | `Event.deliveryDate` | short functional date; the editor's hard date. |
| Theme / music mood | `Event.theme`, `Event.musicMood` | brief context (read-only). |
| Brief reference | `EditorAssignment.briefPackagePath` presence | a short line "Your brief was sent in your assignment email" — **not** a re-download link here (the `brief`-kind page is Story 13). **[CONFIRM]** whether to surface a brief re-download here or keep it Story 13-only (recommend Story 13-only). |
| Requested changes (revision only) | `EditorAssignment.adminFeedback` | shown only when `status = REVISION_REQUESTED`; the notes the admin sent back. |

**Never shown:** organizer identity/contact, honoree contact, contributor PII, any share token, any
internal id beyond what the signed token already encodes.

#### 4.2.2 MP4 upload widget (client)

- **Accept MP4 only.** The file input `accept=".mp4,video/mp4"`; a client-side guard rejects other
  extensions/types **before** presigning (a UX nicety only — the **server** is authoritative, §5.3,
  §10). Single file.
- **Size guard (client):** reject files over `FINAL_VIDEO_MAX_BYTES` (§7) before upload with a clear
  message; the presigned target also pins the max (§5.2) so storage rejects oversize too.
- **Direct-to-storage PUT** to the presigned target (bytes never hit the app server, `architecture.md`
  §6.5 / §6.2). Progress bar driven by the upload's progress events.
- **Two-step submit:** (1) upload bytes to storage; (2) call the **submit** endpoint (§5.3) which
  triggers server-side ffprobe validation + persistence. The editor sees: uploading → "checking your
  file" → success/invalid. Submit is disabled until both steps complete.
- **Handover note:** an optional multi-line text field ("Notes for the Swara team (optional)") mapped
  to `EditorAssignment.editorNote`; length-capped (§5.3); persisted on submit.

### 4.3 Admin review panel (inside `/admin/events/[id]`)

Inserted into the Story 7 admin event detail, visible **only** when the event is on the manual path
and an upload exists or is pending. Behind `requireAdmin` (Story 7). Sections:

1. **Editor assignment summary** (read-only): editor name + email, assigned date, delivery date +
   countdown, `uploadExpiresAt`, current `AssignmentStatus` badge (humanized — §4.4), and the
   editor's handover `editorNote` if present.
2. **Uploaded video review** (visible when `status ∈ {UPLOADED, APPROVED, REVISION_REQUESTED}` and a
   `FinalVideo` master exists):
   - An inline `<video>` player fed by a **short-lived presigned GET** for the master
     (`FinalVideo.storagePath`, `variant = MASTER`) — 15-minute expiry, generated server-side per
     view (§5.5, §7.2). The token is never rendered into a logged URL (§10).
   - File facts: duration (`FinalVideo.durationSec`), size (`FinalVideo.sizeBytes`), `uploadedAt`.
   - **Actions** (only when `status = UPLOADED`):
     - **Approve** — primary action. Confirms, then `status → APPROVED` + handoff (§5.5/§5.6).
       Confirmation copy: "Approve this video and start delivery preparation. This can't be undone."
       **[CONFIRM]** whether Approve is reversible (recommend **not** reversible once handoff is
       enqueued — §13 Q5).
     - **Request revision** — secondary action. Opens a required notes field (`adminFeedback`); on
       submit, `status → REVISION_REQUESTED` + editor notify (§5.5/§5.7).
   - When `status = APPROVED`: actions are hidden; show "Approved on {date} by {admin}" +
     downstream status (e.g. "Encoding + delivery in progress" once those land).
   - When `status = REVISION_REQUESTED`: show the sent `adminFeedback` and a calm "Waiting for the
     editor to re-upload." No actions until a new upload arrives (status returns to `UPLOADED`).
3. **Revision history** (read-only): a chronological list of the assignment's review events — each
   upload (`uploadedAt`), each revision request (the `adminFeedback` text + when + which admin), and
   the approval. **[CONFIRM] history source:** `AuditLog` rows for this assignment (recommended — it
   already records every action, §11) rendered as a timeline, since the schema keeps only the
   **latest** `adminFeedback` / `editorNote` / upload on the single `EditorAssignment` row (one row
   per event, `@unique`). See §6.4 / §13 Q3 on whether to add a `FinalVideoRevision` history table
   (recommended: derive history from `AuditLog`, no new table).

> Explicitly **absent** here: variant downloads (Story 17), the share link / delivery status detail
> (Story 15) beyond a status line, editor reassignment (Story 13/MVP 2). The panel leaves room for a
> "delivery" sub-section that Story 15 fills.

### 4.4 `AssignmentStatus` → humanized label (admin badges)

| Enum value | Label | Tone |
|---|---|---|
| `ASSIGNED` | Assigned | neutral |
| `IN_PROGRESS` | Editing in progress | neutral |
| `UPLOADED` | Uploaded — ready for review | info |
| `REVISION_REQUESTED` | Revision requested | warning |
| `APPROVED` | Approved | success |

(Matches the `AssignmentStatus` enum in `architecture.md` §7.1; freeze these strings so the admin UI
never shows an unknown status — coordinate with Story 7/13.)

### 4.5 Accessibility

- The editor upload widget is fully keyboard-operable; the progress bar exposes `aria-valuenow`; the
  invalid-file and 410 states use `role="alert"`/`role="status"`; the file input has a visible label.
- The admin player has accessible controls (native `<video controls>`); Approve/Request-revision are
  real buttons with visible focus; the required-notes field has an associated label + error text.
- All status badges convey meaning via text + icon + color, never color alone (branding §8).
- Contrast meets WCAG AA (ink on ivory; functional palette for warning/success/error).

---

## 5. Backend / Worker Design

The request surface is small and **token-gated** on the editor side and **admin-gated** on the
review side. The heavy work (ffprobe validation) runs in the **worker** (FFmpeg lives there, not on
Vercel — `architecture.md` §4). Every state change is written with an audit row (Story 8 pattern),
and every notification goes through the Story 18 dispatcher.

### 5.1 Upload-link JWT verification (every request)

The `upload`-kind token (issued by Story 13) is verified on **every** request to the editor page and
to the presign/submit endpoints — there is no session (`architecture.md` §6.5, §10.4).

**Expected claims** (from `architecture.md` §6.5):

| Claim | Meaning | Verified |
|---|---|---|
| `kind` | must equal `"upload"` (reject `brief` or anything else) | exact match |
| `event_id` | the event the assignment belongs to | matches the loaded assignment's `eventId` |
| `assignment_id` | the `EditorAssignment.id` | the row exists; status allows upload (§5.4) |
| `exp` | `delivery_date + EDITOR_TOKEN_EXPIRY_BUFFER_DAYS` (7d) | not in the past |
| `iat` | issued-at | informational; used for IP/UA "first use" logging |

**Verification algorithm (authoritative order):**

1. **Parse + verify signature** with `EDITOR_TOKEN_SECRET` (HMAC, `architecture.md` §10.4). Bad
   signature / malformed → **invalid-link** state (404-style, §4.2) — do not reveal why.
2. **Check `kind === "upload"`.** Wrong kind → invalid-link.
3. **Check `exp`.** Expired → **410 Gone** (§4.2, `architecture.md` §10.4 "expired tokens return 410
   Gone"). No assignment data is loaded/returned.
4. **Load the `EditorAssignment` by `assignment_id`**; confirm it exists and its `eventId ===
   event_id`. Missing/mismatch → invalid-link.
5. **Revocation check.** If the assignment is revoked (admin revoke — §10; **[CONFIRM]** mechanism:
   recommend a derived check `now > uploadExpiresAt` **OR** an explicit revoke flag/status; see §6.4
   / §13 Q6) → **410 Gone**. `architecture.md` §10.4: "admin can revoke."
6. **IP/UA log on first use.** On the **first** verified use of this token (no prior "first-use"
   audit/marker), record the client IP + user-agent (`architecture.md` §10.4: "IP and user-agent
   logged on first use; mismatch warns admin but doesn't block — editors travel"). Subsequent uses
   with a different IP/UA emit a **warn-level** log / admin signal but **do not block** (§10, §11).
   **[CONFIRM]** where the first-use marker lives (recommend an `AuditLog` row `editor.link.first_use`
   keyed by `assignment_id` — no schema change; §11).
7. **Proceed.** Return a minimal, safe assignment view (§4.2.1) — never honoree/organizer contact.

> **410 vs invalid-link rule (security, §10):** *valid-but-expired/revoked* → **410** (semantically
> "gone"); *unverifiable* (bad sig / wrong kind / malformed / unknown assignment) → **generic
> invalid-link (404-style)**, with copy that does not disclose which check failed. This prevents
> probing the token space while honoring the architecture's explicit "expired → 410". **[CONFIRM]**
> exact HTTP codes with Story 13's link UX (A3).

### 5.2 Presigned upload for the MP4 (`events/{eventId}/final/`)

Reuses the Story 6 storage interface + presign pattern (`seq05-story06` §5.1, §7.2), scoped to the
`final/` prefix (`architecture.md` §7.2).

| Item | Value |
|---|---|
| Endpoint | `POST /api/editor-portal/upload/presign` **[CONFIRM path]** (token-gated, no session) |
| Auth | the `upload` JWT (§5.1) verified first; 410/invalid on failure |
| Key | `buildFinalKey(eventId)` → `events/{eventId}/final/master.mp4` **[CONFIRM filename]** — single canonical master per event; a re-upload (revision) **overwrites the same key** (idempotent storage, no orphan accumulation). Alternative: version the filename per attempt (`master_{n}.mp4`) and keep history — see §13 Q2. **Recommend overwrite** (one master; history is in `AuditLog`). |
| Content-Type pin | the presigned target **pins** `Content-Type: video/mp4` (POST policy / PUT signed header) so storage rejects a non-MP4 declared type at the edge (defense in depth; the authoritative check is ffprobe, §5.3) |
| Max size | the presigned target pins max content-length to `FINAL_VIDEO_MAX_BYTES` (§7); storage rejects oversize |
| Expiry | short — **15 minutes** (reuse Story 6's presign expiry; **[CONFIRM]** a longer expiry for large masters on slow editor links — see §13 Q1) |
| Response | `{ upload: <presigned PUT/POST instruction>, storageKey }` (mirrors Story 6 §7.2). The client uploads, then calls submit (§5.3) echoing `storageKey`. |

- **Why direct-to-storage:** the master can be large; the app server never proxies bytes
  (`architecture.md` §6.5 / §6.2; `seq05-story06` §1).
- **Key scoping (security):** `buildFinalKey` always produces the `events/{eventId}/final/…` prefix
  from the **token's** `event_id`; it ignores any client-supplied key/prefix (no path traversal,
  no cross-event write — §10).

### 5.3 Submit → ffprobe validation → persist (the core flow)

After the browser PUTs the bytes, the client calls the **submit** endpoint. Validation runs in the
worker (FFmpeg/ffprobe), then persistence + notification happen.

| Item | Value |
|---|---|
| Endpoint | `POST /api/editor-portal/upload/submit` **[CONFIRM path]** (token-gated) |
| Auth | the `upload` JWT (§5.1) verified first |
| Request | `{ storageKey, editorNote? }` — `storageKey` **must** equal a `buildFinalKey(eventId)` for the token's event (server recomputes + compares; reject mismatch — §10). `editorNote` length-capped (**[CONFIRM]** e.g. ≤ 2000 chars). |

**Submit algorithm (authoritative order):**

1. **Re-verify the token** (§5.1); confirm `status` permits an upload: `ASSIGNED`, `IN_PROGRESS`,
   `REVISION_REQUESTED` (and, if replace-before-review is allowed, `UPLOADED` — §13 Q4). If
   `APPROVED` → reject ("already approved", 409).
2. **HEAD the object** (`headObject(storageKey)`) — confirm it exists and storage-reported
   `contentLength ≤ FINAL_VIDEO_MAX_BYTES` and `contentType` is `video/mp4` (defense in depth). Missing
   → reject (the client claimed an upload that isn't there).
3. **ffprobe-validate** (worker; §5.3.1). This is the **authoritative** MP4 check (don't trust
   extension/MIME — `architecture.md` §10.3, §11.1). Two outcomes:
   - **Valid MP4** → continue to persist (step 4).
   - **Invalid/corrupt** → **reject**: do **not** set `finalVideoPath`/`UPLOADED`; record an
     `AuditLog` `editor.upload.invalid`; **notify the editor** (template `editor.upload.invalid`,
     §5.7) so they can re-upload; return a structured error to the page (§4.2 invalid state). The
     bad object **[CONFIRM]** may be left for overwrite on retry or deleted (recommend leave —
     next valid upload overwrites the same key, §5.2).
4. **Persist (one transaction)** — Story 8 audit-in-transaction pattern:
   - `EditorAssignment`: set `finalVideoPath = storageKey`, `uploadedAt = now`, `editorNote =`
     submitted note (or null), `status = UPLOADED`, `adminFeedback = null` **[CONFIRM]** (clearing
     stale revision notes on a fresh upload — recommend clear so the admin reviews the new upload
     without the old "requested changes" lingering; see §13 Q8).
   - `FinalVideo`: **upsert** one row for this event with `source = EDITOR_UPLOADED`, `variant =
     MASTER`, `storagePath = storageKey`, `durationSec` + `sizeBytes` from the ffprobe result + HEAD
     (§6.2). Upsert (not insert) so a revision re-upload **overwrites** the master row rather than
     accumulating duplicates (idempotency — §5.9). **[CONFIRM]** upsert key: `(eventId, source,
     variant)` — see §6.2.
   - `Event.status`: `→ FINAL_VIDEO_UPLOADED` (`architecture.md` §5.5 status field; the admin's "ready
     to review" signal). Conditional update (only advance from a manual-path status; don't clobber
     `APPROVED`/`DELIVERED`).
   - `AuditLog`: `action = editor.upload.received` with `{assignmentId, storageKey, sizeBytes,
     durationSec, isRevision}` metadata.
5. **Enqueue notify-admin** (after commit, via the dispatcher) — trigger `editor.upload.received`,
   `recipientType = admin` (config `ADMIN_NOTIFY_EMAIL`, reused from Story 18 §7); deduped on
   `(eventId, editor.upload.received:{uploadedAt or attempt}, adminEmail)` so a re-upload notifies
   again but a retried submit does not double-notify (§5.9, §11). **[CONFIRM]** dedupe granularity —
   recommend keying the trigger token per-upload (`editor.upload.received` + `uploadedAt` epoch) so
   each distinct upload alerts the admin once.
6. **Return success** to the page → "awaiting review" state (§4.2).

#### 5.3.1 ffprobe MP4 validation rules (authoritative)

The validation is a **pure decision** over the ffprobe result (`probeMedia` from Story 9), kept as a
testable function `isValidFinalMp4(probeResult) → {ok, durationSec?, reasons[]}` so the rules are
unit-tested without binaries (§9). Accept **iff all** hold:

| # | Rule | Reject reason token if violated |
|---|---|---|
| 1 | ffprobe **parses** the file (no decode/parse error; the worker classifies a parse failure as a *verdict*, not an infra retry — mirrors `seq06-story09` §5.8) | `unreadable` / `corrupt` |
| 2 | Container **format** is MP4-family (`format_name` includes `mp4`/`mov,mp4,m4a,3gp,3g2,mj2` ISO-BMFF family) | `not_mp4` |
| 3 | At least **one video stream** is present with a recognized codec (e.g. `h264`/`hevc`/`av1` — **[CONFIRM]** allowed codec list; recommend H.264 strongly, accept HEVC/AV1) | `no_video_stream` / `unsupported_codec` |
| 4 | **Duration > 0** and within sane bounds (> a minimum, e.g. ≥ 1s; ≤ a max, e.g. ≤ 30 min **[CONFIRM]**) | `zero_duration` / `too_short` / `too_long` |
| 5 | (Soft / **[CONFIRM]** whether to enforce) the master is **landscape ~16:9** at ≥ 1080p, since the deliverable is 1920×1080 (`requirements.md` §5.8). **Recommend NOT hard-rejecting** on resolution/orientation in MVP 1 (the editor may have reasons; the admin reviews visually) — log a **warning flag** instead, surfaced to the admin. | `low_resolution` (warn, not reject) |

- **Don't trust the extension or browser MIME** (`architecture.md` §10.3): rule 2/3 are derived from
  ffprobe's actual container/stream inspection, not the `.mp4` suffix or the declared `Content-Type`.
- **Corrupt vs infra-failure** (reuse `seq06-story09` §5.8 classification): a genuine
  parse/format/stream verdict → **reject the upload** (do not retry; notify editor). A transient
  storage/timeout error fetching the bytes → **throw → retry** (it is not the editor's fault).
- **Where it runs:** the validation is a **worker job** (`editor.validate_upload` on a queue —
  **[CONFIRM]** reuse `quality` or add an `editor` queue; recommend reuse the existing **`quality`**
  worker pool since it already has FFmpeg + the probe wrapper, or a small dedicated `editor` queue if
  separation is preferred — §13 Q9). The submit endpoint either runs validation synchronously via the
  worker path or enqueues a validate job and the page polls/streams status. **Recommend**: enqueue an
  `editor.validate_upload` job; the page shows "checking your file" and resolves on completion. **The
  app route never invokes ffprobe directly** (FFmpeg is not in the Vercel runtime — §4, §7).

### 5.4 `EditorAssignment` status transitions (state machine)

```
        (Story 13)                 (this story)
ASSIGNED ──► IN_PROGRESS ──► [editor uploads valid MP4] ──► UPLOADED
                  ▲                                            │
                  │                                  ┌─────────┴───────────┐
                  │                            admin Approve         admin Request Revision
                  │                                  │                     │
                  │                                  ▼                     ▼
                  │                              APPROVED            REVISION_REQUESTED
                  │                            (terminal here;            │
                  │                             handoff enqueued)         │
                  └───────────── editor re-uploads valid MP4 ◄───────────┘
                                  (REVISION_REQUESTED ──► UPLOADED)
```

| From | Event | To | Guards |
|---|---|---|---|
| `ASSIGNED` / `IN_PROGRESS` | editor uploads a **valid** MP4 (§5.3) | `UPLOADED` | token valid; ffprobe-valid |
| `REVISION_REQUESTED` | editor **re-uploads** a valid MP4 | `UPLOADED` | token valid (same token reused — §13 Q10); ffprobe-valid; clears `adminFeedback` (§13 Q8) |
| `UPLOADED` | admin **Approve** | `APPROVED` | `requireAdmin`; one transaction; enqueue handoff (§5.6) |
| `UPLOADED` | admin **Request Revision** (with notes) | `REVISION_REQUESTED` | `requireAdmin`; `adminFeedback` non-empty; notify editor (§5.7) |
| `UPLOADED` | editor **replaces** before review **[CONFIRM A4]** | `UPLOADED` (overwrites master) | token valid; ffprobe-valid; re-notify admin |
| any | invalid MP4 submit | **(no transition)** | rejected; editor notified (§5.3) |
| any | admin **revoke** (token kill) | **(no status change required)** — revoke gates the token (§5.1/§10) | `requireAdmin` |

- **No automatic transitions** beyond the upload-driven `→ UPLOADED`. Approve / Request-revision are
  explicit admin actions.
- `APPROVED` is **terminal for this story** (no un-approve once the handoff is enqueued — §13 Q5).
- Every transition writes an `AuditLog` row in the same transaction (§11).
- Each transition is **idempotent**: re-issuing the same action when already in the target state is a
  no-op success (e.g. Approve on an already-`APPROVED` assignment does not re-enqueue the handoff —
  guarded by the audit/dedupe, §5.9).

### 5.5 Admin review actions (server)

Both actions are **Server Actions / admin POST routes** behind `requireAdmin` (Story 7), operating on
the event's `EditorAssignment`. Each is one transaction (Story 8 pattern: status change + audit
together), with the side-effecting enqueues/notifies **after** commit.

**Approve** (`status = UPLOADED → APPROVED`):
1. `requireAdmin`; load the assignment; assert `status = UPLOADED` (else no-op/409 — idempotent).
2. Transaction: set `status = APPROVED`; write `AuditLog` `editor.upload.approved`
   (`actorId = admin`, metadata `{assignmentId, finalVideoPath, finalVideoId}`); optionally advance
   `Event.status` (**[CONFIRM]** keep `FINAL_VIDEO_UPLOADED` until delivery, or add an `APPROVED`/
   `DELIVERING` event state — the architecture's `EventStatus` jumps `FINAL_VIDEO_UPLOADED → IN_REVIEW
   → DELIVERED`; recommend leaving event status to Story 15 which owns `DELIVERED`; this story sets
   the **assignment** to `APPROVED` and leaves event status for the delivery story — §13 Q11).
3. After commit: **enqueue the handoff** (§5.6).
4. Audit-guarded so a double-click / retry does not re-enqueue (§5.9).

**Request Revision** (`status = UPLOADED → REVISION_REQUESTED`):
1. `requireAdmin`; load; assert `status = UPLOADED`; require non-empty `adminFeedback` (length-capped,
   **[CONFIRM]** ≤ 2000 chars).
2. Transaction: set `status = REVISION_REQUESTED`, `adminFeedback = notes`; write `AuditLog`
   `editor.upload.revision_requested` (`actorId = admin`, metadata `{assignmentId, feedback}`).
3. After commit: **notify the editor** (template `editor.revision_requested`, §5.7) — the editor
   re-uploads against the **same** assignment + (recommended) the **same** upload token (§13 Q10).

**Preview (read):** generate a short-lived presigned GET for the master (`FinalVideo.storagePath`) for
the inline player (§4.3, §7.2); never log the signed URL (§10).

### 5.6 The Approve handoff seam (enqueue only — Story 15 + Story 17)

On Approve, after commit, enqueue the downstream work. **This story enqueues; it does not implement
the consumers.** Designed so Story 15 and Story 17 each add a processor without touching this seam.

| Enqueued job | Queue | Owner / consumer | Payload (ids only) | Purpose |
|---|---|---|---|---|
| `encode.variants` **[CONFIRM name]** | `encoding` (separate encoder pool, `architecture.md` §4/§8.1) | **Story 17** | `{ eventId, assignmentId, finalVideoId }` | Produce Reel / YouTube / thumbnail from the approved master |
| `delivery.generate_share_page` **[CONFIRM name]** | `notifications` or a `delivery` queue **[CONFIRM]** | **Story 15** | `{ eventId }` | Create `SharePage` + assemble the delivery package |
| `delivery.notify_organizer` **[CONFIRM]** | `notifications` | **Story 15** (via Story 18 dispatcher) | `{ eventId }` | "video ready" organizer email — surprise-safe, honoree-filtered |

- **Idempotency:** the enqueue is guarded so re-running Approve (idempotent, §5.4/§5.9) does not
  double-enqueue (jobId by `{eventId}:{assignment_id}:{job_type}` per the Story 9 convention, or an
  `AuditLog` `editor.upload.approved` existence check before enqueue).
- **Ordering:** encode and share-page can run in parallel; the organizer "video ready" notify should
  fire only when delivery assets are ready — **but that sequencing is Story 15's concern.** This story
  only emits the trigger jobs; Story 15/17 own their internal DAG. **[CONFIRM]** with Story 15/17
  whether Approve enqueues all three now or a single `delivery.start` orchestrator job that Story 15
  fans out (recommend a single **`delivery.start`** seam job to keep this story's coupling minimal —
  §13 Q12).
- **When both AI + manual exist:** if the event also has an AI-generated master (Story 16/17 path),
  the approved **editor** master is authoritative for the manual route; see §13 Q13 for how Approve
  coordinates source selection. For MVP 1 a manually-routed event has only the editor master; the
  `FinalVideo.source` discriminator (§6) lets delivery pick the right master.

### 5.7 Editor + admin notifications (new triggers + templates)

All sends ride the **Story 18 dispatcher** (`Channel` interface, `NotificationLog` dedupe, honoree
filter). This story adds a new `recipientType = editor` and the triggers/templates below. Copy follows
`branding.md` (warm, calm, **no exclamation marks**, honoree name exact, occasion-aware noun, "by
Swara Media" footer). Each template has HTML + plaintext.

| Template ID | Trigger | Recipient | Voice (one line) | Key variables |
|---|---|---|---|---|
| `editor.upload.received` | `editor.upload.received` | **admin** (`ADMIN_NOTIFY_EMAIL`) | "{honoreeName}'s {occasion} final video has been uploaded and is ready for review." | `honoreeName`, `occasionNoun`, `editorName`, `eventAdminUrl`, `uploadedAt`, `durationSec`, `sizeHuman` |
| `editor.upload.invalid` | `editor.upload.invalid` | **editor** | "That file couldn't be read as an MP4. Please export an MP4 (H.264) and re-upload using your original link." | `honoreeName`, `occasionNoun`, `uploadUrl` (the same signed link), `reason` (human-readable) |
| `editor.revision_requested` | `editor.upload.revision_requested` | **editor** | "Thanks for the upload. The Swara team has a few requested changes before delivery." + the notes. | `honoreeName`, `occasionNoun`, `adminFeedback`, `uploadUrl`, `deliveryDateShort` |
| `editor.non_delivery_alert` | `editor.non_delivery.48h` | **admin** | "Heads up — {honoreeName}'s {occasion} is due {deliveryDateShort} and no final video has arrived yet." | `honoreeName`, `occasionNoun`, `editorName`, `editorEmail`, `eventAdminUrl`, `deliveryDateShort` |
| `delivery.organizer.ready` *(seam — body owned by Story 15)* | (enqueued on Approve, §5.6) | **organizer** | (Story 15 owns the celebratory delivery copy) | — |

- **Editor notifications go to `EditorAssignment.editorEmail`.** The honoree filter still runs (the
  editor is never the honoree, but the filter is unconditional — §10).
- The `uploadUrl` in editor emails is the **same signed `upload` link** (the editor re-uploads with
  the token they already have — §13 Q10), valid until `delivery_date + 7d`.
- **No exclamation marks**; "Heads up" / "Last call" carry urgency without punctuation theatrics
  (branding §3/§10).

### 5.8 Non-delivery admin alert (`delivery_date − 48h`)

`architecture.md` §11.1: "Editor doesn't deliver before delivery date → Admin alert at
`delivery_date − 48h` if no upload; admin can reassign." Reuse the **hourly reminder sweep** infra
from Story 18 (§5.1 there) rather than a new scheduler.

| Item | Value |
|---|---|
| Where | extend the Story 18 hourly `reminders.sweep` (or a sibling sweep over manual assignments) **[CONFIRM]** — recommend adding a manual-workflow pass to the existing hourly sweep so there is one scheduler (§13 Q14) |
| Eligible | `EditorAssignment` whose `Event.deliveryDate − now ∈ (≈ 47h, 48h]` **and** `status ∈ {ASSIGNED, IN_PROGRESS}` (no upload landed) | 
| Action | dispatch `editor.non_delivery.48h` to the admin (template §5.7), `recipientType = admin` |
| Dedupe | `NotificationLog` `(eventId, editor.non_delivery.48h, adminEmail)` — fires at most once (§5.9) |
| Not done here | reassignment (admin acts manually; reassignment UI is Story 13/MVP 2) |

- The 1-hour-wide window matches the hourly cadence; the dedupe makes a missed/overlapping sweep
  harmless (same reasoning as Story 18 §5.3.1).
- If the editor has already uploaded (`status ∈ {UPLOADED, APPROVED, REVISION_REQUESTED}`), the alert
  does **not** fire (the upload arrived).

### 5.9 Idempotency & error cases

| Concern | Handling |
|---|---|
| Double-submit (same upload) | The submit re-verifies token + status; persistence is an **upsert** of the single `FinalVideo` master (by `(eventId, source, variant)`) + a conditional `EditorAssignment` update — re-running writes the same row state. The notify-admin dedupes per upload (§5.3 step 5). |
| Double Approve (double-click / retry) | Assert `status = UPLOADED` before acting; an already-`APPROVED` assignment → no-op success, **no** re-enqueue (audit-existence guard, §5.6). |
| Double Request-revision | Assert `status = UPLOADED`; idempotent set; editor notify deduped per revision request token. |
| Revision re-upload | `REVISION_REQUESTED → UPLOADED`, overwriting the master key (§5.2) and clearing `adminFeedback` (§13 Q8); notify-admin fires for the new upload. |
| ffprobe parse failure (corrupt) | **Verdict** → reject + editor notify; **no** retry (§5.3.1). |
| Storage/transient error during validation | **Infra failure** → throw → BullMQ retry (3×, exp backoff, mirror `seq06-story09` §5.8); not the editor's fault; no false rejection. |
| Token expired mid-edit | Any presign/submit with an expired token → **410**; the editor must contact Swara for a fresh link (token re-issue is Story 13/admin). |
| Object missing at submit | HEAD fails → reject ("upload not found"); the client retries the upload. |
| Worker crash mid-validate | BullMQ lock + requeue (`architecture.md` §11.1); the validate job is idempotent (re-probes the same key). |
| Admin acts on a non-manual / no-assignment event | `requireAdmin` passes but the action asserts an `EditorAssignment` exists + correct status → 409/no-op. |

---

## 6. Database Design

This story **adds the `FinalVideo` model + `VideoSource`/`VideoVariant` enums** (first physical use;
fully specified in `architecture.md` §7.1) and **uses** (writes) the existing `EditorAssignment`
fields. It adds the `Event.finalVideos` back-relation. The `EditorAssignment` model itself is added by
Story 13; this story does **not** redefine it — it writes its fields and may add the
`assignment ↔ finalVideo`-adjacent relations only if needed (§6.4).

### 6.1 `EditorAssignment` fields used / updated (owned by Story 13)

| Field | Type | Written by Story 14 | Value |
|---|---|---|---|
| `status` | `AssignmentStatus` | yes | `UPLOADED` (on valid upload), `APPROVED` (admin approve), `REVISION_REQUESTED` (admin request revision) |
| `finalVideoPath` | `String?` | yes | the `events/{eventId}/final/master.mp4` storage key, set on valid upload |
| `uploadedAt` | `DateTime?` | yes | timestamp of the accepted upload (updated on each valid re-upload) |
| `editorNote` | `String?` | yes | the editor's optional handover message (length-capped, §5.3) |
| `adminFeedback` | `String?` | yes | revision notes on Request Revision; **cleared** on a fresh re-upload (§13 Q8) |
| `uploadExpiresAt` | `DateTime` | read (and possibly the revoke gate) | `= delivery_date + 7d`; used for expiry/revoke checks (§5.1, §10) |
| `editorName` / `editorEmail` | `String` | read | recipient for editor notifications (§5.7) |
| `eventId` | `String @unique` | read | join to `Event`; one assignment per event |

> If Story 13 has **not** landed, this story must add the `EditorAssignment` model per
> `architecture.md` §7.1 verbatim (so the two stories don't diverge) — but the **owner is Story 13**;
> prefer to depend on it. Flagged §13 A1.

### 6.2 `FinalVideo` model — fields (added here)

Matches `architecture.md` §7.1 exactly (shared by the AI route too — Story 17 reuses it for the
encoded variants; this story writes only the editor-uploaded `MASTER`):

| Field | Type | Null? | Default | Notes |
|---|---|---|---|---|
| `id` | String (cuid) | no | `cuid()` | PK |
| `eventId` | String | no | — | FK → `Event.id`, `onDelete: Cascade` (final videos die with the event — `architecture.md` §11.4) |
| `event` | relation `Event` | — | — | `@relation(fields: [eventId], references: [id], onDelete: Cascade)` |
| `source` | `VideoSource` | no | — | `EDITOR_UPLOADED` (this story) \| `AI_GENERATED` (Story 16/17) |
| `variant` | `VideoVariant` | no | — | `MASTER` (this story) \| `REEL` \| `YOUTUBE` \| `THUMBNAIL` (Story 17) |
| `storagePath` | String | no | — | the `events/{eventId}/final/master.mp4` key |
| `durationSec` | Int? | yes | — | from ffprobe (§5.3.1) |
| `sizeBytes` | Int | no | — | from `headObject`/ffprobe (§5.3) |
| `createdAt` | DateTime | no | `now()` | — |

**Enums (added here):**

| Enum | Values | Notes |
|---|---|---|
| `VideoSource` | `AI_GENERATED`, `EDITOR_UPLOADED` | `architecture.md` §7.1 — both values declared now; only `EDITOR_UPLOADED` written this story |
| `VideoVariant` | `MASTER`, `REEL`, `YOUTUBE`, `THUMBNAIL` | `architecture.md` §7.1 — only `MASTER` written this story; the rest are Story 17 |

**Upsert key (idempotent re-upload):** a re-upload (revision) must **overwrite** the master, not
accumulate rows. Add a uniqueness constraint **`@@unique([eventId, source, variant])`** so the
master is upserted by `(eventId, EDITOR_UPLOADED, MASTER)` (§5.3 step 4, §5.9). **[CONFIRM]** —
`architecture.md` §7.1 declares `finalVideos FinalVideo[]` (many per event, for the variants) with no
unique; adding the composite unique is consistent (one row per source+variant per event) and gives
idempotency. If the team prefers append + "latest wins by `createdAt`", drop the unique and select
the newest — but that risks orphan masters; **recommend the composite unique** (§13 Q2).

### 6.3 `Event` changes

- **Add** the back-relation `finalVideos FinalVideo[]` (the other side of the FK). The `Event` model
  already lists `finalVideos FinalVideo[]` in `architecture.md` §7.1 — this story makes it real.
- **No new `Event` columns** in this story. (Whether to add an event-level `APPROVED`/`DELIVERING`
  status is deferred to Story 15 — §5.5, §13 Q11. This story uses the existing `FINAL_VIDEO_UPLOADED`
  on upload.)

### 6.4 Revocation + revision-history — schema decisions

- **Admin revoke (token kill).** Two options (§5.1 step 5, §10): **(i)** derive revocation from a
  cutoff — set `uploadExpiresAt = now` to immediately expire the token (no new column); or **(ii)**
  add an explicit `revokedAt DateTime?` / a `REVOKED` `AssignmentStatus`. **Recommendation:** **(i)
  no new column** for MVP 1 — "revoke" = an admin action that sets `uploadExpiresAt = now`, after
  which the §5.1 expiry check returns 410. This avoids a schema change and reuses the expiry path.
  **[CONFIRM]** with Story 13 (which owns `EditorAssignment`) — if Story 13 already models revoke,
  reuse it (§13 Q6).
- **Revision history.** The single `EditorAssignment` row keeps only the **latest** upload / feedback.
  History (multiple revision cycles) is derived from **`AuditLog`** rows (`editor.upload.received`,
  `editor.upload.revision_requested`, `editor.upload.approved`) rendered as a timeline (§4.3).
  **Recommendation: no new history table** — `AuditLog` is the canonical record (§11). A
  `FinalVideoRevision` table is only needed if we must retain *every* uploaded master file (we
  overwrite the key, §5.2). Flagged §13 Q3.

### 6.5 Migration notes

- Migration name e.g. `add_final_video` — creates the `final_video` table, the `VideoSource` +
  `VideoVariant` enums, the FK with `ON DELETE CASCADE`, the `@@unique([eventId, source, variant])`
  (if §6.2 option chosen), and the `Event.finalVideos` back-relation (virtual).
- **Additive only** — no backfill, no destructive change; safe to `prisma migrate deploy` against
  `swara_prd` (Story 1 pooled/direct-URL convention: `DATABASE_URL` runtime, `DIRECT_URL` for
  `prisma migrate`).
- Run `prisma generate` after migrate so `FinalVideo` types are available to web + workers; verify
  `npm run typecheck` clean.
- **Prerequisite:** `EditorAssignment` (Story 13) and `Event` (Story 3) must precede this in history.
  If Story 13 hasn't landed and this story must add `EditorAssignment`, fold it into the same
  additive migration but mark the ownership clearly (§13 A1).

---

## 7. External Services / Integrations / Config

### 7.1 External services

- **S3 / R2 object storage** — presigned **PUT/POST** (editor upload to `final/`) + presigned **GET**
  (admin preview). Reuse the Story 6 storage service; add a `final/`-scoped key helper (§5.2). Local
  dev: **MinIO** (`swara-minio`, already in compose).
- **FFmpeg / ffprobe** in the **worker** runtime (validation) — reuse the Story 9 wrapper
  (`probeMedia`) + binary provisioning (FFmpeg on the worker image, not in the Vercel web runtime,
  `architecture.md` §4, `seq06-story09` §7.2). Local dev: FFmpeg on PATH or the static package.
- **Resend** (prod) / **Mailpit** (dev SMTP) for editor + admin emails — reuse the Story 18
  `EmailChannel`. No new email infra.
- **Redis / BullMQ** — reuse the Story 9 registry + the Story 18 hourly sweep for the non-delivery
  alert. No new Redis.
- **No new external vendor** is introduced by this story.

### 7.2 Storage layout (`architecture.md` §7.2)

```
events/{event_id}/
  final/
    master.mp4          ← editor-uploaded master (this story; overwritten on revision)
    reel.mp4            ← Story 17
    youtube.mp4         ← Story 17
    thumbnail.jpg       ← Story 17
```

- All `final/` objects are **private ACL**; admin preview uses a **15-minute presigned GET**; the
  master upload uses a short-lived presigned PUT/POST (§5.2). The signed URL is never written to logs
  (`/events/{id}/final/master.mp4` is fine to log; the signed query string is redacted — §10).

### 7.3 Config — reuse + minimal additions (BOTH config files)

Per the load-bearing convention (`story-01-foundation.md` §3; `architecture.md` §16): every new var
is read **only** in `src/config/env.ts` (raw) and validated/typed in `src/config/index.ts` (Zod). No
`process.env` elsewhere (ESLint `no-restricted-syntax`). Update `.env.example`.

**Reused from Story 13 (do NOT re-add; this story USES them):**

| Env var | Config path | Used for |
|---|---|---|
| `EDITOR_TOKEN_SECRET` | `editor.tokenSecret` (Story 13) | HMAC verify the `upload` JWT on every request (§5.1, `architecture.md` §14/§10.4) |
| `EDITOR_TOKEN_EXPIRY_BUFFER_DAYS` | `editor.tokenExpiryBufferDays` (Story 13; default 7) | the `exp = delivery_date + 7d` math (read for display/validation only; the token already carries `exp`) |

**Reused from Story 18 (do NOT re-add):**

| Env var | Config path | Used for |
|---|---|---|
| `ADMIN_NOTIFY_EMAIL` | `notifications.adminEmail` | recipient for notify-admin + non-delivery alert (§5.7/§5.8) |
| `RESEND_API_KEY` / `RESEND_FROM_ADDRESS` / SMTP vars | `email.*` | the `EmailChannel` used for editor + admin sends |
| `NEXT_PUBLIC_APP_URL` | `app.publicUrl` (Story 1) | building the admin event URL in emails; the editor `uploadUrl` is the signed link from the token |

**New raw reads to add in `src/config/env.ts`** (then typed in `index.ts`):

| Env var | Purpose | Config path (typed) | Zod rule / default |
|---|---|---|---|
| `FINAL_VIDEO_MAX_BYTES` | max accepted final-master size (presign pin + server guard) | `storage.finalVideoMaxBytes` | `z.coerce.number().int().positive()`; default **[CONFIRM]** e.g. `5_000_000_000` (5 GB) — see §13 Q1 |
| `FINAL_UPLOAD_PRESIGN_EXPIRY_SECONDS` | presign expiry for the `final/` upload (may be longer than the 15-min media default for large masters) | `storage.finalUploadPresignExpirySeconds` | `z.coerce.number().int().positive()`; default **[CONFIRM]** e.g. `900` (15 min) or `3600` (1 h) — §13 Q1 |
| `FINAL_VIDEO_MAX_DURATION_SEC` *(optional)* | upper duration bound for validation rule 4 | `storage.finalVideoMaxDurationSec` | `z.coerce.number().int().positive()`; default **[CONFIRM]** e.g. `1800` (30 min) |

- **No new secret** is introduced — `EDITOR_TOKEN_SECRET` already exists (Story 13 / `architecture.md`
  §14). If Story 13 has not landed, this story must add `EDITOR_TOKEN_SECRET` (+ buffer days) per
  `architecture.md` §14 and flag the ownership (§13 A1).
- **Zod refinement:** none beyond positive-int coercion; the editor secret's prod-required refinement
  is owned by Story 13.

### 7.4 New runtime dependencies

- **None new.** JWT verification reuses Story 13's helper (or a standard HMAC/JWT lib if Story 13
  hasn't established one); ffprobe reuses Story 9's wrapper; storage reuses Story 6's SDK; email
  reuses Story 18's. (Confirm the JWT lib at code time if Story 13 hasn't picked one — §13 A1.)

---

## 8. Seed Data

Extend the idempotent dev/test seed (Story 3/5/6/7/13). Seed only in non-production (guard on
`config.env`); upsert by stable key. Both fixtures presuppose a `MANUAL_ROUTED` event with an
`EditorAssignment` (Story 13's seed) — extend those rows into the upload/review states this story
exercises.

| Seed fixture | Setup | Exercises |
|---|---|---|
| **Assignment in `UPLOADED` (with a final video)** | A `MANUAL_ROUTED`/`FINAL_VIDEO_UPLOADED` event; `EditorAssignment` `status = UPLOADED`, `finalVideoPath = events/{id}/final/master.mp4`, `uploadedAt = now`, `editorNote = "Color-graded the outro per the brief."`, `uploadExpiresAt = deliveryDate + 7d`; one `FinalVideo` (`EDITOR_UPLOADED`/`MASTER`, real tiny valid MP4 uploaded to MinIO, `durationSec`/`sizeBytes` set) | the admin review panel (preview + Approve / Request Revision); the editor "awaiting review" state |
| **Assignment in `REVISION_REQUESTED`** | A second manual event; `EditorAssignment` `status = REVISION_REQUESTED`, `adminFeedback = "Please trim the first clip — it runs long before the title card."`, a prior `FinalVideo` master present, `uploadedAt` set | the editor revision state (shows requested changes + re-upload); the admin "waiting for editor" state; the revision-loop integration |
| *(optional)* **Assignment in `IN_PROGRESS`, delivery in ~47.5h** | `status = IN_PROGRESS`, `Event.deliveryDate = now + 47.5h`, no upload | the non-delivery 48h admin alert (§5.8) |
| *(optional)* **A corrupt/non-MP4 seed object** | a small text file or truncated MP4 at a `final/` test key | the ffprobe reject path locally (without crafting by hand) |

- The `UPLOADED` fixture's `final/master.mp4` must be a **real, ffprobe-parseable** tiny MP4 (a few
  seconds, H.264) so the admin preview and the validation path work locally — not a zero-byte
  placeholder (mirror `seq06-story09` §8's "genuinely valid" note).
- Seed the editor with a real-looking `editorName`/`editorEmail` (e.g. `editor@example.com`) so editor
  emails are observable in Mailpit.
- **Token for local testing:** provide a small dev helper to mint a valid `upload` JWT for a seeded
  assignment (reuse Story 13's signer) so a developer can open `/editor-portal/upload?token=…` without
  the real assignment email. **[CONFIRM]** add a dev script (mirrors `seq06-story09` §8's enqueue
  helper).
- Set `.env.example` `ADMIN_NOTIFY_EMAIL` to a Mailpit-visible address so notify-admin + non-delivery
  alerts are observable locally.

---

## 9. Testing

Follows the Story 1 pattern (Vitest, `tests/unit` + `tests/integration`, `vite-tsconfig-paths`).
DB/infra-touching tests are gated by **`SKIP_INTEGRATION`** so unit-only runs (and CI without
Docker/DB) stay green. ffprobe is fed **fixtures** in unit tests; email + storage are mocked in unit
tests and real (MinIO/Mailpit) in integration.

### 9.1 Unit tests (pure logic; no DB, no binaries, no network)

| Test | Asserts |
|---|---|
| **Upload-JWT verify — valid** | a well-formed `kind=upload` token with a future `exp`, correct sig, matching `event_id`/`assignment_id` → verified; returns claims |
| **JWT verify — expired → 410** | `exp` in the past → the verifier yields the **410/expired** outcome (not invalid-link); no assignment data returned |
| **JWT verify — wrong kind** | `kind=brief` (or other) → **invalid-link** outcome (not 410) |
| **JWT verify — bad signature / malformed** | tampered sig / garbage → **invalid-link**; never throws unhandled |
| **JWT verify — revoked** | `now > uploadExpiresAt` (revoke gate, §6.4) → **410** |
| **First-use IP/UA logging** | first verified use records IP/UA (audit marker); a later differing IP/UA emits a **warn** but still verifies (does not block — `architecture.md` §10.4) |
| **MP4 validation — accept** | a fixture probe result (MP4 family + H.264 video stream + duration > 0) → `isValidFinalMp4` returns `{ok:true, durationSec}` |
| **MP4 validation — reject not-MP4** | a probe result whose `format_name` is e.g. `matroska,webm` → `{ok:false, reasons:['not_mp4']}` |
| **MP4 validation — reject no video stream** | audio-only / no video stream → `{ok:false, reasons:['no_video_stream']}` |
| **MP4 validation — reject corrupt / zero duration** | parse failure / `duration = 0` → `{ok:false}` with the right reason; classified as a **verdict**, not an infra retry |
| **Extension-spoof defense** | a `.mp4`-named object whose probe says it's not MP4 → **rejected** (don't trust extension/MIME, §10) |
| **Status transition matrix** | each (`from`, action) → correct `to` per §5.4; illegal transitions (e.g. Approve on `ASSIGNED`, upload on `APPROVED`) → rejected/no-op |
| **Revision loop** | `UPLOADED → REVISION_REQUESTED` (notes required; empty notes rejected) → re-upload → `UPLOADED` (clears `adminFeedback`) |
| **Idempotent Approve** | Approve on already-`APPROVED` → no-op, **no** second handoff enqueue |
| **Key scoping** | `buildFinalKey(eventId)` always yields `events/{eventId}/final/master.mp4`; a client-supplied key/prefix is ignored/rejected (no traversal) |
| **Non-delivery window math** | `deliveryDate − now` at 48 / 47.5 / 47h with `status ∈ {ASSIGNED,IN_PROGRESS}` → alert due; with `status = UPLOADED` → not due |
| **Template rendering** | each template (§5.7) renders with sample vars: honoree name verbatim, correct occasion noun, the right link, **no exclamation mark**, "by Swara Media" footer; HTML + plaintext |
| **Admin authz (contract)** | the Approve / Request-revision handlers refuse without `requireAdmin` (non-admin → blocked, no mutation) |
| **Surprise integrity (contract)** | the editor-page view model never includes honoree/organizer contact or a share token; the honoree filter no-ops the editor recipient correctly |

> Keep `isValidFinalMp4(probeResult)` and the status-transition function **pure** so the rules are
> unit-tested without ffprobe binaries or a DB (ffprobe output fed as captured JSON fixtures).

### 9.2 Integration tests (DB + MinIO + Mailpit; `SKIP_INTEGRATION` gates)

| Test | Flow |
|---|---|
| **Presign → PUT → submit → ffprobe → UPLOADED (happy path)** | mint a valid `upload` token → call presign → PUT a real tiny MP4 to MinIO → call submit → assert `EditorAssignment.status = UPLOADED`, `finalVideoPath`/`uploadedAt`/`editorNote` set, one `FinalVideo` (`EDITOR_UPLOADED`/`MASTER`, `durationSec`/`sizeBytes`), `Event.status = FINAL_VIDEO_UPLOADED`, one admin notification captured |
| **Submit — invalid MP4 rejected** | PUT a non-MP4 / corrupt object → submit → assert **no** status change, no `FinalVideo`, an `editor.upload.invalid` email captured, an `AuditLog` `editor.upload.invalid` row |
| **Expired token → 410** | mint a token with past `exp` → GET the page / call presign → **410**, no assignment data |
| **Revoked token → 410** | set `uploadExpiresAt = now` → token use → **410** |
| **Approve handoff** | seeded `UPLOADED` → admin Approve → assert `status = APPROVED`, `AuditLog` `editor.upload.approved`, and the handoff jobs enqueued (assert on the queue / a captured enqueue); idempotent on re-Approve |
| **Request revision → re-upload loop** | seeded `UPLOADED` → admin Request Revision (notes) → assert `REVISION_REQUESTED` + `adminFeedback` + editor email → editor re-uploads valid MP4 → assert back to `UPLOADED`, `adminFeedback` cleared, admin re-notified |
| **Revision overwrites master (idempotent storage)** | re-upload → assert the same `final/master.mp4` key + the single `FinalVideo` row updated (no duplicate row) |
| **Admin preview presigned GET** | seeded `UPLOADED` → admin detail → a short-lived presigned GET for the master is generated and resolves; the signed URL is not logged verbatim |
| **Non-delivery alert** | seeded `IN_PROGRESS` with delivery in ~47.5h → run the sweep → one admin `editor.non_delivery.48h` notification; re-run → no duplicate |
| **Admin authz end-to-end** | organizer/unauth hitting the review action → blocked, no mutation |

> External boundaries mocked: only the **email transport** is via Mailpit (real local SMTP) and
> **storage** is real MinIO; ffprobe runs for real against tiny valid/invalid seeded objects (proves
> the wrapper), with a mockable probe interface for CI where FFmpeg isn't installed (mirror
> `seq06-story09` §9.3). The JWT signer is real (reused from Story 13).

### 9.3 Tests ↔ success-criteria mapping

- 410 on expiry/revoke → JWT-verify unit tests + the 410 integration tests.
- MP4 accept/reject (don't trust extension) → validation unit tests + the invalid-MP4 integration.
- Status transitions incl. revision loop → transition matrix unit + the revision-loop integration.
- Admin authz → the authz contract unit + the authz end-to-end integration.
- Presigned upload → ffprobe → status → the happy-path integration.

---

## 10. Security & Surprise Integrity

| Control | Design |
|---|---|
| **Upload JWT verified on every request** | The `upload` token is HMAC-verified with `EDITOR_TOKEN_SECRET` on every page render and every presign/submit call — no session (`architecture.md` §6.5, §10.4). The verifier checks signature, `kind=upload`, `exp`, and the assignment/event match before any data is returned. |
| **Expiry → 410 Gone** | A valid-but-expired token (`exp = delivery_date + 7d` passed) returns **410** with no assignment data (`architecture.md` §10.4). Unverifiable tokens return a generic invalid-link (404-style) so the failure reason isn't disclosed (anti-probing). |
| **Admin revoke** | An admin can revoke an assignment's upload access (recommended: set `uploadExpiresAt = now`, after which the §5.1 expiry check returns 410 — §6.4). `architecture.md` §10.4: "admin can revoke." |
| **IP/UA logged on first use** | First verified use records client IP + user-agent (audit, §11); a later differing IP/UA warns the admin but does **not** block (editors travel — `architecture.md` §10.4). |
| **MP4 type/corruption validation (don't trust the extension)** | Server-side **ffprobe** inspects the actual container/streams; a `.mp4`-named non-MP4 or corrupt file is rejected (`architecture.md` §10.3, §11.1). The browser `accept`/MIME and the presign `Content-Type` pin are convenience/defense-in-depth only — ffprobe is authoritative. |
| **Key scoping (no traversal / cross-event write)** | `buildFinalKey` derives the `events/{eventId}/final/…` prefix from the **token's** `event_id`; any client-supplied key/prefix is ignored. The presigned target is single-key, short-expiry, size- and content-type-pinned (§5.2). |
| **Bytes never transit the app server** | Direct-to-storage presigned PUT (upload) + presigned GET (admin preview); the Vercel function never proxies the large master (`architecture.md` §6.5/§6.2). |
| **No editor accounts** | Editors interact only via the signed link (`requirements.md` §2/§9; `architecture.md` §10.2). The page has no login, no session, no link into the rest of the app. |
| **No honoree exposure** | The editor page shows the honoree **name** + occasion (needed for the work, present in the brief) but **never** a honoree contact, organizer contact, contributor PII, or any share token. `noindex, nofollow` + `Referrer-Policy: no-referrer` so the signed URL doesn't leak. The honoree filter (Story 18) guards every notification (the editor is never the honoree, but the filter is unconditional). |
| **Signed URLs never logged** | Presigned PUT/GET query strings are redacted in logs (log `/events/{id}/final/master.mp4`, not the signed string) — mirrors `architecture.md` §10.1 #3 token-redaction posture. |
| **Admin-only review actions** | Approve / Request-revision / preview are behind `requireAdmin` (Story 7) — every action re-checks the role server-side, never trusting the client. |
| **Notes are stored data, not executed** | `editorNote` / `adminFeedback` are length-capped plain text; rendered with standard escaping in the admin UI + emails (no HTML injection). |
| **Virus scanning** | ClamAV scan of the uploaded master is **deferred** (same posture as Story 6) — flagged §13 Q7. ffprobe-validation is not a malware check; note this gap. |

---

## 11. Observability / Audit

| Layer | What we capture | Where |
|---|---|---|
| **AuditLog (the canonical record)** | `editor.link.first_use` (IP/UA on first token use), `editor.upload.received` (`{assignmentId, storageKey, sizeBytes, durationSec, isRevision}`), `editor.upload.invalid` (`{reason}`), `editor.upload.approved` (`{actorId=admin, finalVideoId}`), `editor.upload.revision_requested` (`{actorId=admin, feedback}`) | `AuditLog` (Story 8); these rows also **drive the admin revision-history timeline**, §4.3/§6.4 |
| **NotificationLog** | every notify-admin (`editor.upload.received`), editor-invalid (`editor.upload.invalid`), editor-revision (`editor.upload.revision_requested`), and the non-delivery admin alert (`editor.non_delivery.48h`) — each with `recipientType` (`admin`/`editor`), `status` (`sent`/`failed`/`suppressed_surprise`), `sentAt`; **the dedupe store** (§5.9) | `NotificationLog` (Story 18) |
| **Structured logs** | presign issued (`eventId`, `assignmentId`, `storageKey` — **no** signed query string), submit received, ffprobe verdict (valid/invalid + reason), token verify outcome (verified/expired/invalid/revoked), IP/UA-mismatch warn, handoff enqueued (`jobIds`) | Story 1 `logger` (pino) |
| **Metrics (counters; OTel wiring later)** | upload-received count, **invalid-MP4 reject rate** (a spike = editor export guidance needed), approve vs revision-request ratio (editing quality signal), **non-delivery-alert count** (`architecture.md` §11.1 metric — editors missing dates), token-expired-hit count | App-level counters → Honeycomb/Axiom later (`architecture.md` §13) |
| **Critical alert** | a honoree-suppression event on any of these sends (should never happen for editor/admin recipients, but the unconditional filter + alert stays — `architecture.md` §13) | admin alert |

- **Non-delivery alert as a tracked metric** (`architecture.md` §11.1): each `editor.non_delivery.48h`
  fire is both a `NotificationLog` row and a counter, so ops can see how often editors are at risk of
  missing the delivery date.
- **`recipientEmail` redaction** in non-prod logs (hash), per `architecture.md` §7.1 / Story 18 §10.

---

## 12. Definition of Done

- [ ] `/editor-portal/upload?token=…` renders the assignment summary + MP4-only upload UI **only**
      for a valid, unexpired, non-revoked `upload` JWT; the token is verified on every request.
- [ ] Expired/revoked token → **410 Gone** (no assignment data); unverifiable token → generic
      invalid-link; IP/UA logged on first use; IP/UA mismatch warns but does not block.
- [ ] The editor uploads an MP4 via a `final/`-scoped presigned target (bytes never transit the app
      server); client + presign + server all enforce MP4-only and the size cap.
- [ ] Submit runs **server-side ffprobe validation**: a real MP4 (with a video stream, duration > 0)
      is accepted; a non-MP4 / corrupt / extension-spoofed file is rejected and the editor is notified.
- [ ] On accept: `EditorAssignment.finalVideoPath`/`uploadedAt`/`editorNote` set, `status = UPLOADED`,
      one `FinalVideo` (`EDITOR_UPLOADED`/`MASTER`) upserted, `Event.status = FINAL_VIDEO_UPLOADED`,
      exactly one notify-admin (deduped).
- [ ] Admin event detail shows the uploaded video (presigned GET preview) with **Approve** and
      **Request Revision** (notes required) + a revision-history timeline; behind `requireAdmin`.
- [ ] Approve → `status = APPROVED` + audit + the **handoff enqueue** (encode [Story 17] + share page
      / organizer notify [Story 15]); idempotent (no double-enqueue); admin-only.
- [ ] Request Revision → `status = REVISION_REQUESTED` + `adminFeedback` + editor notify; the editor
      re-uploads against the same assignment/token → back to `UPLOADED` (feedback cleared); admin
      re-notified.
- [ ] Non-delivery admin alert fires once at `delivery_date − 48h` when no upload landed.
- [ ] Schema: `FinalVideo` model + `VideoSource`/`VideoVariant` enums + `Event.finalVideos`
      back-relation added via an **additive** migration; `EditorAssignment` fields written correctly;
      `prisma generate` + `typecheck` clean.
- [ ] Config: `EDITOR_TOKEN_SECRET` reused from Story 13; new vars (`FINAL_VIDEO_MAX_BYTES`, presign
      expiry) in **both** config files + `.env.example`; no `process.env` outside `src/config/env.ts`.
- [ ] All editor/admin notifications ride the Story 18 dispatcher (honoree filter + dedupe); no new
      dispatch plumbing.
- [ ] AuditLog + NotificationLog rows written per §11; non-delivery metric counted.
- [ ] Seed creates an `UPLOADED` assignment (with a valid `FinalVideo`) and a `REVISION_REQUESTED`
      assignment; a dev token-mint helper exists.
- [ ] Unit + integration tests (§9) pass; integration tests skip cleanly under `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; deploys.

---

## 13. Open Questions / Assumptions

**Assumptions (proceeding unless corrected):**

- **A1 — Story 13 owns `EditorAssignment` + the editor JWT + the `upload` token.** Its design doc is
  not yet in the repo; this story takes the model/claims/secret from `architecture.md` §6.5/§7.1/§10.4
  and **consumes** them. If Story 13 lands first with different claim names, route prefix
  (`/editor-portal`), config keys (`EDITOR_TOKEN_*`), or a JWT helper, reconcile §5.1/§6.1/§7 before
  generating code. If Story 13 has **not** landed when this story is built, this story must add the
  `EditorAssignment` model + `EDITOR_TOKEN_SECRET` per the architecture and clearly mark Story 13
  ownership.
- **A2 — token in a query param** `?token=…` on `/editor-portal/upload` (a signed link), verified
  server-side every request. (Path-segment is the alternative; Story 13's email link shape decides.)
- **A3 — 410 vs invalid-link split:** *valid-but-expired/revoked* → **410**; *unverifiable* → generic
  **404/invalid-link** (anti-probing). Confirm exact codes with Story 13's link UX.
- **A4 — replace-before-review allowed:** while `status = UPLOADED` (not yet reviewed), the editor may
  re-upload to fix a mistake (overwrites the master, re-notifies admin). Disable if the team prefers
  "one upload until the admin acts."
- **A5 — overwrite the master key** on every (re)upload (`events/{id}/final/master.mp4`); history is
  in `AuditLog`, not in retained per-attempt files.

**Open questions (need a decision):**

- **Q1 — max final-video size + presign expiry + multipart.** What is `FINAL_VIDEO_MAX_BYTES`
  (proposed 5 GB) and the `final/` presign expiry (15 min vs 1 h for large masters on slow links)?
  Single-part PUT/POST has a practical ceiling; if masters routinely exceed it, **multipart/resumable
  upload** is needed (deferred from MVP 1 — §2). Decide the cap and whether multipart is required now.
- **Q2 — `FinalVideo` uniqueness / overwrite vs versioned filename.** Recommend
  `@@unique([eventId, source, variant])` + overwrite the `master.mp4` key (idempotent, one master).
  Alternative: versioned filenames (`master_{n}.mp4`) + append rows + "latest wins". Confirm.
- **Q3 — revision history source.** Recommend deriving the admin revision-history timeline from
  `AuditLog` (no new table). Add a `FinalVideoRevision` table only if every uploaded master file must
  be retained (we currently overwrite). Confirm.
- **Q4 — re-upload while `UPLOADED` (= A4).** Allow replace-before-review, or lock until the admin
  acts? Affects the §5.4 transition `UPLOADED → UPLOADED`.
- **Q5 — Approve reversibility.** Recommend Approve is **not** reversible once the handoff is enqueued
  (encode + delivery start). Confirm there is no "un-approve."
- **Q6 — revoke mechanism.** Recommend "revoke = set `uploadExpiresAt = now`" (no new column). Or add
  an explicit `revokedAt` / `REVOKED` status. Owned jointly with Story 13 (the model owner).
- **Q7 — ClamAV virus scan** of the uploaded master. Deferred (Story 6 posture). Decide whether to
  add a scan job before/after ffprobe, especially since the master is later served to the organizer.
- **Q8 — clear `adminFeedback` on re-upload.** Recommend clearing stale revision notes when a fresh
  valid upload arrives (so the admin reviews the new file cleanly). Confirm.
- **Q9 — validation queue.** Reuse the `quality` worker pool (already has FFmpeg + `probeMedia`) or add
  a dedicated `editor` queue? Recommend reuse (or a tiny dedicated queue if separation is preferred).
- **Q10 — re-upload reuses the same JWT.** Recommend the editor re-uploads with the **same** `upload`
  token (valid until `delivery_date + 7d`); no new token per revision. Confirm (vs Story 13 issuing a
  fresh token on each revision request).
- **Q11 — event status on Approve.** Recommend leaving `Event.status` at `FINAL_VIDEO_UPLOADED` on
  Approve and letting **Story 15** drive `IN_REVIEW → DELIVERED`. Or introduce an `APPROVED`/
  `DELIVERING` event state here. Confirm with Story 15.
- **Q12 — handoff shape:** enqueue three jobs (encode + share-page + organizer-notify) directly, or a
  single **`delivery.start`** orchestrator that Story 15 fans out? Recommend the single seam job to
  minimize this story's coupling. Confirm with Story 15/17.
- **Q13 — Approve coordination when both AI + manual masters exist.** For MVP 1 a `MANUAL_ROUTED`
  event has only the editor master; the `FinalVideo.source` discriminator lets delivery select it. If
  an event ever has both an `AI_GENERATED` and an `EDITOR_UPLOADED` master, define which one Approve
  promotes to delivery (recommend: the approved editor master wins on the manual route). Confirm the
  selection rule with Story 15/16/17.
- **Q14 — non-delivery alert scheduler.** Recommend extending the Story 18 hourly `reminders.sweep`
  with a manual-assignment pass (one scheduler) rather than a new cron. Confirm.
- **Q15 — allowed video codecs for validation rule 3.** Recommend require a video stream and accept
  H.264 (strong) / HEVC / AV1; reject audio-only. Confirm the exact codec allowlist and whether to
  hard-reject non-1080p / non-landscape masters (recommend warn-not-reject in MVP 1).
