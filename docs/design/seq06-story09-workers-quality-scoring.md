# Sequence 06 / Story 9 — Worker Infrastructure + Quality Scoring

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (queue names, concurrency, job names, payload shapes, idempotency key templates,
scoring rules, thresholds, state transitions, retry/backoff, error handling) so later code
generation is unambiguous. Where a value is a proposal awaiting confirmation it is flagged
**[CONFIRM]**.

| Field | Value |
|---|---|
| Story number / title | Story 9 — Worker infrastructure + quality scoring |
| Epic | E — AI Pipeline |
| Sequence number | 6 (this is the 6th design in build order) |
| Depends on | Story 6 (Media uploads — the `MediaItem`/`Submission` models, storage service, `S3_*` config, the submit flow that this story hooks job enqueue into) |
| Also assumes on `main` | Story 1 (config, `db`, `redis` singleton, `logger`, worker scaffold, CI), Story 3 (`Event` model), Story 5 (`Submission` model) |
| Unlocks | Story 10 (Whisper transcription), Story 11 (Claude analysis), Story 12 (routing analyzer reads quality flags), Story 16/17 (storyboard/encoding reuse the queue + idempotency pattern), Story 18 (reminders reuse the queue + scheduler pattern) |
| Complexity | L (3–5 days) |

> **Why this story is load-bearing.** Stories 10, 11, 16, 17, and 18 all enqueue and process
> BullMQ jobs. This story establishes the **one** way the codebase registers queues, enqueues
> jobs, writes idempotent output, retries, and runs the worker process. Later stories add a
> queue + a processor; they do not re-invent the infrastructure. Be rigorous here: the queue +
> idempotency patterns defined in §5 are the contract every later pipeline story copies.

---

## 1. Story Summary

Story 1 left an **idle** worker process (`src/workers/index.ts` pings Redis, logs "Worker
ready", and sleeps; no BullMQ is wired). Story 6 persists `MediaItem` rows (one per uploaded
file) with quality columns (`qualityScore`, `qualityFlags`, `duration`, `width`, `height`)
and `Submission.overallQualityScore` left **null**.

Story 9 does three things:

1. **Stands up BullMQ on the existing Redis singleton** — a typed queue registry, a worker
   bootstrap, graceful shutdown, and an enqueue helper. This is the async infrastructure many
   later stories build on.
2. **Implements the first real job: FFprobe-based quality scoring.** On submission (and per
   media item), a `quality` job inspects each media file with FFprobe/FFmpeg, derives
   non-LLM quality signals per media type, computes a composite **0–100** score, **flags**
   anything below 40, **auto-rejects** anything below 20 (with admin notification), writes the
   per-media fields, and rolls the per-media scores up into `Submission.overallQualityScore`.
3. **Establishes the idempotency pattern** — every job carries the key
   `{event_id}:{submission_id}:{job_type}` (`architecture.md` §6.3, §8.2), is safe to retry,
   and writes output by deterministic key (overwrite, not append). This is reused verbatim by
   Stories 10/11/16/17/18.

Quality scoring is deliberately **non-LLM** (`architecture.md` §9.4): FFprobe signals only,
fast, deterministic, CPU-light. Transcription (Story 10), Claude analysis (Story 11),
encoding (Story 17), and reminders (Story 18) are **out of scope** — but their queues and the
shared job pattern they will reuse are designed here.

---

## 2. Scope

### In scope

- **BullMQ + Redis queue infrastructure**: a queue registry (typed queue definitions), a
  worker bootstrap that registers processors, graceful shutdown, and an `enqueue` helper that
  applies the idempotency `jobId`.
- **The `quality` queue** (concurrency 16, High priority — `architecture.md` §8.1) and its
  processor.
- **The quality-scoring job**: inputs, FFprobe-derived signals per VIDEO / VOICE / PHOTO,
  composite 0–100 scoring, flag `<40`, auto-reject `<20` + admin notification, populate
  `MediaItem` fields and `Submission.overallQualityScore`.
- **Enqueue-on-submit wiring**: the Story 6 submit action enqueues quality jobs after the
  submission + media rows commit (coordinate with Story 6 — §5.3).
- **The idempotency pattern** (`{event_id}:{submission_id}:{job_type}` job id; output-by-key
  overwrite; side-effect dedup via audit log) — reusable contract documented for later stories.
- **Worker process lifecycle**: registration in `src/workers`, the `quality` worker, graceful
  SIGINT/SIGTERM drain, concurrency from config.
- **Config**: queue concurrency knobs, FFprobe/FFmpeg binary path, worker tuning — added in
  **both** `src/config/env.ts` and `src/config/index.ts`.
- **S3 read access in the worker runtime** — the worker fetches/streams media bytes from
  storage (reuses the Story 6 storage service).
- **Schema population**: fill `MediaItem.qualityScore`, `qualityFlags`, `duration`, `width`,
  `height` and `Submission.overallQualityScore` (columns already exist from Story 6 /
  architecture §7.1 — this story writes them, not defines them). Decide whether BullMQ alone
  is sufficient for idempotency or a dedup tracking column/table is needed (§6).
- **Worker deployment target** (Railway/Fly per `architecture.md` §4) documented; FFmpeg
  available in the worker image.
- **AuditLog** entry on auto-reject; **NotificationLog** + admin alert on auto-reject.
- **Seed + local run** path so the worker can be exercised end-to-end locally.

### Out of scope (deferred)

| Item | Where it lands | Note |
|---|---|---|
| Transcription (Whisper) job + `transcription` queue processor | Story 10 | Queue **named** in the topology here; **no processor** in Story 9 |
| Claude analysis (sentiment/quotes/tags) + `analysis` queue processor | Story 11 | Queue named; no processor here |
| The pipeline **fan-in/DAG** (quality → analyze → complexity) | Story 11/12 | Story 9 emits the `quality` leaf only; it does not chain downstream jobs |
| Storyboard/script/encoding queues' processors | Story 16/17 | Queues may be declared in the registry as stubs **[CONFIRM]** or added by their own stories |
| Reminder cron scheduler | Story 18 | `reminders` queue named; the repeatable/cron job and sweep are Story 18 |
| ClamAV virus scan (deferred from Story 6) | Story 9-adjacent or later | Could ride the same worker, but **out of scope** for this story unless added explicitly — flagged in §10 |
| Routing analyzer consuming quality flags | Story 12 | Story 9 only writes the flags; Story 12 reads them |
| OpenTelemetry export of metrics | Observability story | Story 9 emits structured logs + metric-shaped counters; OTel wiring is later (§11) |

---

## 3. Dependencies & Sequence

**Must already be on `main`:**

- **Story 1** — `src/config` (both `env.ts` and `index.ts`), `src/lib/db.ts` (Prisma
  singleton), `src/lib/redis.ts` (IORedis singleton with `maxRetriesPerRequest: null`,
  `lazyConnect: true`), `src/lib/logger.ts` (pino), `src/workers/index.ts` (idle scaffold to
  be extended), CI, docker-compose (Redis + MinIO).
- **Story 3** — `Event` model (`id`, `slug`, `status`, `submissionDeadline`).
- **Story 5** — `Submission` model (`id`, `eventId`, `status`, `overallQualityScore` column).
- **Story 6** — `MediaItem` model + `MediaType` enum, the **storage service** (`headObject`,
  key helpers — Story 6 §7.2), `S3_*` config in both config files, and the submit action that
  Story 9 hooks job enqueue into.

> **`maxRetriesPerRequest: null` is mandatory for BullMQ.** The existing `redis.ts` already
> sets it (Story 1) — BullMQ requires it on the connection used by Workers. Story 9 reuses the
> singleton; do **not** create a second connection with different options for the Worker
> blocking commands. See §7.1 for the connection-sharing rule.

**Provides to later stories:**

