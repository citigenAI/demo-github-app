# Sequence 05 / Story 6 — Media Uploads (Video / Voice / Photo)

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (field names, types, payload shapes, key templates, validation rules, error
cases) so later code generation is unambiguous. Where a value is a proposal awaiting
confirmation it is flagged **[CONFIRM]**.

| Field | Value |
|---|---|
| Story number / title | Story 6 — Media uploads (video/voice/photo) |
| Epic | C — Submission Collection |
| Sequence number | 5 (this is the 5th design in build order) |
| Depends on | Story 5 (Contributor text-only submission — the `/contribute/[slug]` form + `Submission` model) |
| Parallel with | Story 7 (Admin dashboard — read-only) |
| Unlocks | Story 9 (Workers + quality scoring), Story 18 (Reminders) |
| Complexity | M (1–3 days) |

> **Note on Story 5 source.** `docs/design/seq04-story05-contributor-text-submission.md`
> does not yet exist in the repo. This document therefore takes the canonical
> `Submission` model and `/contribute/[slug]` form behavior from `architecture.md` §6.2,
> §7.1 and `requirements.md` §5.2/§5.3, and is written to extend that consistently. If the
> Story 5 design lands first and diverges, reconcile field names against it before
> generating code (see §13 Open Questions).

---

## 1. Story Summary

Story 5 gives contributors a public form at `/contribute/[slug]` that accepts name,
relationship, text fields, and consent — text-only. Story 6 adds the ability for a
contributor to attach **any combination of video, voice, and photo files** to that same
submission, with **multiple files allowed per type**.

Files never pass through the application server. The browser requests a **presigned upload
URL** (scoped to the event) per file, uploads the bytes **directly to object storage**
(MinIO locally, Cloudflare R2 in production), and only then submits the form. On submit,
the server **verifies each uploaded object actually exists in storage** and **re-validates
its MIME type** before persisting one `MediaItem` row per file. This prevents orphan DB
rows pointing at abandoned uploads and prevents the browser from lying about file type.

The "at least one media item OR one text field" rule from `requirements.md` §5.2 — which
in Story 5 could only be satisfied by text — becomes satisfiable by media in this story.

AI/quality processing (transcription, quality scoring, dimension/duration extraction) is
**out of scope** here; the nullable `MediaItem` columns those steps fill are added now but
left null until Story 9+.

---

## 2. Scope

### In scope

- **Direct-to-storage presigned uploads.** A server route that mints a short-lived,
  per-file, event-scoped presigned upload target. Browser uploads bytes directly.
- **Multiple media items per submission**, any combination of VIDEO / VOICE / PHOTO.
- **Per-file metadata persisted** as `MediaItem` rows (one row per uploaded file).
- **Verify-before-save**: server confirms each object exists in storage before insert.
- **Server-side MIME re-validation** against the allowlist (do not trust the browser).
- **Client-side pre-validation** (type + size) and upload UX (progress, retry, remove,
  max 3 concurrent uploads).
- New `MediaItem` model + `MediaType` enum in Prisma schema (migration).
- `S3_*` storage config wired through `src/config/env.ts` + `src/config/index.ts`.
- Storage service behind a clean interface (MinIO dev / R2 prod swap via config).
- Seed data: sample `MediaItem` rows pointing at seeded/dummy objects.

### Out of scope (deferred)

| Item | Where it lands |
|---|---|
| Quality scoring (FFprobe blur/audio/resolution) → fills `qualityScore`, `qualityFlags` | Story 9 |
| Transcription (Whisper) | Story 10 |
| Duration / width / height extraction → fills `duration`, `width`, `height` | Story 9 |
| ClamAV virus scan / quarantine | Deferred (background job; noted in §7, §10) |
| Admin viewing/downloading media (presigned GET) | Story 7 |
| Multipart / chunked upload for very large files | Deferred — single-part presigned PUT/POST per file in MVP 1 (see §13) |
| Editing/replacing media after submit | Out of MVP 1 (one submission per email; right-to-delete is Story 20) |

---

## 3. Dependencies & Sequence

**Must already be on `main`:**

- Story 1 — config module (`src/config`), `db` client, `logger`, worker scaffold, CI.
- Story 3 — `Event` model with `slug`, `status`, `submissionDeadline`.
- Story 5 — `Submission` model, `/contribute/[slug]` page + submit action, deadline
  enforcement, one-submission-per-email rule, consent capture.

**Provides to later stories:**

- `MediaItem` rows for Story 7 (admin sees "files submitted") and Story 9 (quality job
  iterates over media items; storagePath tells the worker which object to fetch).
- The storage service interface, reused by every later story that touches object storage
  (briefs, final videos, artifacts).