- The **queue registry + enqueue helper + idempotency `jobId` convention** — Stories
  10/11/16/17/18 add a queue entry + a processor and call the same `enqueue` helper.
- The **worker bootstrap** in `src/workers` — later stories register their `Worker` here.
- `MediaItem` quality fields + `Submission.overallQualityScore` populated — Story 12's routing
  analyzer reads `qualityFlags` / flag rate; Story 7's admin detail surfaces the scores.

**Sequencing notes:**

- Story 9 depends on Story 6's `MediaItem` rows and storage service; it cannot run before
  media exists.
- Story 10 (transcription) is the immediate next consumer of this infrastructure; design the
  enqueue helper and queue registry so adding the `transcription` queue + processor is purely
  additive.
- Coordinate the **enqueue point** with Story 6's submit action (§5.3) and the **admin
  read-only surface** with Story 7 (§4).

---

## 4. Frontend / UI Design

**Mostly N/A.** Story 9 is worker/infrastructure; it ships no contributor- or organizer-facing
UI.

**Optional, read-only, coordinate with Story 7 (admin dashboard):** quality results surface in
the admin per-event detail view's "Asset quality scores" section (`requirements.md` §5.5).
This story **produces** the data; Story 7 **renders** it. To keep the contract clear:

| Surface | Field source | Display (Story 7 renders) |
|---|---|---|
| Per-file quality rating | `MediaItem.qualityScore` (0–100, null = "not yet scored") | numeric or badge; null shows "pending" |
| Flagged files highlighted | `MediaItem.qualityFlags[]` non-empty, or score `<40` | warning chip listing flags (e.g. "blurry", "low_audio") |
| Auto-rejected submission | `Submission.status = REJECTED` set by the job + `adminNote` | red status + system note "auto-rejected: low quality" |
| Submission overall score | `Submission.overallQualityScore` | summary number on the submission row |

No write/edit UI in this story. Admin **override** of an auto-reject (un-reject) is a Story 8
concern (approve/reject) — Story 9 only sets the initial auto-reject status and records the
audit/notification. **[CONFIRM]** the exact flag vocabulary with Story 7 so chips render
known strings (§5.5 lists the canonical flag set).

---

## 5. Backend / Worker Design

### 5.1 Queue topology (this story)

From `architecture.md` §8.1. Story 9 **implements** the `quality` queue and its processor.
The other rows are **declared in the registry** (names, concurrency, priority known) so later
stories add only a processor, but Story 9 ships a processor **only** for `quality`.

| Queue | Concurrency | Priority | Implemented in Story 9? | Notes |
|---|---|---|---|---|
| `quality` | **16** | High | **Yes (processor + enqueue)** | FFprobe; fast, CPU-light |
| `transcription` | 8 | High | Declared only | Whisper; Story 10 adds processor |
| `analysis` | 4 | High | Declared only | Claude Sonnet; Story 11 |
| `storyboard` | 1 | Normal | Declared only **[CONFIRM]** | Claude Opus; Story 16 |
| `script` | 2 | Normal | Declared only **[CONFIRM]** | Claude Sonnet; Story 16 |
| `brief_zip` | 2 | Normal | Declared only **[CONFIRM]** | Story 13 |
| `encoding` | 2 | Normal | Declared only **[CONFIRM]** | FFmpeg; **separate encoder worker pool** (§7.4); Story 17 |
| `notifications` | 10 | High | **Partial** — enqueue only | Story 9 enqueues the auto-reject admin alert; the dispatcher/processor is its own concern (§5.6, §11). **[CONFIRM]** whether Story 9 ships a minimal notifications processor or only enqueues |
| `reminders` | 1 | Low | Declared only | Cron sweep; Story 18 |

> **[CONFIRM] — declare-all vs declare-as-needed.** Two options for the registry: (A) declare
> all nine queues now (names + concurrency as a single source of truth) and let later stories
> attach processors, or (B) declare only `quality` (+ `notifications` for the alert) now and
> let each story add its queue entry. **Recommendation: (A)** — one canonical topology table in
> code from day one prevents drift between stories and matches §8.1. A queue with no Worker
> simply has no consumer; that is harmless.

**Priority semantics:** BullMQ priority is per-job (lower number = higher priority). Map the
table's High/Normal/Low to concrete numbers in config, e.g. `High=1, Normal=5, Low=10`
**[CONFIRM]**. Concurrency is set on the `Worker` (per-process). With multiple worker replicas,
**effective concurrency = per-worker concurrency × replica count** — document this so the §8.1
numbers are interpreted as per-process defaults, autoscaled per `architecture.md` §12.

### 5.2 Job naming & the queue/job registry

A single module (proposed `src/workers/queues.ts` or `src/lib/queue/registry.ts`
**[CONFIRM location]**) is the **only** place queues are constructed. It exports:

- A typed enum/const of **queue names** (`quality`, `transcription`, …) — no string literals
  scattered across the codebase.
- A typed enum/const of **job names** (the `job_type` component of the idempotency key).
- One `Queue` instance per declared queue, all bound to the shared Redis connection (§7.1).
- A typed `enqueue` helper (§5.4).

**Job name(s) in this story:**

| Job name (`job_type`) | Queue | Payload (§5.3) | Purpose |
|---|---|---|---|
| `quality.score_media` | `quality` | `{ eventId, submissionId, mediaItemId }` | Score ONE media item |

> **Per-media vs per-submission granularity — decision.** Score **one job per media item**
> (`quality.score_media`), not one job per submission. Rationale: each `MediaItem` is scored
> and retried independently (`architecture.md` §7.1 schema note: "Each media item has
> independent quality scoring"); a corrupt video shouldn't block scoring of a sibling photo;
> concurrency 16 then parallelizes across files. The **submission rollup**
> (`overallQualityScore`) is computed by a small finalize step after the last media item in a
> submission is scored — see §5.7. **[CONFIRM]** this granularity (alternative: one
> `quality.score_submission` job that loops media internally — simpler enqueue, coarser retry).

### 5.3 Enqueue point & job payload

**When jobs are enqueued.** In the Story 6 submit action, **after** the `Submission` + all
`MediaItem` rows commit successfully (the transaction from Story 6 §5.3), enqueue one
`quality.score_media` job **per persisted `MediaItem`**. Enqueue happens **outside / after** the
DB transaction commit (never inside it) so a rolled-back submission never produces phantom
jobs, and a Redis hiccup never rolls back a valid submission.

> **Coordinate with Story 6.** Story 6 §5.3 ends with "create one `MediaItem` per element …".
> Story 9 adds the line "for each created `MediaItem`, `enqueue(quality, 'quality.score_media',
> {eventId, submissionId, mediaItemId})`". This is the only change Story 9 makes to the submit
> path. If enqueue fails (Redis down), log + continue (the submission is still valid); a
> backfill/sweep can re-enqueue unscored media (see §5.8, §13).

**Payload shape** (`quality.score_media`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `eventId` | string (cuid) | yes | For the idempotency key + audit/notification context |
| `submissionId` | string (cuid) | yes | For the idempotency key + rollup |
| `mediaItemId` | string (cuid) | yes | The single media item to score |

The payload carries **only ids** (`architecture.md` §8.2 contract #1: "inputs include all data
needed (no implicit state)" — here the ids are sufficient because the job re-reads the
authoritative `MediaItem` row, including `storagePath`, `type`, `mimeType`). The processor
re-fetches the row at run time so a retry always sees current DB state. **No** large blobs,
URLs, or secrets in the payload (logs may capture payloads).

### 5.4 Idempotency key & the enqueue helper

**The idempotency contract (the reusable pattern):** every job's BullMQ `jobId` is set to the
deterministic key

```
{event_id}:{submission_id}:{job_type}
```

(`architecture.md` §6.3, §8.2). For per-media jobs the `job_type` segment **includes the media
item id** so two media items in the same submission get distinct keys:

```
quality.score_media : key = {eventId}:{submissionId}:quality.score_media:{mediaItemId}
```

> **[CONFIRM] key shape for per-media jobs.** The architecture's canonical key is
> `{event_id}:{submission_id}:{job_type}`. Per-media granularity (§5.2) needs a 4th segment
> (`:{mediaItemId}`) to keep keys unique. Two acceptable encodings: (a) append `:{mediaItemId}`
> as shown, or (b) fold it into `job_type` as `quality.score_media:{mediaItemId}`. **Recommend
> (a)** — keeps `job_type` a stable enum value, media id is a clearly separate segment. Either
> way, a single canonical `buildJobKey()` helper produces it; never hand-format keys.

**How the key delivers idempotency in BullMQ:** BullMQ **deduplicates by `jobId`** — adding a
job whose `jobId` already exists is a no-op (the existing job is not duplicated). So an
accidental double-enqueue (e.g., submit retried, sweep + submit both fire) cannot create two
jobs for the same media item. Combined with output-by-key overwrite (below), the job is safe to
enqueue and run any number of times.

> **Caveat — completed-job retention.** BullMQ's "ignore if jobId exists" holds only while the
> job record is retained. With `removeOnComplete: true` (or a low retention count), a *new*
> enqueue with the same `jobId` after the old one was removed will create a *fresh* job. That
> is **acceptable here** because the job's DB write is itself idempotent (output-by-key
> overwrite, §5.5) — re-running produces the same result. **Decision:** rely on
> jobId-dedup for in-flight dedup, and rely on output-by-key overwrite for correctness across
> retention windows. Set `removeOnComplete` to a bounded count (e.g. last 1000) and
> `removeOnFail` to keep failures for inspection (§11). **[CONFIRM]** retention counts.

**The `enqueue` helper** (single chokepoint, reused by all later stories):

| Concern | Behavior |
|---|---|
| Signature (conceptual) | `enqueue(queueName, jobName, payload, opts?)` |
| `jobId` | Always set to `buildJobKey(payload, jobName)` — callers cannot forget it |
| Default opts | `attempts`, `backoff`, `priority`, `removeOnComplete`, `removeOnFail` pulled from config defaults per queue (§5.8) unless overridden |
| Validation | Payload validated against a per-job Zod schema before enqueue (typed end-to-end, `architecture.md` §5) |
| Return | The created (or existing) job's id |

### 5.5 The quality-scoring job — inputs, signals, scoring

**Processor flow for `quality.score_media`:**

1. **Re-fetch** the `MediaItem` by `mediaItemId` (also load parent `Submission`/`Event` for
   context). If the row is gone (deleted between enqueue and run — right-to-delete, cascade),
   **no-op success** (nothing to score).
2. **Stream/download** the object bytes from storage via the Story 6 storage service using
   `MediaItem.storagePath`. Workers need **S3 read** access (§7.3). Prefer streaming to a temp
   file (FFprobe/FFmpeg generally need a seekable input); clean up the temp file in `finally`.
3. **Probe with FFprobe** to extract container/stream metadata (codecs, dimensions, duration,
   bitrate, sample rate, audio levels). For blur (video/photo) sample frames and compute a
   sharpness metric with FFmpeg (§5.5.3, §13).
4. **Derive signals** per media type (§5.5.1–§5.5.3) and **compute the composite 0–100 score**
   (§5.5.4).
5. **Derive flags** (§5.5.5) and **classify**: `<20` → auto-reject; `<40` (and `≥20`) → flag;
   `≥40` → pass.
6. **Write outputs by key** (§5.6): set `MediaItem.qualityScore`, `qualityFlags`, `duration`,
   `width`, `height` (overwrite — deterministic, retry-safe).
7. **Auto-reject side effects** if `<20`: set `Submission.status = REJECTED` + system
   `adminNote`, write `AuditLog`, enqueue admin notification (dedup via audit, §5.6).
8. **Rollup**: recompute `Submission.overallQualityScore` from the submission's scored media
   (§5.7).

#### 5.5.1 VIDEO signals (FFprobe + sampled-frame blur)

Per `architecture.md` §9.4 (Video: avg bitrate, resolution, audio peak dB, blur via Laplacian
variance on N sampled frames).

| Signal | Source | Maps to | Notes |
|---|---|---|---|
| Resolution (width×height) | FFprobe video stream | `MediaItem.width`, `height`; resolution sub-score | e.g. <720p weak, ≥1080p strong |
| Duration (sec) | FFprobe format/stream | `MediaItem.duration`; sanity flags | 0 / unreadable → corrupt |
| Avg video bitrate | FFprobe (format/stream `bit_rate`) | bitrate sub-score | low bitrate → compression artifacts |
| Audio peak / mean level | FFmpeg `astats`/`volumedetect` (peak dB, mean dB) | audio sub-score | very low → `low_audio`; no audio stream → `no_audio` flag (not auto-fail — many wishes are silent **[CONFIRM]**) |
| Blur (sharpness) | Laplacian variance over **N sampled frames** (§5.5.3) | sharpness sub-score | low variance → `blurry` |
| Orientation | width vs height | `portrait` flag (informational, used by Story 12 routing) | portrait is **not** a quality defect; it does not reduce the score, only sets the `portrait` flag |

#### 5.5.2 VOICE signals (FFprobe audio)

Per §9.4 (Voice: peak/avg dB, sample rate, duration).

| Signal | Source | Maps to | Notes |
|---|---|---|---|
| Audio peak / mean level (dB) | FFmpeg `astats`/`volumedetect` | level sub-score | very low peak → `low_audio`; near-silence → strong penalty |
| Sample rate | FFprobe audio stream | sample-rate sub-score | <16 kHz weak; ≥44.1 kHz strong |
| Duration (sec) | FFprobe | `MediaItem.duration`; sub-score + sanity | 0 / unreadable → corrupt; extremely short (<1s) → `too_short` **[CONFIRM]** |
| Clipping | `astats` (peak at 0 dBFS / clip count) | penalty | heavy clipping → `clipping` flag **[CONFIRM include]** |

`width`/`height` are **null** for VOICE (no video stream).

#### 5.5.3 PHOTO signals (FFprobe/FFmpeg image)

Per §9.4 (Photo: resolution, blur via Laplacian variance, exposure via histogram).

| Signal | Source | Maps to | Notes |
|---|---|---|---|
| Resolution (width×height) | FFprobe image dimensions | `MediaItem.width`, `height`; resolution sub-score | low-res → `low_resolution` |
| Blur (sharpness) | Laplacian variance on the decoded image | sharpness sub-score | low variance → `blurry` |
| Exposure | Histogram check (over/under-exposed clipping) | exposure sub-score | extreme → `overexposed` / `underexposed` |

`duration` is **null** for PHOTO.

> **Blur (Laplacian variance) implementation note.** Standard OpenCV-style Laplacian variance
> needs a CV dependency. Within an FFmpeg-only worker, approximate sharpness via an edge/
> high-frequency filter and read the resulting frame statistics (e.g. an edge-detect or
> high-pass filter feeding `signalstats`/frame stats), or sample frames to PNG and compute the
> variance of a Laplacian kernel in-process. Exact mechanism and thresholds are an **open
> question** (§13). For VIDEO, sample **N frames** (proposed N=5, evenly spaced, skipping the
> first/last second) and average the per-frame sharpness. **[CONFIRM N, sampling positions,
> and the sharpness library/approach.]**

#### 5.5.4 Composite score (0–100)

Each signal is normalized to a 0–100 sub-score via configured thresholds, then combined with
per-media-type **weights** into the composite. Weights must sum to 1.0 per type.

> **Exact weights are an open question (§13).** Proposed starting weights **[CONFIRM ALL]**:

| Media | Sub-scores & proposed weights | Composite |
|---|---|---|
| VIDEO | resolution 0.25, bitrate 0.20, audio level 0.25, sharpness 0.30 | weighted sum → 0–100 |
| VOICE | audio level 0.55, sample rate 0.20, duration 0.25 | weighted sum → 0–100 |
| PHOTO | resolution 0.35, sharpness 0.45, exposure 0.20 | weighted sum → 0–100 |

Rules:

- Composite is clamped to `[0, 100]`, rounded to the storage precision (`Float`).
- A **corrupt/unreadable** file (FFprobe fails to parse, zero duration on audio/video, decode
  error) is **not** scored 0 through the formula — it is treated as a hard failure → score
  **0** + `corrupt` flag → auto-reject (`<20`). See §5.5.6.
- The normalization thresholds (what counts as "good" bitrate, "good" peak dB, "sharp") live in
  **config** so they can be tuned without code changes (§7.5). **[CONFIRM]** initial threshold
  values.

#### 5.5.5 Flag vocabulary (canonical `qualityFlags[]` strings)

`MediaItem.qualityFlags` is a `String[]`. The canonical set (architecture §7.1 example:
`["low_audio","blurry","portrait"]`):

| Flag | Applies to | Set when |
|---|---|---|
| `blurry` | VIDEO, PHOTO | sharpness sub-score below threshold |
| `low_audio` | VIDEO, VOICE | audio peak/mean below threshold |
| `no_audio` | VIDEO | no audio stream present **[CONFIRM whether to flag]** |
| `clipping` | VIDEO, VOICE | audio clipping detected **[CONFIRM include]** |
| `low_resolution` | VIDEO, PHOTO | below resolution threshold |
| `low_bitrate` | VIDEO | below bitrate threshold |
| `overexposed` / `underexposed` | PHOTO | histogram exposure extremes |
| `portrait` | VIDEO | portrait orientation (informational; for Story 12 routing) |
| `too_short` | VOICE, VIDEO | duration under minimum **[CONFIRM]** |
| `corrupt` | any | FFprobe/decode failure → score 0 → auto-reject |
| `low_quality` | any | composite `<40` (the umbrella flag the admin UI keys on) **[CONFIRM]** whether to store an explicit umbrella flag vs deriving "flagged" from `score<40` |

> **[CONFIRM] flag-set freeze with Story 7.** Story 7 renders these as chips. Freeze the exact
> strings here so the admin UI never shows an unknown flag. `portrait` is informational, not a
> quality penalty.

#### 5.5.6 Thresholds & classification

| Composite | Classification | Effects |
|---|---|---|
| `≥ 40` | Pass | write score + flags; no status change |
| `≥ 20` and `< 40` | **Flagged** | write score + flags (incl. `low_quality`); **no** auto status change. Admin sees the flag (Story 7). **[CONFIRM]** whether a flagged file flips `Submission.status` to `FLAGGED` or leaves it `PENDING` with flags surfaced — see note below |
| `< 20` | **Auto-reject** | write score + flags (incl. `corrupt` when applicable); set `Submission.status = REJECTED` + system `adminNote`; `AuditLog`; admin notification |

> **Flag granularity question.** Quality scoring is **per media item**, but `status` lives on
> the **`Submission`**. A submission with one blurry photo among five good files should
> probably not be globally `FLAGGED`. **Recommendation:** flagging is **per-media** (stored in
> `MediaItem.qualityFlags`); the submission stays `PENDING` and the admin sees per-file flags.
> **Auto-reject** at `<20` is more consequential: **[CONFIRM]** whether a single `<20` media
> item auto-rejects the whole submission, or only marks that media item and the submission is
> rejected only if **all** media are `<20` / no usable media remains. **Recommended default:**
> auto-reject the whole submission only when it has **no media item scoring ≥20** (i.e. every
> attached file is unusable) — a single bad photo flags but does not reject. This avoids
> nuking an otherwise good submission. (`SubmissionStatus` enum includes `FLAGGED` and
> `REJECTED` per architecture §7.1.)

### 5.6 Output-by-key & side-effect idempotency

**Output-by-key (the per-media DB write).** The job's primary output is the
`MediaItem` row update keyed by `mediaItemId`. Re-running overwrites the same fields with the
same computed values (deterministic given the same bytes + same thresholds) — this is the
"outputs written by deterministic key … overwrites by key" rule (`architecture.md` §8.2 #2,
§6.3). No appends, no duplicate rows.

**Side-effect idempotency (auto-reject notification + audit).** Per `architecture.md` §8.2 #3,
side effects check the audit log before emitting:

- Before enqueuing the admin auto-reject notification, check whether an `AuditLog` row with
  `action = 'submission.auto_rejected'` already exists for this `submissionId` (or whether a
  `NotificationLog` row for trigger `submission.auto_rejected` already exists). If yes →
  **no-op** (don't re-notify on retry).
- The auto-reject status write is naturally idempotent (setting `status = REJECTED` twice is
  the same state), but guard the **notification** + **audit insert** so a retried job doesn't
  spam the admin.
- **[CONFIRM]** use `AuditLog` existence as the dedup source of truth (recommended — it's the
  canonical record), with `NotificationLog` as the send record.

### 5.7 Submission rollup (`overallQualityScore`)

After a media item is scored, recompute `Submission.overallQualityScore` =
**average of the non-null `qualityScore` across the submission's media items** **[CONFIRM
aggregate: mean vs min vs weighted]**. Two safe ways to compute it idempotently:

- **Recompute-from-DB (recommended):** read all sibling `MediaItem.qualityScore` for the
  submission and write the aggregate. This is order-independent and retry-safe — whichever job
  finishes last computes the final value; earlier jobs compute partial-but-correct
  intermediates. No "is this the last one?" race to reason about.
- (Rejected alternative: a separate `quality.finalize_submission` job gated on "all media
  scored" — adds a fan-in dependency and DAG complexity that §2 defers. The recompute-from-DB
  approach gets a correct final value without a coordinator.)

Submissions with **no scoreable media** (text-only) get `overallQualityScore = null` and are
never enqueued (no media items → no jobs). That is correct: text submissions skip quality
scoring (`requirements.md` §5.3 "steps apply only to media types present").

### 5.8 Retry / backoff policy

| Setting | Value | Rationale |
|---|---|---|
| `attempts` | **3** | Matches the architecture's "retry 3x with backoff" posture (§6.3, §11.1) |
| `backoff` type | **exponential** | §11.1 |
| `backoff` base delay | **[CONFIRM] ~5s** (5s → 10s → 20s) | FFprobe failures are usually transient (storage blip); short backoff is fine — this is not a rate-limited external API like Whisper |
| On exhausting attempts | Job goes to **failed** set (kept for inspection via `removeOnFail` policy). The `MediaItem` keeps `qualityScore = null` (unscored). Log an error metric. **Do not** auto-reject on infra failure (a probe failure is not a quality verdict). | Distinguish "couldn't score" (null, infra) from "scored badly" (score `<20`, auto-reject) |
| Lock / stalled | Rely on BullMQ lock + stalled-job re-queue (`architecture.md` §11.1: "BullMQ requeues stuck jobs after lock timeout; jobs are idempotent so safe"). Tune lock duration > expected probe time. | Worker crash safety |
| Distinguishing corrupt-file vs infra-failure | A genuinely corrupt/unreadable file (FFprobe parses but reports zero/garbage, or a clean decode error) is a **quality verdict** → score 0 + `corrupt` → auto-reject (do **not** retry). A storage/timeout/transient error is an **infra failure** → throw → retry. The processor must classify the FFprobe error and decide retry-vs-verdict. **[CONFIRM]** the classification list. |

> **Re-enqueue / backfill for unscored media.** If enqueue failed at submit time (Redis down)
> or attempts were exhausted, media stays `qualityScore = null`. A simple recovery: a query
> for `MediaItem WHERE qualityScore IS NULL AND uploadedAt < now()-grace` re-enqueues
> `quality.score_media` (idempotent by key). **[CONFIRM]** whether this sweep ships in Story 9
> (small) or is deferred; recommend a minimal admin-triggerable or cron re-enqueue, but it can
> be deferred to the reminders/cron infra in Story 18. (Listed §13.)

### 5.9 Worker process lifecycle & registration

Extend `src/workers/index.ts` (currently idle). Target structure:

- `src/workers/index.ts` — entry point: ping Redis (existing), **register Workers** from the
  registry, install graceful shutdown, log readiness. Replace the `setInterval` idle keepalive
  — the registered BullMQ `Worker`(s) keep the event loop alive.
- `src/workers/quality.worker.ts` (or `src/workers/processors/quality.ts`) **[CONFIRM
  layout]** — the `quality` processor (the scoring logic in §5.5, ideally split into a pure
  `scoreMedia()` function for unit testing + a thin processor wrapper).
- `src/workers/queues.ts` (or `src/lib/queue/registry.ts`) — the registry + `enqueue` helper
  (§5.2, §5.4). **Importable by web code** (the submit action enqueues) **and** worker code
  (registers processors). Keep `Queue` construction lazy/safe so importing it in a Next.js
  route doesn't open connections at build time (mirror `redis.ts`'s `lazyConnect`).

**Graceful shutdown** (extend the existing SIGINT/SIGTERM handlers): on signal, call
`worker.close()` on each registered Worker (lets in-flight jobs finish / returns them to the
queue), then `redis.quit()`, then `process.exit(0)`. Set a shutdown timeout so a hung job
doesn't block deploys (`architecture.md` §4 — workers run on Railway/Fly; rolling deploys send
SIGTERM). **[CONFIRM]** shutdown grace timeout (e.g. 30s).

**Concurrency** for each Worker comes from config (§7.5), defaulting to the §8.1 table values.
The single worker process may host multiple Workers (quality now; transcription/analysis added
later by their stories). The **encoder pool is a separate process** (§7.4) — its `Worker`
registers in a distinct entry (e.g. `src/workers/encoder.ts`) so it scales independently
(`architecture.md` §4, §12). Story 9 may scaffold that split or leave it to Story 17
**[CONFIRM]** — recommend leaving the encoder process to Story 17 but keeping the registry
queue-aware so `encoding` is already a known queue.

---

## 6. Database Design

The columns this story **populates already exist** (added by Story 6 / architecture §7.1).
Story 9 does **not** add `MediaItem` quality columns or `Submission.overallQualityScore` — it
writes them. Confirm presence; if any are missing (Story 6 divergence), add via migration.

### 6.1 Fields populated (no new columns expected)

| Model.field | Type | Written by Story 9 | Value |
|---|---|---|---|
| `MediaItem.qualityScore` | `Float?` | yes | composite 0–100 (0 for corrupt) |
| `MediaItem.qualityFlags` | `String[]` | yes | canonical flags (§5.5.5); `[]` if clean |
| `MediaItem.duration` | `Int?` | yes (VIDEO/VOICE) | seconds; null for PHOTO |
| `MediaItem.width` | `Int?` | yes (VIDEO/PHOTO) | pixels; null for VOICE |
| `MediaItem.height` | `Int?` | yes (VIDEO/PHOTO) | pixels; null for VOICE |
| `Submission.overallQualityScore` | `Float?` | yes | rollup aggregate (§5.7); null if no media |
| `Submission.status` | `SubmissionStatus` | yes (auto-reject only) | `REJECTED` on `<20` per §5.5.6 rule |
| `Submission.adminNote` | `String?` | yes (auto-reject only) | system note, e.g. "Auto-rejected: all media below quality threshold" |
| `AuditLog` row | — | yes (auto-reject only) | `action = 'submission.auto_rejected'` (§11) |
| `NotificationLog` row | — | yes (auto-reject only) | trigger `submission.auto_rejected` (§11) |

### 6.2 Idempotency tracking — does BullMQ alone suffice? (decision)

**Decision: BullMQ alone is sufficient for this story; no dedup table needed.** Justification:

- **In-flight dedup** is handled by the deterministic `jobId` (§5.4) — BullMQ refuses a
  duplicate active/waiting job with the same id.
- **Output correctness across retries/retention** is handled by **output-by-key overwrite**
  (§5.6) — the DB write is naturally idempotent (update the same row to the same value).
- **Side-effect dedup** (the one place a duplicate would be visible — the admin notification)
  is guarded by checking `AuditLog`/`NotificationLog` existence (§5.6), tables that **already
  exist** (architecture §7.1).

Therefore **no new `JobRun`/dedup table** is introduced. (Rejected alternative: a `JobRun`
table keyed by `{event_id}:{submission_id}:{job_type}` with a unique constraint as a
belt-and-braces ledger. It would add observability and a hard dedup guarantee independent of
BullMQ retention, but it is **not required** because each job's output is already idempotent. If
a later story has a **non-idempotent** side effect that can't be guarded via the audit log,
introduce the ledger then. Flagged §13 as a forward-looking option.)

### 6.3 Migration notes

- **Expected: no schema migration in Story 9** (columns exist from Story 6). Run
  `prisma generate` only.
- If Story 6 did **not** add the quality columns (divergence), create an additive migration
  `add_media_quality_fields` adding the nullable `MediaItem` fields + `Submission.
  overallQualityScore`. Additive + nullable → safe `prisma migrate deploy` against
  `swara_prd`, no backfill.
- If the optional `JobRun` ledger is later chosen, that is its own migration in the story that
  needs it — not here.

---

## 7. External Services / Integrations / Config

### 7.1 Redis / BullMQ

- **Reuse the Story 1 Redis singleton** (`src/lib/redis.ts`). It already sets
  `maxRetriesPerRequest: null` (BullMQ requirement for blocking commands) and `lazyConnect`.
- **Connection-sharing rule:** BullMQ `Queue` (producer) can share the existing connection.
  BullMQ `Worker`/`QueueEvents` use **blocking** commands and BullMQ recommends a **dedicated
  connection** for them (a blocking `BRPOPLPUSH`/`bzpopmin` ties up a connection). **Decision:**
  the `Queue` instances (enqueue side, used by web) reuse the shared singleton; each `Worker`
  gets its **own** IORedis connection created from `config.redis.url` with the same options
  (`maxRetriesPerRequest: null`). **[CONFIRM]** — this is the standard BullMQ pattern; document
  it so web routes (which only enqueue) never accidentally open Worker connections.
- BullMQ is a **new dependency** (`bullmq`) — add to `package.json` (it is not currently
  installed; only `ioredis`, `pino`, `prisma`, `zod`, Next are present).
- Local dev Redis is the existing `swara-redis` docker service (port 6379, already in
  `docker-compose.yml`). Production Redis is Upstash (`architecture.md` §4). **Upstash note:**
  BullMQ + Upstash requires a Redis-protocol (not REST) URL and `maxRetriesPerRequest: null`
  (already set); confirm Upstash plan supports the commands BullMQ needs.

### 7.2 FFprobe / FFmpeg availability in the worker runtime

- The worker process invokes **FFprobe** (metadata) and **FFmpeg** (frame sampling for blur,
  audio stats). These binaries must be present in the **worker** runtime — **not** in the
  Vercel web runtime (web never probes; `architecture.md` §4: long-running/CPU work lives on
  Railway/Fly).
- **Binary provisioning options:**
  - (a) Install system `ffmpeg`/`ffprobe` in the worker Docker image (apt/apk). **Recommended
    for the worker service** — full codec support, system-managed.
  - (b) Bundle via an npm package (`ffmpeg-static` / `ffprobe-static`) and read the binary
    path. Simpler local dev (no system install) but heavier images and occasional codec gaps.
  - **Recommendation:** support **both** via a configurable binary path (§7.5): default to
    `ffprobe`/`ffmpeg` on PATH (Docker image installs them), allow override to a static-package
    path for local dev where the dev hasn't installed FFmpeg. **[CONFIRM]** which is the
    canonical dev path.
- **Local dev:** developers either have FFmpeg on PATH or use the static package. Document in
  `development-setup.md` (§8 — out of scope to edit here, but flag the requirement).
- A child-process wrapper (e.g. via `node:child_process` or a thin lib) executes FFprobe/FFmpeg
  with a **timeout** and resource bounds (a malicious/huge file shouldn't hang a worker — §10).

### 7.3 S3 / object storage read access

- Workers need **read** access to fetch media bytes from `MediaItem.storagePath`. Reuse the
  **Story 6 storage service** (already reads `config.storage`). Add a **download/get-stream**
  capability if Story 6's interface only exposed `headObject` + presign (Story 6 §7.2 listed
  `headObject`, `createUploadTarget`, `objectExists`, `buildMediaKey` — a `getObjectStream(key)`
  or `downloadToFile(key, tmpPath)` is needed here). **[CONFIRM]** add that method to the
  storage service in this story.
- The worker's storage credentials (`S3_*`) must be set in the **worker** environment
  (Railway/Fly), scoped read (and at minimum read on `events/.../media/`). Per §16 secrets,
  these live in the host's env vars; the worker reads `config.storage`, never `process.env`.
- Local dev: MinIO (`swara-minio`, already in compose); the worker reads from it the same way
  the web app writes to it.

### 7.4 Encoder pool note (Story 17, but topology-relevant)

`encoding` is FFmpeg-heavy and runs in a **separate worker pool** (`architecture.md` §4) to
avoid head-of-line blocking against AI/quality jobs. Story 9 keeps `encoding` as a **declared
queue** but ships **no** encoder process. The registry being queue-aware now means Story 17 only
adds the encoder entry + processor. (Quality scoring uses FFprobe/FFmpeg too but is light and
stays in the main worker pool per §8.1.)

### 7.5 Config — wire through BOTH config files

Per the load-bearing convention (Story 1, `development-setup.md` §7; no `process.env` outside
`src/config/`). Add a **`queue`/`worker`** block. (Storage `S3_*` already added by Story 6.)

**Add to `src/config/env.ts`** (raw reads only):

| Raw key | Source env var | Purpose |
|---|---|---|
| `WORKER_CONCURRENCY_QUALITY` | `process.env.WORKER_CONCURRENCY_QUALITY` | Override `quality` Worker concurrency (default 16) |
| `FFPROBE_PATH` | `process.env.FFPROBE_PATH` | Path to `ffprobe` binary (default `ffprobe` on PATH) |
| `FFMPEG_PATH` | `process.env.FFMPEG_PATH` | Path to `ffmpeg` binary (default `ffmpeg` on PATH) |
| `QUALITY_FLAG_THRESHOLD` | `process.env.QUALITY_FLAG_THRESHOLD` | Composite below which to flag (default 40) **[CONFIRM tunable]** |
| `QUALITY_REJECT_THRESHOLD` | `process.env.QUALITY_REJECT_THRESHOLD` | Composite below which to auto-reject (default 20) |
| `MEDIA_PROBE_TIMEOUT_MS` | `process.env.MEDIA_PROBE_TIMEOUT_MS` | Per-file FFprobe/FFmpeg timeout (default e.g. 60000) |

> **[CONFIRM]** whether per-signal normalization thresholds + composite **weights** belong in
> env (operationally tunable) or in a versioned in-code constants module. **Recommendation:**
> keep the **flag/reject thresholds** and binary paths + concurrency in config/env (operators
> tune them), but keep the **scoring weights + per-signal normalization curves** in a
> versioned in-code module (so a weight change is a reviewed code change, not an env tweak that
> silently shifts every score). Record the weight/threshold "version" alongside results if we
> later need to correlate (mirrors `AiArtifact.promptVersions` thinking). Flagged §13.

**Add to `src/config/index.ts`** — a `worker` (or `queue`) object on the Zod schema:

| Config field | Type | Mapping / default |
|---|---|---|
| `worker.concurrency.quality` | `z.coerce.number().int().positive()` | `WORKER_CONCURRENCY_QUALITY` ?? 16 |
| `worker.ffprobePath` | `z.string()` | `FFPROBE_PATH` ?? `'ffprobe'` |
| `worker.ffmpegPath` | `z.string()` | `FFMPEG_PATH` ?? `'ffmpeg'` |
| `worker.probeTimeoutMs` | `z.coerce.number().int().positive()` | `MEDIA_PROBE_TIMEOUT_MS` ?? 60000 |
| `quality.flagThreshold` | `z.coerce.number()` | `QUALITY_FLAG_THRESHOLD` ?? 40 |
| `quality.rejectThreshold` | `z.coerce.number()` | `QUALITY_REJECT_THRESHOLD` ?? 20 |

Add the new keys to `.env.example` under a `# === Redis / BullMQ / Workers ===` block (the file
currently lists `REDIS_URL` and reserves later vars in a comment). **[CONFIRM]** exact defaults.