**Sequencing note:** Story 6 depends on Story 5 and runs in parallel with Story 7. Because
Story 7 reads `MediaItem` for display, the `MediaItem` schema in this story is the
contract Story 7 consumes; finalize §6 before Story 7 starts its detail view.

---

## 4. Frontend / UI Design

Extends the existing `/contribute/[slug]` form (Story 5). All copy follows
`branding.md` §3/§10 (calm, no exclamation marks, sentence-case buttons).

### 4.1 New form region: "Add photos, video, or voice"

Inserted between the text fields and the consent checkbox. Three pickers, each accepting
multiple files:

| Picker | Label | `accept` attribute (hint only) | Multiple |
|---|---|---|---|
| Video | "Video wishes" | `video/mp4,video/quicktime,.mp4,.mov` | yes |
| Voice | "Voice messages" | `audio/mpeg,audio/mp4,.mp3,.m4a` | yes |
| Photos | "Photos" | `image/jpeg,image/png,.jpg,.jpeg,.png` | yes |

> The HTML `accept` attribute is a UX convenience only; it is **not** trusted for
> validation. Real validation happens in §4.3 (client) and §5.4 (server).

For business occasion types the surrounding labels adapt per `requirements.md` §5.2
(e.g., "Relationship" → "Role / Connection"); the media picker labels themselves do not
change.

### 4.2 Selected-file list (per file row)

Each chosen file appears as a row showing:

- File name (truncated), human-readable size, detected type icon (Lucide, per
  `branding.md` §8).
- A per-file status badge (see §4.5 states).
- A progress bar (0–100%) while uploading.
- A **Remove** control (removes from the list; if already uploaded, also issues a
  best-effort client abort — server-side cleanup of abandoned objects is handled by
  not-persisting, see §5.3).
- A **Retry** control, shown only in the `error` state.

### 4.3 Client-side pre-validation (before any upload starts)

Runs on file selection. A file failing any check is rejected inline with a clear message
and is **not** added to the upload queue.

| Check | Rule | Error message (example) |
|---|---|---|
| Type allowlist | Extension AND browser-reported MIME both within the type's allowlist (§10) | "JPG, PNG, MP4, MOV, MP3, or M4A only." |
| Per-file size | ≤ the per-type limit in §10 **[CONFIRM]** | "Videos must be under 500 MB." |
| Per-submission total count | ≤ `MAX_FILES_PER_SUBMISSION` **[CONFIRM: 30]** | "You can attach up to 30 files." |
| Per-submission total size | ≤ `MAX_TOTAL_BYTES_PER_SUBMISSION` **[CONFIRM: 1 GB]** | "Total attachments must be under 1 GB." |
| Duplicate | Same name + size already in list | "That file is already added." |

Client validation is advisory UX; the server repeats every limit in §5.

### 4.4 Upload orchestration

- **Max 3 concurrent uploads** (`architecture.md` §12 — client limited to ~3 parallel
  uploads). A simple queue: at most 3 in `uploading`, the rest `queued`.
- For each file the client: (1) calls the presign route (§5.1) to get an upload target +
  final `storageKey`, (2) uploads bytes directly to storage with progress events,
  (3) marks the file `uploaded` and stores the returned `storageKey` + server-assigned
  `mediaId` locally.
- The **Submit** button is enabled only when the form passes the cross-field rule (§4.6)
  AND every queued/uploading file has reached a terminal state (`uploaded` or removed).
  Files in `error` block submit until retried or removed.

### 4.5 Per-file states

```
idle → queued → uploading → uploaded
                   │
                   └─→ error → (retry) → queued
removed (terminal; row disappears)
```

| State | Meaning | UI |
|---|---|---|
| `queued` | Selected, waiting for a concurrency slot | Spinner-less "Waiting" |
| `uploading` | Bytes transferring | Progress bar 0–100% |
| `uploaded` | Object confirmed PUT to storage | Check icon; `storageKey` held client-side |
| `error` | Presign failed, upload failed, or aborted | Red text + Retry |
| `removed` | User removed it | Row gone |

### 4.6 Cross-field "at least one of" rule (now media-satisfiable)

The submission is valid when **at least one** of the following is non-empty:

- any text field (`textMessage`, `funnyMemory`, `advice`, `professionalNote`), OR
- at least one media file in `uploaded` state.

Consent checkbox remains **mandatory** regardless (`requirements.md` §5.2). If neither
media nor text is present, show the existing Story 5 message: "Add a message or at least
one photo, video, or voice note before submitting."

### 4.7 Deadline & closed-form behavior