### 7.6 New npm dependency

- `bullmq` (runtime) — the queue/worker library (not yet installed).
- (If chosen for FFmpeg provisioning) `ffmpeg-static` / `ffprobe-static` (and types) — see
  §7.2. **[CONFIRM]** whether to bundle or rely on system binaries.

---

## 8. Seed Data

Reuse / extend the seed path. **Note:** the Story 6 design proposes a `npm run seed` script
that creates 3 sample `MediaItem` rows (one VIDEO, VOICE, PHOTO) and uploads matching dummy
objects to MinIO. That seed is **a prerequisite for exercising this worker locally**; if the
seed script does not yet exist on `main`, this story must ensure it does (coordinate with Story
6 — the seed is owned there but consumed here).

For Story 9 specifically:

- **Media needing scoring:** the seeded `MediaItem` rows have `qualityScore = null` (Story 6
  leaves them null). Running the worker should populate them. The seeded dummy objects must be
  **real, FFprobe-parseable** files (a tiny valid MP4, a few-second MP3, a small JPG) — not
  zero-byte placeholders — so FFprobe returns real metadata locally. **[CONFIRM]** Story 6's
  seed uses valid tiny media (the Story 6 doc says "a 1×1 PNG, a few-byte MP3, a tiny MP4" — a
  "few-byte MP3" may not be FFprobe-parseable; ensure the seed assets are genuinely valid).