If the event deadline has passed (Story 5 logic), the entire form — including the new
media pickers — is closed/disabled. The presign route also enforces the deadline
server-side (§5.1) so a stale open tab cannot upload after close.

---

## 5. Backend / API Design

Two server surfaces: (A) a **presign route** that issues per-file upload targets, and
(B) the **submit step** (extends Story 5's submit action) that verifies + persists
`MediaItem` rows.

### 5.1 Presign route

| Property | Value |
|---|---|
| Path | `POST /api/contribute/[slug]/uploads/presign` |
| Auth | Public (anonymous contributor), same access model as the form |
| Rate limit | Per-IP, reuse Story 5's contributor limiter; cap presign calls per IP/event |

**Why a server route mints these:** the storage credentials never reach the browser, the
key is forced into the event's prefix server-side (the client cannot choose an arbitrary
key), and the deadline + allowlist + size limits are enforced before any byte is accepted.

#### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `fileType` | enum `VIDEO` \| `VOICE` \| `PHOTO` | yes | Determines allowlist + size limit + extension |
| `mimeType` | string | yes | Browser-reported; validated against allowlist for `fileType` |
| `originalName` | string | yes | For metadata + extension derivation; sanitized server-side |
| `sizeBytes` | integer | yes | Declared size; validated against per-type limit |

The route does **not** accept a `storageKey` from the client — the server generates it.
The route resolves the event from `slug` and derives the submission scope (see §5.1.1).

#### Submission-scoping the key (the `submission_id` question)

The storage key template is
`events/{event_id}/submissions/{submission_id}/media/{media_id}.{ext}` (`architecture.md`
§7.2). But presign happens **before** the `Submission` row is created (the submission row
is written on final submit, after files exist). Resolution:

- The client generates a **client-side draft submission id** (a CUID/UUID) once when the
  form mounts, and sends it implicitly via the upload session (see below). The server
  uses this as `{submission_id}` in the key so all of one contributor's files share a
  prefix.
- The server generates `{media_id}` (a CUID) per presign call — this becomes the
  `MediaItem.id` later, guaranteeing the storage key and the eventual DB row id match.
- On final submit, the `Submission` is created **with that same draft id** as its primary
  key, so the persisted `storagePath` already matches the row hierarchy. (Decision flagged
  in §13 — alternative is a server-side rebind of keys on submit, which we reject as more
  complex.)

> **[CONFIRM]** Using a client-supplied draft submission id as the eventual
> `Submission.id`. It is unguessable (CUID) and scoped under the event prefix, but a
> client could send two different draft ids; the submit step binds to whatever ids the
> submitted `mediaItems[]` actually reference (§5.3), so mismatches simply fail
> verification. Acceptable.

#### Response body (success, `200`)

| Field | Type | Notes |
|---|---|---|
| `mediaId` | string (cuid) | Server-assigned; becomes `MediaItem.id` |
| `storageKey` | string | Final key, e.g. `events/evt_abc/submissions/sub_xyz/media/med_123.mp4` |
| `upload` | object | The presigned upload instruction (see §7.2 for POST vs PUT) |
| `upload.method` | `"PUT"` \| `"POST"` | **[CONFIRM]** — recommend `PUT` (simpler); §13 |
| `upload.url` | string | Presigned URL the browser uploads to |
| `upload.headers` | object (PUT) | Headers the browser MUST send (e.g., `Content-Type`) |
| `upload.fields` | object (POST) | Form fields for multipart POST (only if method=POST) |
| `expiresInSeconds` | integer | `900` (15 minutes, per `architecture.md` §7.2) |

#### Presign route status codes & errors

| Status | Condition | Body shape |
|---|---|---|
| `200` | Presigned target issued | success body above |
| `400` | Missing/invalid field, `mimeType` not in allowlist for `fileType`, `sizeBytes` ≤ 0 | `{ error: "INVALID_REQUEST", message }` |
| `403` | Event not in an accepting state | `{ error: "DEADLINE_PASSED" }` or `{ error: "EVENT_NOT_ACCEPTING" }` |
| `404` | No event for `slug` | `{ error: "EVENT_NOT_FOUND" }` |
| `409` | This email already submitted to this event (if known at presign time) | `{ error: "ALREADY_SUBMITTED" }` |
| `413` | `sizeBytes` exceeds the per-type limit | `{ error: "FILE_TOO_LARGE", limitBytes }` |
| `415` | `mimeType`/extension not allowed for `fileType` | `{ error: "UNSUPPORTED_MEDIA_TYPE" }` |
| `429` | Rate limit exceeded | `{ error: "RATE_LIMITED" }` |

Server-side enforcement at presign time: deadline (re-checked against
`Event.submissionDeadline`), allowlist, size limit, per-submission count cap. The
presigned URL itself **also** constrains `Content-Type` and (for POST) max content length,
so storage rejects a mismatched upload even if the route were bypassed.

### 5.2 Direct upload (browser → storage)

Not an app route — the browser uploads directly using `upload.url`. The app server never
sees the bytes (`architecture.md` §6.2). Storage enforces the presigned constraints
(key, content-type, expiry, and for POST the content-length range). On success the browser
gets a `200`/`204` from storage and marks the file `uploaded`.

### 5.3 Submit step — verify-before-save (extends Story 5 submit action)

The Story 5 submit action gains a `mediaItems[]` payload. The whole submit runs in a
single DB transaction; storage verification happens **before** the transaction commits.

#### Submit payload addition

`mediaItems[]` — array, each element:

| Field | Type | Required | Notes |
|---|---|---|---|
| `mediaId` | string | yes | Must equal the `mediaId` the presign route returned |
| `storageKey` | string | yes | Must equal the `storageKey` the presign route returned |
| `type` | enum VIDEO/VOICE/PHOTO | yes | |
| `originalName` | string | yes | |
| `sizeBytes` | integer | yes | Declared; reconciled against storage `Content-Length` |
| `mimeType` | string | yes | Re-validated server-side (§5.4) |

#### Verify-before-save algorithm (per the architecture's "verify files exist" gate)

For the submission to persist, **every** element of `mediaItems[]` must pass:

1. **Key shape check.** `storageKey` matches the template
   `events/{eventId}/submissions/{submissionId}/media/{mediaId}.{ext}` for the resolved
   event and the draft submission id, and `mediaId` matches the embedded id. Reject
   foreign/odd keys (prevents a client pointing at someone else's object).
2. **Existence + metadata check (HEAD).** A `headObject` on `storageKey` succeeds; capture
   the storage-reported `ContentType` and `ContentLength`.
3. **MIME re-validation (§5.4).** The storage-reported content type (and the key
   extension) is in the allowlist for `type`.
4. **Size reconciliation.** Storage `ContentLength` ≤ the per-type limit and within a
   tolerance of declared `sizeBytes`.

If **any** file fails, the **entire submission is rejected** and **no rows are written**
(transaction rolls back) — partial submissions are not allowed. The contributor sees which
file(s) failed and can retry/remove. Objects that were uploaded but never persisted are
**orphans by design** and are reaped by a storage lifecycle rule / future sweep (§11) —
they cost storage but never produce a dangling DB row, which is the invariant
`architecture.md` §6.2 demands.

After verification passes, within the transaction:

- Create the `Submission` (Story 5 fields) using the draft submission id as `id`.
- Create one `MediaItem` per element, copying `type`, `storageKey` → `storagePath`,
  `originalName`, `sizeBytes` (use the **storage-reported** length, authoritative),
  `mimeType` (use the **storage-reported** content type, authoritative).
- Enforce the cross-field rule server-side: reject with `422` if there are zero media
  items AND all text fields are empty.

#### Submit status codes & errors (media-specific additions to Story 5)

| Status | Condition | Body |
|---|---|---|
| `200/201` | Submission + media persisted | success (thank-you redirect) |
| `409` | One submission per email already exists | `{ error: "ALREADY_SUBMITTED" }` |
| `422` | Cross-field rule fails (no media, no text) | `{ error: "EMPTY_SUBMISSION" }` |
| `422` | Consent not given | `{ error: "CONSENT_REQUIRED" }` |
| `422` | A referenced object missing in storage | `{ error: "MEDIA_NOT_FOUND", mediaId }` |
| `422` | A referenced object failed MIME re-validation | `{ error: "MEDIA_TYPE_REJECTED", mediaId }` |
| `413` | A referenced object exceeds size limit | `{ error: "MEDIA_TOO_LARGE", mediaId }` |
| `403` | Deadline passed between presign and submit | `{ error: "DEADLINE_PASSED" }` |

### 5.4 Server-side MIME validation rules

- **Never trust the browser-reported `mimeType`.** At submit, authoritative type comes
  from the storage `headObject` `ContentType` plus the key's file extension.
- A file is accepted only if **both** the storage content-type **and** the extension are
  in the allowlist for its declared `type` (§10). Mismatch (e.g., type=PHOTO but
  content-type `video/mp4`) → reject that file.
- **[CONFIRM]** Whether to additionally sniff magic bytes (file signature) in MVP 1. The
  presigned URL pins `Content-Type` so storage already rejects a mismatched declared type;
  deep content sniffing and AV scanning are deferred to the ClamAV background job
  (`architecture.md` §10.3). Recommendation: rely on content-type + extension allowlist in
  Story 6; add signature/ClamAV in the quality/scan worker.

---

## 6. Database Design

Adds the `MediaItem` model and `MediaType` enum. The `Submission` model and its
`mediaItems MediaItem[]` back-relation are introduced by Story 5; Story 6 adds the owning
side of the relation. These field names and types mirror `architecture.md` §7.1 exactly so
no later story has to rename them.

### 6.1 `MediaItem` fields

| Field | Type | Null? | Default | Filled by | Notes |
|---|---|---|---|---|---|
| `id` | String (cuid) | no | `cuid()` | Story 6 | Equals the `mediaId` from presign; equals `{media_id}` in the storage key |
| `submissionId` | String | no | — | Story 6 | FK → `Submission.id`, **`onDelete: Cascade`** |
| `submission` | relation | — | — | — | `@relation(fields: [submissionId], references: [id], onDelete: Cascade)` |
| `type` | `MediaType` | no | — | Story 6 | VIDEO \| VOICE \| PHOTO |
| `storagePath` | String | no | — | Story 6 | The object key, e.g. `events/{eventId}/submissions/{submissionId}/media/{id}.mp4` |
| `originalName` | String | no | — | Story 6 | Sanitized original filename |
| `sizeBytes` | Int | no | — | Story 6 | Authoritative storage `ContentLength` |
| `mimeType` | String | no | — | Story 6 | Authoritative storage `ContentType` |
| `qualityScore` | Float | **yes** | null | Story 9 | 0–100 composite; null until scored |
| `qualityFlags` | String[] | yes (empty) | `[]` | Story 9 | e.g. `["low_audio","blurry","portrait"]` |
| `duration` | Int | **yes** | null | Story 9 | Seconds (audio/video only) |
| `width` | Int | **yes** | null | Story 9 | Pixels (video/photo only) |
| `height` | Int | **yes** | null | Story 9 | Pixels (video/photo only) |
| `uploadedAt` | DateTime | no | `now()` | Story 6 | |

> **`Int` vs `BigInt` for `sizeBytes`:** a Postgres `Int` (signed 32-bit) maxes at
> ~2.1 GB. With the proposed 500 MB video cap this is safe. If any per-type limit is ever
> raised above ~2 GB, switch to `BigInt`. **[CONFIRM]** keep `Int` given §10 limits.

### 6.2 Enum

```
enum MediaType { VIDEO VOICE PHOTO }
```

### 6.3 Indexes

| Index | Reason |
|---|---|
| `@@index([submissionId])` | Story 7 admin detail + Story 9 worker both fetch all media for a submission |
| (optional) `@@index([type])` | Only if Story 12 analyzer queries media by type at scale; **[CONFIRM]** — defer unless needed |

### 6.4 Migration notes

- Migration name: `add_media_item` (e.g. `<timestamp>_add_media_item`).
- Additive only — creates the `media_item` table + `MediaType` enum + FK to `submission`.
  No backfill (no existing media rows). Safe to `prisma migrate deploy` against
  `swara_prd`.
- The `onDelete: Cascade` ensures Story 20 (right to delete) and retention sweeps remove
  media rows when a submission/event is deleted; the **object files** are removed
  separately by the storage cleanup in those stories — deleting the DB row does not delete
  the S3 object.
- Run `prisma generate` after migrate so `MediaItem` types are available to web + workers.

---

## 7. External Services / Integrations / Config

### 7.1 Storage config (`S3_*`) — wire through BOTH config files

Story 1 left `src/config/env.ts` and `src/config/index.ts` minimal (NODE_ENV,
DATABASE_URL, REDIS_URL, NEXT_PUBLIC_APP_URL). Story 6 **must add the storage block in
BOTH places** — this is the load-bearing convention from `development-setup.md` §7.

**Add to `src/config/env.ts`** (the only file allowed to read `process.env`):

| Raw key | Source env var |
|---|---|
| `S3_ENDPOINT` | `process.env.S3_ENDPOINT` |
| `S3_BUCKET` | `process.env.S3_BUCKET` |
| `S3_REGION` | `process.env.S3_REGION` |
| `S3_ACCESS_KEY_ID` | `process.env.S3_ACCESS_KEY_ID` |
| `S3_SECRET_ACCESS_KEY` | `process.env.S3_SECRET_ACCESS_KEY` |
| `S3_FORCE_PATH_STYLE` | `process.env.S3_FORCE_PATH_STYLE` |

**Add to `src/config/index.ts`** — a `storage` object on the Zod schema (matching the
shape already documented in `development-setup.md` §7):

| Config field | Type | Mapping |
|---|---|---|
| `storage.endpoint` | `z.string().url()` | `rawEnv.S3_ENDPOINT` |
| `storage.bucket` | `z.string()` | `rawEnv.S3_BUCKET` |
| `storage.region` | `z.string()` | `rawEnv.S3_REGION` |
| `storage.accessKeyId` | `z.string()` | `rawEnv.S3_ACCESS_KEY_ID` |
| `storage.secretAccessKey` | `z.string()` | `rawEnv.S3_SECRET_ACCESS_KEY` |
| `storage.forcePathStyle` | `z.boolean()` | `rawEnv.S3_FORCE_PATH_STYLE === 'true'` |

> No code outside `src/config/` may read `process.env` (enforced by the
> `no-restricted-syntax` lint rule from Story 1). The storage service reads
> `config.storage`, never `process.env`.

Local dev values (already in `.env.example`, `development-setup.md` §7):

```
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=swara-magical
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=swara
S3_SECRET_ACCESS_KEY=swara_dev_secret
S3_FORCE_PATH_STYLE=true        # true for MinIO, false for R2
```

Production (R2): `S3_ENDPOINT` = R2 endpoint, `S3_FORCE_PATH_STYLE=false`, bucket
`swara-magical-prod`, scoped API token. Test env uses `S3_BUCKET=swara-magical-test`.

### 7.2 Storage service (clean interface, MinIO/R2 swap)

A single storage module is the only thing that talks to the S3 SDK. Everything else calls
its methods. This is the seam that lets MinIO (dev) and R2 (prod) swap purely via config
(`forcePathStyle` toggles path-style vs virtual-host addressing; AWS SDK v3
`S3Client`/`@aws-sdk/s3-request-presigner` works against both).

Interface (capabilities for this story; signatures finalized at code time):

| Capability | Purpose | Used by |
|---|---|---|
| `buildMediaKey(eventId, submissionId, mediaId, ext)` | Compute the canonical key | presign route |
| `createUploadTarget({ key, contentType, maxBytes, expiresIn })` | Mint presigned PUT (or POST) | presign route |
| `headObject(key)` → `{ exists, contentType, contentLength }` | Verify-before-save | submit step |
| `objectExists(key)` → boolean | Convenience over `headObject` | submit step / tests |

All objects are written with **private ACL** (`architecture.md` §7.2 — all paths private).
Presigned upload expiry is **900s (15 min)**.

### 7.3 Storage key layout (from `architecture.md` §7.2)

```
swara-magical/                                  (bucket)
  events/{event_id}/
    submissions/{submission_id}/
      media/
        {media_id}.mp4      # VIDEO
        {media_id}.mov      # VIDEO
        {media_id}.mp3      # VOICE
        {media_id}.m4a      # VOICE
        {media_id}.jpg      # PHOTO
        {media_id}.png      # PHOTO
```

`{ext}` is derived **server-side** from the validated content type / declared type, not
copied verbatim from the user's filename (prevents `.exe` smuggling in the key). One
canonical extension per (content-type) mapping (§10).

### 7.4 ClamAV / virus scan — deferred

`architecture.md` §10.3 calls for a ClamAV scan with quarantine on detection. **Deferred**
out of Story 6: it belongs in a background job alongside quality scoring (Story 9) so it
does not block the synchronous submit path. Note recorded here so it is not lost.

---

## 8. Seed Data

Extend the existing `npm run seed` script (Story 1+) to create sample `MediaItem` rows for
the seeded sample event/submission, so Story 7's admin detail view and Story 9's worker
have data to render/process locally.

- For the seeded sample submission, create **3 sample `MediaItem` rows**: one VIDEO, one
  VOICE, one PHOTO.
- `storagePath` values follow the real template, e.g.
  `events/{seedEventId}/submissions/{seedSubmissionId}/media/{seedMediaId}.jpg`.
- The seed script **also uploads a tiny dummy object** to MinIO at each `storagePath` so
  `headObject` succeeds in local dev (a 1×1 PNG, a few-byte MP3, a tiny MP4). This keeps
  verify-before-save honest locally and lets Story 9's worker actually fetch bytes.
- `sizeBytes`, `mimeType` set to match the dummy objects. `qualityScore`/`duration`/
  `width`/`height` left **null** (Story 9 fills them). `qualityFlags` = `[]`.
- Idempotent: seed uses fixed ids / upserts so re-running does not duplicate rows or
  objects.

---

## 9. Testing

Follows the Story 1 pattern (Vitest, `tests/unit` + `tests/integration`). Integration
tests that need real MinIO are guarded by a **`SKIP_INTEGRATION`** env flag so unit-only
runs (and CI without Docker MinIO) stay green.

### 9.1 Unit (no infra; pure logic)

| Test | Asserts |
|---|---|
| Presigned key scoping | `buildMediaKey` always produces `events/{eventId}/submissions/{submissionId}/media/{mediaId}.{ext}`; rejects/ignores any client-supplied key prefix |
| Key shape validation | Submit-step key check accepts only keys matching the resolved event + draft submission + embedded mediaId; rejects foreign prefixes / traversal (`../`) |
| MIME allowlist | For each `type`, accepts only its allowed content-types + extensions; rejects mismatches (PHOTO with `video/mp4`, etc.) |
| Size-limit rules | Per-type limit boundaries (at limit = ok, +1 byte = `413`); per-submission count + total-size caps |
| Extension derivation | content-type → canonical extension mapping is 1:1 and deterministic |
| Verify-before-save logic | Given a stubbed `headObject` returning {missing | wrong-type | too-large | ok}, the decision is reject/reject/reject/accept; **rejection writes zero rows** |
| Cross-field rule | media-only submission passes; text-only passes; empty (no media, no text) → `422` |

### 9.2 Integration (`SKIP_INTEGRATION` guards real MinIO)

| Test | Flow |
|---|---|
| Presign + upload + persist (happy path) | Call presign route → PUT bytes to MinIO using the returned target → submit → assert `MediaItem` rows exist with storage-reported size/mime |
| Verify-before-save catches orphan | Presign but **do not upload** → submit → assert `422 MEDIA_NOT_FOUND` and **zero rows written** |
| MIME mismatch rejected at submit | Upload an object whose stored content-type is not in the allowlist for the declared `type` → submit → `422 MEDIA_TYPE_REJECTED` |
| Deadline race | Move event deadline into the past between presign and submit → submit → `403 DEADLINE_PASSED` |
| Cascade delete | Delete the parent submission → assert media rows gone (FK cascade); object files remain (separate concern) |

### 9.3 Mocking S3

- **Unit tests** mock the storage service interface (stub `headObject`,
  `createUploadTarget`) — no SDK, no network.
- **Integration tests** run against the real MinIO container from `docker-compose.yml`
  (bucket `swara-magical-test`), gated by `SKIP_INTEGRATION`. CI runs unit always;
  integration runs where a MinIO service is available (mirror Story 1's CI `services:`
  pattern by adding a MinIO service, or set `SKIP_INTEGRATION=true`).

---

## 10. Security

### 10.1 Allowlist (server-enforced; the only accepted types)

`architecture.md` §10.3: **MP4 / MOV / MP3 / M4A / JPG / PNG only.**

| `MediaType` | Allowed content-types | Allowed extensions | Canonical stored ext |
|---|---|---|---|
| VIDEO | `video/mp4`, `video/quicktime` | `.mp4`, `.mov` | `.mp4` / `.mov` (preserve container) |
| VOICE | `audio/mpeg`, `audio/mp4`, `audio/x-m4a` | `.mp3`, `.m4a` | `.mp3` / `.m4a` |
| PHOTO | `image/jpeg`, `image/png` | `.jpg`, `.jpeg`, `.png` | `.jpg` / `.png` |

> **[CONFIRM]** M4A content-type is reported variously as `audio/mp4` or `audio/x-m4a` by
> browsers; allow both. JPEG `.jpg`/`.jpeg` both map to canonical `.jpg`.

### 10.2 Per-type size limits — **PROPOSED, [CONFIRM ALL]**

| Type | Proposed max per file | Rationale |
|---|---|---|
| Video | **500 MB** | A few minutes of phone video at typical bitrate; keeps `sizeBytes` within `Int` |
| Voice | **50 MB** | Long voice note margin |
| Photo | **25 MB** | High-res phone photo with headroom |
| Per submission — file count | **30 files [CONFIRM]** | Matches "47 photos" delivery example loosely; bound abuse |
| Per submission — total bytes | **1 GB [CONFIRM]** | Caps a single contributor's footprint |

These map to constants the presign route, submit step, and client all read. Defining max
file sizes is an explicit `requirements.md` §8 / architecture.md §14 build-time decision.

### 10.3 Other controls

- **Per-event scoped keys.** Presigned URLs only ever target
  `events/{event_id}/...`; the client cannot choose the key. (`architecture.md` §10.3.)
- **Server MIME validation** at submit from authoritative storage metadata — browser
  `mimeType` is advisory only.
- **Private ACL** on every object; no public read (`architecture.md` §7.2).
- **Short presigned expiry** — 15 minutes; an exfiltrated URL is useless soon and is
  single-key + content-type pinned.
- **Filename sanitization** — `originalName` stored as data only; never used to build the
  key (key uses server `mediaId` + canonical ext). Strip path separators / control chars.
- **Deadline + one-per-email** re-checked server-side at both presign and submit so a
  stale tab cannot bypass Story 5 gates.
- **Rate limiting** on the presign route (per IP/event) to blunt presign-spam.
- **ClamAV** scan deferred to a background job (§7.4) — flagged, not silently dropped.

---

## 11. Observability / Audit

- **Structured logs** (Story 1 `logger`) on: presign issued (`eventId`, `mediaId`,
  `type`, `sizeBytes` — never the URL, never PII filename in prod logs), submit verify
  outcome per file (pass/fail + reason), submission persisted (`submissionId`, media
  count by type).
- **Metrics** worth emitting (wire to OTel per `architecture.md` §13 when observability
  lands): presign request rate, verify-before-save failure rate (a spike means clients
  abandoning uploads or an allowlist mismatch), bytes uploaded per event, orphan estimate.
- **Audit log** (`AuditLog`, schema present): Story 6 is contributor-facing and anonymous;
  no admin action to audit here. The submission insert itself is the record. (Right-to-
  delete auditing is Story 20.)
- **No URL logging.** Presigned URLs and storage object URLs must not appear in logs
  (consistent with `architecture.md` §10.1's redaction posture).

---

## 12. Definition of Done

- [ ] `MediaItem` model + `MediaType` enum added; migration `add_media_item` created and
      applied to `swara_dev` and `swara_test`; `prisma generate` run.
- [ ] `S3_*` config added in **both** `src/config/env.ts` and `src/config/index.ts`
      (`storage` block, Zod-validated, `forcePathStyle` boolean).
- [ ] Storage service module exists behind a clean interface; reads only `config.storage`;
      works against MinIO locally (verified) and is R2-ready via `forcePathStyle`.
- [ ] Presign route (`POST /api/contribute/[slug]/uploads/presign`) enforces deadline,
      allowlist, size limits, event-scoped key; returns 15-min target + `storageKey` +
      `mediaId`.
- [ ] `/contribute/[slug]` form has video/voice/photo pickers (multiple), client
      type+size validation, progress, retry/remove, **max 3 concurrent uploads**, and the
      "media OR text" rule is satisfiable by media.
- [ ] Submit step verifies every referenced object exists + re-validates MIME **before**
      writing rows; any failure → zero rows persisted (transaction rollback).
- [ ] Seed script creates 3 sample `MediaItem` rows and uploads matching dummy objects to
      MinIO; idempotent.
- [ ] Unit tests (key scoping, allowlist, size limits, verify-before-save, cross-field
      rule) pass; integration tests pass against MinIO and are skipped cleanly under
      `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; no `process.env`
      reads outside `src/config/`.
- [ ] No TODO comments left in committed code.

---

## 13. Open Questions / Assumptions

| # | Item | Recommendation / default | Needs |
|---|---|---|---|
| 1 | **Per-file size limits** (video/voice/photo) | 500 MB / 50 MB / 25 MB | **[CONFIRM]** |
| 2 | **Per-submission caps** (count, total bytes) | 30 files, 1 GB total | **[CONFIRM]** |
| 3 | **Presigned PUT vs POST** | **PUT** — single header (`Content-Type`), simplest browser flow; POST policy adds explicit `content-length-range` enforcement at storage. Choose PUT unless we want storage-enforced max size at upload time (then POST). | **[CONFIRM]** |
| 4 | **Draft submission id supplied client-side becomes `Submission.id`** | Accept (unguessable CUID, event-scoped, verified at submit) | **[CONFIRM]** |
| 5 | **`sizeBytes` as `Int` vs `BigInt`** | `Int` (limits keep files < 2 GB) | OK unless limits raised |
| 6 | **Magic-byte sniffing in Story 6** | No — rely on content-type + extension allowlist now; deep sniff + ClamAV in Story 9 scan job | **[CONFIRM]** |
| 7 | **Story 5 design absent** | This doc assumes Submission fields/form per architecture §7.1/§6.2; reconcile field names if the Story 5 design lands and diverges | reconcile |
| 8 | **Multipart upload for very large files** | Out of MVP 1; single-part PUT/POST per file. Revisit if 500 MB single PUT proves unreliable on poor networks | future |
| 9 | **Optional `@@index([type])` on MediaItem** | Defer until a query needs it (analyzer Story 12) | defer |
| 10 | **Orphan reaping** | Storage lifecycle rule to expire objects under `media/` with no committed submission after N days, or a sweep job | define in Story 9/lifecycle |