- **A deliberately low-quality asset (optional):** add one seeded asset that scores `<40`
  (and/or one `<20`) so the flag and auto-reject paths are exercisable locally without crafting
  a file by hand. **[CONFIRM]** include a "bad" sample (e.g. heavily compressed/blurry image).
- **Run-the-worker-locally recipe** (document in this story / dev-setup): `docker compose up -d`
  (Redis + MinIO), `npm run seed`, `npm run workers` → the quality processor picks up jobs.
  For local end-to-end without going through the web submit, provide a small **enqueue helper /
  script** (e.g. `npm run enqueue:quality -- <mediaItemId>` or a seed step that enqueues jobs
  for all unscored media) so a dev can trigger scoring without filling out the contributor
  form. **[CONFIRM]** add a dev enqueue script.

---

## 9. Testing

Follows the Story 1 / Story 6 pattern (Vitest, `tests/unit` + `tests/integration`).
Integration tests that need real Redis/MinIO are guarded by **`SKIP_INTEGRATION`** so unit-only
runs (and CI without Docker) stay green.

### 9.1 Unit (no infra; pure logic)

| Test | Asserts |
|---|---|
| Idempotency key generation | `buildJobKey()` produces exactly `{eventId}:{submissionId}:quality.score_media:{mediaItemId}` (or the confirmed shape); stable for the same inputs; distinct per media item |
| Scoring math — VIDEO | given fixture FFprobe/FFmpeg signal values, the weighted composite matches expected 0–100; weights sum to 1.0 |
| Scoring math — VOICE | same, voice weights/signals |
| Scoring math — PHOTO | same, photo weights/signals |
| Sub-score normalization | threshold boundaries (at threshold vs ±1) map to expected sub-scores |
| Threshold classification | `score=40`→pass, `39`→flag, `20`→flag, `19`→auto-reject; `corrupt`→0→auto-reject |
| Flag derivation | each signal below its threshold adds the correct flag string; clean signals → `[]`; `portrait` set without lowering score |
| Auto-reject submission rule | the confirmed rule (single `<20` vs all-media-`<20`) yields the right `Submission.status` decision given a set of per-media scores |
| Rollup aggregate | `overallQualityScore` = the confirmed aggregate of non-null sibling scores; null when no scoreable media; recompute-from-DB is order-independent |
| Corrupt vs infra-failure classification | a parse-failure verdict → score 0/auto-reject (no throw); a transient/storage error → throw (retry) |
| Side-effect dedup | given an existing `AuditLog`/`NotificationLog` row, the notify step no-ops |
| Re-run safety | running `scoreMedia()` twice on the same fixture writes the same row values (output-by-key overwrite) |

> Keep the scoring as a **pure function** (`scoreMedia(signals, type, config) → {score, flags}`)
> separated from FFprobe I/O and DB writes, so the math is unit-tested without binaries or a DB.
> FFprobe output is fed as **fixtures** (captured JSON from real probes) to the pure scorer.

### 9.2 Integration (`SKIP_INTEGRATION` guards real Redis + MinIO)

| Test | Flow |
|---|---|
| Enqueue → process → DB update (happy path) | Seed a `MediaItem` + upload a valid tiny media object to MinIO → `enqueue(quality, …)` → run the Worker (or process one job) → assert `MediaItem.qualityScore`/`duration`/`width`/`height` populated and `overallQualityScore` rolled up |
| Idempotent re-enqueue | Enqueue the same `quality.score_media` twice (same payload) → assert only one job processed / final row identical; no duplicate notification |
| Auto-reject path | Seed a `<20` (or corrupt) asset → process → assert `Submission.status = REJECTED`, `adminNote` set, one `AuditLog` `submission.auto_rejected`, one `NotificationLog` admin alert |
| Retry on transient failure | Force a transient storage error (e.g. point at a missing key, or stub a throw) → assert the job retries up to `attempts` then lands in `failed`; `MediaItem.qualityScore` stays null (not auto-rejected by infra failure) |
| Graceful shutdown | Start the Worker, enqueue a job, send SIGTERM mid-drain → assert in-flight job completes or is re-queued (not lost) |
| Deleted-media no-op | Enqueue, delete the `MediaItem` (cascade) before processing → assert job no-ops success |

### 9.3 Mocking FFprobe

- **Unit tests** never invoke FFprobe — they feed captured FFprobe/FFmpeg **fixtures** to the
  pure scorer (§9.1) and mock the storage `getObjectStream`/`downloadToFile`.
- **Integration tests** prefer **real** FFprobe against tiny valid seeded assets (proves the
  probe wrapper works). Where FFmpeg isn't available in CI, a **mockable probe interface** lets
  the test inject canned signal output so the enqueue→process→DB plumbing is still exercised.
  **Decision:** the FFprobe call sits behind a small `probeMedia(path) → signals` interface so
  it can be mocked in CI and run for real locally. **[CONFIRM]** whether CI installs FFmpeg
  (matches §10's "CI runs unit always; integration where infra available", Story 6 §9.3).
- CI: unit always; integration via a Redis service (mirror Story 1's `services:` Redis) +
  optionally a MinIO service (mirror Story 6); else `SKIP_INTEGRATION=true`.

---

## 10. Security

- **Worker access scoping.** Worker S3 credentials are **read-scoped** (ideally to the
  `events/.../media/` prefix) — the quality worker never needs write to media. Credentials live
  only in the worker host env (§16). No public access; objects are private ACL (Story 6 / arch
  §7.2).
- **Malformed / corrupt / hostile file handling.** Media comes from anonymous contributors —
  treat every byte as untrusted:
  - Run FFprobe/FFmpeg with a **hard timeout** (`config.worker.probeTimeoutMs`) and bounded
    output; kill the child process on timeout → treat as `corrupt`/infra-failure per §5.8
    classification.
  - Cap **frame sampling** (N frames) and decode work so a crafted file can't make FFmpeg burn
    unbounded CPU/RAM ("decompression bomb"). Bound temp-file size to the known `sizeBytes`.
  - **Always clean up** temp files in `finally` (no disk leak across the long-running worker).
  - A probe crash must not crash the **Worker process** — the processor catches, classifies,
    and either fails the job (retry) or records a verdict; one bad file never takes down the
    pool.
- **No honoree exposure.** Quality scoring touches media + submission/event metadata only;
  it sends **no** contributor/honoree communication. The single notification it triggers is the
  **admin** auto-reject alert (internal). It must route through the shared notification
  dispatcher so the honoree-email suppression filter (`architecture.md` §10.1) still applies —
  though recipient here is admin, never honoree. **Do not** log media bytes, presigned URLs, or
  PII filenames in worker logs (mirror Story 6 §11 redaction).
- **ClamAV (deferred from Story 6 §7.4).** Virus scanning could ride this same worker as a
  sibling job, but it is **out of scope** for Story 9 unless explicitly added. Flagged so it
  isn't lost (§13). Until then, the worker should still defensively bound resource use as above.
- **Payloads contain ids only** (§5.3) — no secrets in queue data (queue contents are visible
  to anyone with Redis access).

---

## 11. Observability / Audit

**Metrics (per `architecture.md` §13 — "Workers: job durations, retry counts, success/failure
rates, queue depth").** Emit metric-shaped structured logs now; wire to OpenTelemetry when the
observability story lands. Per-job / per-queue:

| Metric | Dimension | Why |
|---|---|---|
| Job duration | queue, job_type, outcome | spot slow probes; §13 alert "queue depth > 100" context |
| Retry count / attempts used | queue, job_type | detect flaky storage / bad-file spikes |
| Success / failure / auto-reject counts | queue, outcome | `failed` spike = infra problem; `auto_reject` spike = upload-quality problem |
| Queue depth (waiting/active/failed) | queue | autoscaling signal (`architecture.md` §12) + the §13 critical alert "queue depth > 100 for any high-priority queue" (`quality` is High) |
| Score distribution | media_type | tune thresholds/weights over time |

**Structured logs** (Story 1 `logger`): job start (`eventId`, `submissionId`, `mediaItemId`,
`queue`, `jobId`), job result (score, flags, classification, duration), retries, failures
(error class, attempt n). **Never** log bytes, URLs, or PII filenames.

**Trace correlation** (`architecture.md` §13): include `event_id` + `submission_id` (+
`media_item_id`) as span/log attributes so a submission can be traced form-submit → quality →
(later) analysis → admin-notification.

**Audit (`AuditLog`)** — on **auto-reject** write a row:

| Field | Value |
|---|---|
| `action` | `submission.auto_rejected` |
| `eventId` | the event |
| `actorId` | `null` (system event — architecture §7.1 allows null actor) |
| `metadata` | `{ submissionId, mediaScores: [...], overallQualityScore, reason: 'all media below reject threshold', thresholdVersion }` |

This `AuditLog` row is also the **dedup source of truth** for the notification (§5.6) and the
record retained de-identified through right-to-delete (architecture §11.4).

**Notification (`NotificationLog`) + admin alert** — on auto-reject enqueue an admin
notification (trigger `submission.auto_rejected`, `recipientType = admin`). Log the send to
`NotificationLog` (architecture §7.1). The actual email send goes through the
notifications dispatcher (the dispatcher's processor may not fully exist until its own story —
**[CONFIRM]** whether Story 9 ships a minimal admin-email send or only enqueues +
records the intent). At minimum, the **audit + notification-intent record** is written here so
nothing is silently dropped.

---

## 12. Definition of Done

- [ ] `bullmq` added to `package.json`; queue registry module exists (single place queues are
      constructed), exporting typed queue names, job names, `Queue` instances, and the
      `enqueue` helper that always sets the deterministic `jobId`.
- [ ] `buildJobKey()` produces the canonical idempotency key
      `{eventId}:{submissionId}:quality.score_media:{mediaItemId}` (confirmed shape); unit-tested.
- [ ] `src/workers/index.ts` registers the `quality` Worker (replacing the idle keepalive),
      reads concurrency from config, and shuts down gracefully on SIGINT/SIGTERM (drains
      in-flight jobs, then `redis.quit()`).
- [ ] `quality.score_media` processor: fetches the `MediaItem`, streams bytes from storage,
      probes with FFprobe/FFmpeg, computes the 0–100 composite per media type, derives flags,
      writes `qualityScore`/`qualityFlags`/`duration`/`width`/`height`, and rolls up
      `Submission.overallQualityScore`.
- [ ] Flag `<40`; auto-reject `<20` per the confirmed submission-level rule, with `AuditLog`
      `submission.auto_rejected` + admin `NotificationLog` (deduped via audit/notification
      existence on retry).
- [ ] Story 6 submit action enqueues one `quality.score_media` job per persisted `MediaItem`,
      **after** commit; enqueue failure does not roll back the submission.
- [ ] Retry policy: `attempts = 3`, exponential backoff; infra failures retry, corrupt-file
      verdicts do not; exhausted attempts leave `qualityScore = null` (not auto-rejected).
- [ ] Config: `worker`/`quality` block (concurrency, FFprobe/FFmpeg path, probe timeout, flag/
      reject thresholds) added in **both** `src/config/env.ts` and `src/config/index.ts`;
      `.env.example` updated; no `process.env` reads outside `src/config/`.
- [ ] Storage service gains a read/download method; worker reads media via `config.storage`.
- [ ] FFprobe/FFmpeg available in the worker runtime (Docker image installs them or static
      package); worker deployment target (Railway/Fly) documented.
- [ ] Scoring is a pure, unit-tested function fed by FFprobe fixtures; idempotency key,
      thresholds, flags, rollup, and corrupt-vs-infra classification unit-tested.
- [ ] Integration tests (enqueue→process→DB update, idempotent re-enqueue, auto-reject,
      retry-on-transient, graceful shutdown, deleted-media no-op) pass against Redis + MinIO and
      skip cleanly under `SKIP_INTEGRATION`.
- [ ] Seed produces FFprobe-parseable media (valid tiny files) incl. at least one low-quality
      asset; a documented local recipe runs the worker end-to-end (incl. a dev enqueue path).
- [ ] Metrics-shaped logs (durations, retries, queue depth, outcomes) emitted; no bytes/URLs/PII
      in logs.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green.
- [ ] No TODO comments left in committed code.

---

## 13. Open Questions / Assumptions

| # | Item | Recommendation / default | Needs |
|---|---|---|---|
| 1 | **Exact composite formula & weights** per media type | VIDEO {res .25, bitrate .20, audio .25, sharp .30}, VOICE {audio .55, rate .20, dur .25}, PHOTO {res .35, sharp .45, exposure .20} | **[CONFIRM]** |
| 2 | **Per-signal normalization thresholds** (what "good" bitrate / peak dB / sharpness / resolution mean) | Define a starting table; keep weights+curves in a versioned in-code module, flag/reject thresholds in config | **[CONFIRM]** |
| 3 | **Blur (Laplacian variance) approach** | FFmpeg-only edge/high-pass + frame stats, OR sample frames to PNG + in-process Laplacian; **N=5** sampled frames for video, evenly spaced, skip first/last second | **[CONFIRM] N, sampling positions, library** |
| 4 | **Exposure (photo) histogram check** | Detect over/under-exposed via luminance histogram clipping; thresholds TBD | **[CONFIRM]** |
| 5 | **Idempotency key shape for per-media jobs** | Append `:{mediaItemId}` as a 4th segment; one `buildJobKey()` helper | **[CONFIRM]** |
| 6 | **Per-media vs per-submission job granularity** | One job per media item (`quality.score_media`); rollup via recompute-from-DB | **[CONFIRM]** |
| 7 | **Auto-reject scope** (one `<20` media vs whole submission) | Auto-reject submission only when **no** media item scores ≥20; a single bad file flags but doesn't reject | **[CONFIRM]** |
| 8 | **Flagged → `Submission.status = FLAGGED`?** | No — flag per-media (`qualityFlags`), keep submission `PENDING`; admin sees per-file flags | **[CONFIRM]** |
| 9 | **Rollup aggregate** for `overallQualityScore` | Mean of non-null sibling scores | **[CONFIRM] mean vs min vs weighted** |
| 10 | **Canonical `qualityFlags` vocabulary** (incl. `no_audio`, `clipping`, `too_short`, umbrella `low_quality`) | Freeze the §5.5.5 list with Story 7 | **[CONFIRM]** |
| 11 | **Declare all 9 queues now vs declare-as-needed** | Declare all (single source-of-truth topology); ship processor only for `quality` | **[CONFIRM]** |
| 12 | **Story 9 ships a notifications processor or only enqueues** | Enqueue + record intent now; full dispatcher in its own story (minimal admin email optional) | **[CONFIRM]** |
| 13 | **No dedup/`JobRun` table** (rely on BullMQ jobId + output-by-key + audit dedup) | Confirmed sufficient for this story; introduce a ledger only if a future job has a non-idempotent, non-audit-guardable side effect | **[CONFIRM]** |
| 14 | **FFmpeg provisioning** (system binary vs `ffmpeg-static`/`ffprobe-static`) | Configurable path; system binary in worker image, static for local dev | **[CONFIRM] canonical dev path** |
| 15 | **Worker deploy target for dev** | Run locally (`npm run workers`) against docker Redis+MinIO; production worker on Railway/Fly (arch §4) — pick the provider | **[CONFIRM provider]** |
| 16 | **Shared vs dedicated Redis connection for Worker** | Queue (web/enqueue) reuses the singleton; each Worker gets its own connection (BullMQ blocking-command best practice) | **[CONFIRM]** |
| 17 | **Re-enqueue/backfill sweep for unscored media** | Minimal cron/admin re-enqueue of `qualityScore IS NULL` media (idempotent); may defer to Story 18 cron infra | **[CONFIRM ship vs defer]** |
| 18 | **ClamAV virus scan** (deferred from Story 6) | Could ride this worker as a sibling job; out of scope for Story 9 unless explicitly added | **[CONFIRM where it lands]** |
| 19 | **`removeOnComplete`/`removeOnFail` retention** | Bounded `removeOnComplete` (e.g. last 1000), keep `removeOnFail` for inspection | **[CONFIRM counts]** |
| 20 | **Story 6 seed assets are FFprobe-valid** | Ensure seeded "few-byte MP3"/MP4 are genuinely parseable; add a deliberately low-quality + a `<20` sample | **[CONFIRM with Story 6]** |
| 21 | **CI installs FFmpeg** | Probe behind a mockable interface so CI plumbing tests run without FFmpeg; install FFmpeg in CI only if running real-probe integration | **[CONFIRM]** |
