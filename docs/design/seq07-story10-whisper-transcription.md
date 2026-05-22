# Sequence 07 / Story 10 — Whisper Transcription

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (queue + job names, payload shapes, idempotency key templates, skip logic,
retry/backoff, transcript persistence shape, failure marking, mock-mode behavior, error
cases) so later code generation is unambiguous. Where a value is a proposal awaiting
confirmation it is flagged **[CONFIRM]**.

| Field | Value |
|---|---|
| Story number / title | Story 10 — Whisper transcription |
| Epic | E — AI Pipeline |
| Sequence number | 7 (this is the 7th design in build order) |
| Depends on | Story 9 (Worker infrastructure + quality scoring — the BullMQ queue registry, `enqueue` helper, idempotency `jobId` convention, worker bootstrap, storage download method, config/env pattern) |
| Also assumes on `main` | Story 1 (config `env.ts`/`index.ts`, `db`, `redis` singleton, `logger`, worker scaffold, CI), Story 3 (`Event` model), Story 5 (`Submission` model + `transcript` column), Story 6 (`MediaItem` model, `MediaType` enum, storage service, `S3_*` config, the submit flow that enqueues pipeline jobs) |
| Unlocks | Story 11 (Claude analysis — consumes `Submission.transcript` for sentiment/quotes/tags), Story 16 (subtitles align Whisper word timestamps to clip cuts) |
| Complexity | M (1–3 days) |

> **Why this story copies, not invents.** Story 9 (`seq06-story09-workers-quality-scoring.md`)
> is the load-bearing infrastructure story: it defines the **one** way the codebase declares
> queues, enqueues jobs, builds idempotency keys, retries, and runs the worker process. Story 10
> adds a queue **processor** (`transcription`) and a job (`transcribe.media`) and reuses Story
> 9's registry, `enqueue` helper, `buildJobKey()`, worker bootstrap, and storage download method
> **verbatim**. Story 10 introduces exactly one new external integration (OpenAI Whisper) and
> one new config block (`ai.*`). It does **not** re-implement queue infrastructure.

---

## 1. Story Summary

After Story 9, the worker process runs BullMQ, the `transcription` queue is **declared** in the
registry (concurrency 8, High priority — `architecture.md` §8.1) but has **no processor**, and
`Submission.transcript` (`@db.Text`, from Story 5 / `architecture.md` §7.1) is left **null**.

Story 10 adds the **transcription leaf** of the AI pipeline DAG (`architecture.md` §6.3 —
`transcribe` runs in parallel with `quality`, both feeding `analyze`):

1. **A per-media transcription job** (`transcribe.media`, queue `transcription`) that runs
   **only for VIDEO and VOICE** media items. PHOTO is skipped. Submissions with no audio/video
   media never enqueue a transcription job at all (`requirements.md` §5.3 — "skip if none
   uploaded").
2. **OpenAI Whisper integration** (model from `config.ai.whisperModel`, default `whisper-1` per
   `architecture.md` §14), with a **mock mode** (`AI_MOCK_MODE`) that routes to deterministic
   canned transcripts for offline/CI runs (`development-setup.md` §4).
3. **Transcript persistence** in two places (`architecture.md` §7.1, §7.2): the raw Whisper
   JSON **with word timestamps** is written to S3 at
   `events/{event_id}/submissions/{submission_id}/transcripts/{media_id}.json`; the **plain
   text** is persisted to the database (`Submission.transcript` — the concatenation of the
   submission's per-media transcripts; see §6 for the per-media vs per-submission decision).
4. **Graceful degradation**: a Whisper timeout/error retries **3× with backoff**; if all fail,
   the media item is marked **`transcription_failed`** and the pipeline **proceeds without it**.
   The admin sees the flag in the dashboard and can request a manual transcript
   (`architecture.md` §6.3, §11.1).

Sentiment/quote extraction (Story 11), subtitle alignment to clip cuts (Story 16), and any
analysis are **out of scope** — Story 10 only produces transcripts; downstream stories consume
them.

---

## 2. Scope

### In scope

- **The `transcription` queue processor** (concurrency 8, High — `architecture.md` §8.1;
  declared by Story 9, processor added here) and its job `transcribe.media`.
- **Per-media transcription job**: inputs (`mediaItemId` + ids), runs **only** for VIDEO/VOICE,
  **skips** PHOTO, streams bytes from storage, calls Whisper (model from config) or the mock.
- **Skip-when-no-AV**: the enqueue point only enqueues transcription for media items of type
  VIDEO or VOICE; text-only / photo-only submissions produce no transcription job.
- **Transcript persistence**: raw word-timestamp JSON → S3; plain text → DB
  (`Submission.transcript`, concatenated across the submission's media). See §6 for the storage
  shape decision and a per-media DB option.
- **Failure marking**: after retries exhaust, mark the media item `transcription_failed`
  (mechanism decided in §6 — a flag in `MediaItem.qualityFlags` vs a dedicated field) and let
  the pipeline proceed.
- **Mock mode** (`AI_MOCK_MODE=true`) routing to deterministic mocks + a `__mocks__/openai`
  module for unit tests (`development-setup.md` §4).
- **Config**: `OPENAI_API_KEY`, `WHISPER_MODEL`, `AI_MOCK_MODE` wired through **both**
  `src/config/env.ts` and `src/config/index.ts` (the load-bearing convention).
- **Idempotency**: reuse Story 9's `{event_id}:{submission_id}:{job_type}` key pattern with a
  per-media segment (§5.4).
- **Enqueue-on-submit / parallel-with-quality wiring**: the Story 6 submit action (already
  enqueuing `quality.score_media` per Story 9) also enqueues `transcribe.media` for VIDEO/VOICE
  media (§5.3) — the two run in parallel per the §6.3 DAG.
- **Worker registration** of the `transcription` Worker in `src/workers` (alongside Story 9's
  `quality` Worker).
- **Seed**: canned mock transcripts for known fixture audio/video so a local run produces
  transcripts without real API calls.
- **Tests**: skip-when-no-AV, transcript persisted (DB + S3), retry→fail→mark logic, mock-mode
  determinism; integration enqueue→transcribe[mock]→DB+S3; real-API integration gated.

### Out of scope (deferred)

| Item | Where it lands | Note |
|---|---|---|
| Sentiment / quote extraction / tags from the transcript | Story 11 | Story 11 reads `Submission.transcript`; Story 10 only writes it |
| Subtitle (.srt) generation + aligning Whisper word timestamps to clip cuts | Story 16 | Story 10 persists the **raw word-timestamp JSON** to S3 so Story 16 has the source data; it does **not** produce `.srt` or align to cuts |
| The pipeline **fan-in** (transcribe + quality → analyze) coordinator | Story 11/12 | Story 10 emits the `transcribe` leaf only; it does not chain `analyze` |
| Language **translation** to a target language | Out of MVP 1 | Whisper `transcribe` (verbatim, source language) only; translation endpoint not used (§13) |
| Manual transcript entry by admin (the "request a manual transcript" UI) | Story 7/8-adjacent | Story 10 sets the `transcription_failed` flag; the admin action to supply a manual transcript is a separate, later concern (§4, §13) |
| Self-hosted Whisper | MVP 2 / cost-driven (`development-setup.md` §2 Phase C) | Whisper API only in MVP 1 |
| Chunking/segmenting audio that exceeds Whisper's per-request size limit | §13 open question | Flagged; recommend a max-duration guard now, full chunking deferred unless needed |

---

## 3. Dependencies & Sequence

**Must already be on `main`:**

- **Story 9** — the BullMQ **queue registry** (the single place queues are constructed,
  exporting typed queue names + job names + `Queue` instances), the **`enqueue` helper** (sets
  the deterministic `jobId`, validates payload, applies per-queue defaults), **`buildJobKey()`**,
  the **worker bootstrap** in `src/workers/index.ts` (registers Workers, graceful shutdown,
  concurrency from config), the **storage download method** added in Story 9 §7.3
  (`getObjectStream(key)` / `downloadToFile(key, tmpPath)`), and the **config/env conventions**
  for a `worker` block. The `transcription` queue is already **declared** in the registry by
  Story 9 (concurrency 8, High); Story 10 attaches its processor.
- **Story 1** — `src/config` (`env.ts` + `index.ts`), `src/lib/db.ts`, `src/lib/redis.ts`
  (IORedis singleton, `maxRetriesPerRequest: null`, `lazyConnect`), `src/lib/logger.ts`, CI,
  docker-compose (Redis + MinIO).
- **Story 5** — `Submission` model including the `transcript String? @db.Text` column
  (`architecture.md` §7.1). Story 10 **writes** this column; it does not define it. If Story 5
  did not add it (divergence), add via additive migration (§6.3).
- **Story 6** — `MediaItem` model + `MediaType` enum, the **storage service** (key helpers,
  `headObject`, and — via Story 9 — a download/stream method), and `S3_*` config in both config
  files. Story 10 reads `MediaItem.storagePath` / `type` and fetches bytes.

> **`maxRetriesPerRequest: null` is mandatory for BullMQ Workers.** Reuse the Story 1 singleton
> for the **enqueue side**; each **Worker** gets its own connection per Story 9 §7.1's
> connection-sharing rule. Story 10 does not change this — it registers a new Worker following
> the same pattern.

**Provides to later stories:**

- `Submission.transcript` populated → **Story 11** (Claude analysis: sentiment/quotes/tags reads
  the transcript) and Story 16 (narration script uses transcripts).
- The **raw word-timestamp JSON** at `…/transcripts/{media_id}.json` → **Story 16** (subtitle
  generation / alignment to clip cuts).
- The **AI service + mock-mode pattern** (`AI_MOCK_MODE` switch, `__mocks__/openai`) → **Story
  11** reuses the same mock-routing convention for Claude (see `development-setup.md` §4 sample
  `MockAiClient`). Design the OpenAI client wrapper so Story 11's Anthropic client follows the
  same shape.
- The `transcription_failed` flag → **Story 7** admin detail surfaces it (read-only); **Story
  12** routing analyzer may treat transcription-failed media as a (mild) signal **[CONFIRM]**.

**Sequencing notes:**

- Story 10 depends on Story 9's infrastructure and Story 6's media rows; it cannot run before
  media exists and the worker runs BullMQ.
- Story 11 (Claude analysis) is the immediate next consumer of `Submission.transcript`. Design
  the AI client wrapper + mock convention here so Story 11 is purely additive.
- Coordinate the **enqueue point** with Story 6's submit action + Story 9's enqueue line (§5.3)
  and the **admin read-only surface** with Story 7 (§4).

---

## 4. Frontend / UI Design

**Mostly N/A.** Story 10 is worker/integration work; it ships no contributor- or
organizer-facing UI.

**Optional, read-only, coordinate with Story 7 (admin dashboard).** Two pieces of Story 10
output may surface in the admin per-event detail view (`requirements.md` §5.5). This story
**produces** the data; Story 7 **renders** it.

| Surface | Field source | Display (Story 7 renders) |
|---|---|---|
| Transcript text | `Submission.transcript` (null = "not transcribed / none") | read-only collapsible text block on the submission detail; null shows "no transcript" |
| Transcription-failed flag | the `transcription_failed` marker (per §6 — flag string or field) on a `MediaItem` | warning chip "transcription failed" on the affected file row; admin sees a "request manual transcript" affordance (the action itself is later — §13) |

No write/edit UI in this story. The admin action to **supply a manual transcript** (replacing a
`transcription_failed` result) is **out of scope** — Story 10 only sets the flag and surfaces
it (`architecture.md` §6.3: "admin sees a flag … and can request a manual transcript" — the
flag is Story 10; the request workflow is later). **[CONFIRM]** the exact flag string and the
transcript display contract with Story 7 so the admin UI keys on a known value.

---

## 5. Backend / Worker Design

### 5.1 Queue topology (this story)

From `architecture.md` §8.1. Story 9 **declared** the `transcription` queue; Story 10
**implements its processor**. No other queue changes.

| Queue | Concurrency | Priority | Implemented in Story 10? | Notes |
|---|---|---|---|---|
| `transcription` | **8** | High | **Yes (processor + enqueue line)** | Whisper API; the longest single job; concurrency **capped at 8 to respect Whisper API rate limits** (`architecture.md` §8.1, §12) |
| `quality` | 16 | High | (Story 9) | Runs **in parallel** with transcription per the §6.3 DAG |
| `analysis` | 4 | High | (Story 11) | Consumes the transcript downstream |

> **Concurrency 8 is deliberate and rate-limit-driven.** Unlike `quality` (16, local CPU work),
> `transcription` hits an external rate-limited API. Concurrency is set on the `Worker`
> (per-process); with multiple worker replicas, **effective concurrency = 8 × replica count** —
> document this so autoscaling (`architecture.md` §12) doesn't silently exceed Whisper's rate
> limit. **[CONFIRM]** whether a single shared rate-limit pool across replicas is needed in MVP
> 1 (recommend: no — cap per-process at 8 and keep replica count modest in MVP 1; revisit with
> a distributed limiter only if 429s appear).

**Priority semantics:** reuse Story 9's High/Normal/Low → numeric mapping (e.g. High=1). The
`transcription` queue is High priority — transcripts are on the critical path to `analyze`.

### 5.2 Job naming & registry

Reuse Story 9's registry module (the single place queues are constructed). Story 10 adds **one
job name** to the typed job-name enum/const:

| Job name (`job_type`) | Queue | Payload (§5.3) | Purpose |
|---|---|---|---|
| `transcribe.media` | `transcription` | `{ eventId, submissionId, mediaItemId }` | Transcribe ONE audio/video media item |

> **Per-media granularity (decision, mirrors Story 9).** One job per media item, not per
> submission. Rationale: each `MediaItem` is transcribed and retried independently; one Whisper
> failure shouldn't block a sibling clip; concurrency 8 parallelizes across files; the
> per-media raw JSON path (`…/transcripts/{media_id}.json`) is inherently per-media
> (`architecture.md` §7.2). The **submission-level `transcript` text** is computed by
> recompute-from-DB after each media transcript lands (§5.7), the same coordinator-free pattern
> Story 9 uses for `overallQualityScore`. **[CONFIRM]** granularity (alternative: one
> `transcribe.submission` job looping its AV media — simpler enqueue, coarser retry; rejected
> for the same reasons Story 9 rejected it).

### 5.3 Enqueue point, skip logic & job payload

**When jobs are enqueued.** In the Story 6 submit action, **after** the `Submission` + all
`MediaItem` rows commit (the same post-commit point where Story 9 enqueues `quality.score_media`
per media item). For each persisted `MediaItem`:

- `enqueue(quality, 'quality.score_media', { eventId, submissionId, mediaItemId })` — **always**
  (Story 9, every media type).
- `enqueue(transcription, 'transcribe.media', { eventId, submissionId, mediaItemId })` —
  **only if `mediaItem.type ∈ {VIDEO, VOICE}`** (Story 10, the skip-when-no-AV gate).

So `quality` and `transcription` are enqueued together at the same post-commit moment and run
**in parallel** (`architecture.md` §6.3 DAG: `quality` and `transcribe` are sibling leaves).
There is **no dependency edge** from quality to transcription — neither waits on the other.

**Skip logic (the load-bearing rule — `requirements.md` §5.3, §6.3 DAG "skipped if no
audio/video").**

| Media reality | Transcription job enqueued? |
|---|---|
| Submission has ≥1 VIDEO or VOICE media item | one `transcribe.media` per VIDEO/VOICE item |
| Submission has only PHOTO media | **no** transcription job |
| Submission is text-only (no media) | **no** transcription job (no media rows → no jobs) |
| A single PHOTO item within a mixed submission | that PHOTO item is **skipped**; its VIDEO/VOICE siblings each get a job |

> The skip is enforced **at the enqueue point** (don't enqueue PHOTO). As a **defensive
> belt-and-braces**, the processor also re-checks `mediaItem.type` on run and **no-ops success**
> if handed a PHOTO (so a stray/mis-enqueued job can't crash). **[CONFIRM]** keep the
> processor-side guard (recommended — cheap, robust against enqueue bugs).

> **Coordinate with Story 6 / Story 9.** Story 9 already added "for each created `MediaItem`,
> enqueue `quality.score_media`". Story 10 adds the conditional line "if VIDEO/VOICE, also
> enqueue `transcribe.media`". This is the only change Story 10 makes to the submit path. If
> enqueue fails (Redis down), log + continue (the submission is still valid); a
> backfill/sweep can re-enqueue media with no transcript (see §5.8, §13).

**Payload shape** (`transcribe.media`) — ids only, mirroring Story 9 §5.3:

| Field | Type | Required | Notes |
|---|---|---|---|
| `eventId` | string (cuid) | yes | Idempotency key + storage path + audit context |
| `submissionId` | string (cuid) | yes | Idempotency key + storage path + transcript rollup |
| `mediaItemId` | string (cuid) | yes | The single media item to transcribe; also `{media_id}` in the S3 path |

The payload carries **only ids** (`architecture.md` §8.2 contract #1). The processor re-fetches
the authoritative `MediaItem` row at run time (`storagePath`, `type`, `mimeType`) so a retry
always sees current state. **No** bytes, URLs, or secrets in the payload (queue contents /
logs may capture payloads).

### 5.4 Idempotency key & enqueue helper (reused from Story 9)

Reuse Story 9's `buildJobKey()` and `enqueue` helper unchanged. The BullMQ `jobId` for a
per-media transcription job is the deterministic key with the per-media 4th segment:

```
transcribe.media : key = {eventId}:{submissionId}:transcribe.media:{mediaItemId}
```

(Story 9 §5.4 chose to append `:{mediaItemId}` as a 4th segment to the canonical
`{event_id}:{submission_id}:{job_type}` key; Story 10 follows the **identical** convention so
two media items get distinct keys.) **[CONFIRM]** the per-media key shape matches whatever Story
9 finalized — both stories must use the same `buildJobKey()` output; never hand-format keys.

**Idempotency mechanics (identical to Story 9):**
- **In-flight dedup**: BullMQ refuses a duplicate active/waiting job with the same `jobId`, so a
  double-enqueue (submit retried, sweep + submit both fire) cannot create two jobs for one media
  item.
- **Output-by-key overwrite**: the job writes the **same S3 key** (`…/transcripts/{media_id}.json`,
  overwrite) and updates the **same DB rows** (idempotent recompute of `Submission.transcript`).
  Re-running produces the same result, so the job is safe across BullMQ retention windows.
- `removeOnComplete` bounded + `removeOnFail` kept for inspection — reuse Story 9's defaults
  **[CONFIRM]** retention counts.

The `enqueue` helper validates the payload against a per-job Zod schema before enqueue (typed
end-to-end, `architecture.md` §5).

### 5.5 The transcription job — processor flow

**Processor flow for `transcribe.media`:**

1. **Re-fetch** the `MediaItem` by `mediaItemId` (load parent `Submission`/`Event` for context
   + the storage path). If the row is gone (deleted between enqueue and run — right-to-delete,
   cascade), **no-op success** (nothing to transcribe).
2. **Type guard.** If `mediaItem.type === PHOTO` (should never happen given §5.3), **no-op
   success**. Only VIDEO/VOICE proceed.
3. **Stream/download** the object bytes from storage via the Story 6/9 storage service using
   `MediaItem.storagePath`. Prefer downloading to a temp file (Whisper SDK uploads a file
   stream); clean up in `finally`. Worker needs **S3 read** access (§7.3).
4. **Pre-flight guards** (cheap, before spending an API call):
   - **No-audio guard**: for VIDEO with no audio stream, transcription yields nothing useful.
     If Story 9 has already set a `no_audio` flag (`architecture.md` §9.4 / Story 9 §5.5.5), the
     processor may **skip the API call** and record an empty/absent transcript + (optionally)
     a `transcription_skipped_no_audio` outcome. **[CONFIRM]** whether to short-circuit on
     `no_audio` (recommended — saves cost; but quality and transcription run in parallel so the
     flag may not be set yet — if absent, just attempt and let Whisper return empty).
   - **Max-duration / size guard**: if `duration` (set by Story 9, may be null if parallel) or
     file size exceeds the configured cap (`config.ai.whisperMaxDurationSec` / Whisper's ~25 MB
     request limit), handle per §13 (recommend: attempt; on size rejection, mark
     `transcription_failed` rather than infinite-retry). **[CONFIRM]** the cap + behavior.
5. **Call Whisper** (or the mock — §7.2) requesting **verbatim transcription with word-level
   timestamps**:
   - Endpoint: OpenAI audio **transcriptions** (not translations — §13).
   - Model: `config.ai.whisperModel` (default `whisper-1`).
   - Response format / granularity: request **`verbose_json` with `timestamp_granularities:
     ["word"]`** so the raw output includes word timestamps (`architecture.md` §7.2: "Whisper
     raw output with word timestamps"). **[CONFIRM]** the exact request params for the chosen
     model (newer transcription models report timestamps differently — pin to a model that
     returns word timestamps, or fall back to segment timestamps + flag the limitation; §13).
   - Language: **auto-detect** (do not force a language in MVP 1 — `requirements.md` §9 "no
     multi-language UI" refers to the product UI, not the contributor audio, which may be any
     language). The detected language is captured in the raw JSON. **[CONFIRM]** auto-detect vs
     a configurable default (§13).
   - Timeout: a hard request timeout (`config.ai.whisperTimeoutMs`) — on timeout, **throw** so
     BullMQ retries (§5.8).
6. **Persist outputs by key** (§5.6):
   - Write the **raw Whisper JSON** (verbatim API response, incl. word timestamps + detected
     language) to S3 at `events/{eventId}/submissions/{submissionId}/transcripts/{mediaId}.json`
     (overwrite).
   - Recompute and write the submission-level **plain text** to `Submission.transcript` (§5.7).
7. **Token / cost logging** — log model, audio duration, and (where the API returns it) usage
   for cost tracking (§11). Whisper bills per audio-minute, not tokens; log `duration`.
8. **On permanent failure** (after retries exhaust — §5.8): mark the media item
   `transcription_failed` (§6), leave `Submission.transcript` as the concatenation of whatever
   **did** transcribe (the failed item simply contributes nothing), write an audit/metric, and
   let the pipeline proceed (`architecture.md` §6.3, §11.1).

### 5.6 Output-by-key & side-effect idempotency

**Output-by-key (the two writes).**
- **S3 raw JSON**: written to the deterministic key `…/transcripts/{media_id}.json` — re-running
  overwrites the same object (no duplicates). This is the "outputs written by deterministic
  key … overwrites by key" rule (`architecture.md` §8.2 #2).
- **DB `Submission.transcript`**: recomputed from the submission's per-media transcripts
  (§5.7) — idempotent (same inputs → same concatenation).

**Side-effect idempotency (the `transcription_failed` marking + any admin notification).**
- Marking a `MediaItem` `transcription_failed` is naturally idempotent (setting the same flag
  twice is the same state).
- **Sustained-failure alerting** (§11) is the only place a duplicate would be visible. Story 10
  does **not** raise a per-media admin notification on a single transcription failure (unlike
  Story 9's auto-reject) — a failed transcript is a soft degrade, surfaced as a dashboard flag,
  not an alert. The **observability alert** is on **sustained** failures across many jobs
  (`architecture.md` §13 — "Whisper sustained 5xx > 10 min"), which is a metric/threshold
  concern, not a per-job side effect. **[CONFIRM]** no per-failure notification (recommended).

### 5.7 Submission transcript rollup (`Submission.transcript`)

After a media transcript lands (or after one is marked failed), recompute
`Submission.transcript` (decision rationale in §6):

- **Recompute-from-DB / from-S3 (recommended, coordinator-free, mirrors Story 9 §5.7).** Read
  the submission's VIDEO/VOICE media items; for each that has a transcript (its
  `…/transcripts/{media_id}.json` exists, or its per-media text is stored — see §6), include its
  **plain text** in deterministic order; concatenate into `Submission.transcript`. Failed /
  not-yet-done items contribute nothing. Whichever job finishes last computes the final value;
  earlier jobs compute partial-but-correct intermediates. No "is this the last one?" race.
- **Ordering** of the concatenation: by `MediaItem.uploadedAt` then `id` (stable, deterministic)
  **[CONFIRM]**. Optionally prefix each segment with a lightweight separator/marker
  (e.g. a blank line) so downstream analysis (Story 11) can tell segments apart
  **[CONFIRM]** — recommend a simple blank-line join, no per-segment labels (keeps the field
  clean for Claude input).

> **Where does the per-media plain text come from for the rollup?** Two options, tied to §6:
> (a) **derive on the fly** from each media's S3 raw JSON (read + extract `text`) when
> recomputing — no extra DB column; or (b) **store per-media text** in a new column/table so the
> rollup is a pure DB read. **Recommendation: (a) for MVP 1** if submissions have few AV items
> (read the just-written JSON + sibling JSONs), **or (b)** if re-reading S3 on every rollup is
> too chatty. See §6 decision. **[CONFIRM]**.

Text-only / photo-only submissions never enqueue transcription, so `Submission.transcript`
stays **null** for them — correct (`requirements.md` §5.3).

### 5.8 Retry / backoff policy

Mirrors `architecture.md` §6.3, §11.1 ("Whisper API timeout → 3 retries with backoff → mark
media `transcription_failed`, proceed without") and Story 9's retry shape — but tuned for a
**rate-limited external API** (longer backoff than Story 9's local FFprobe).

| Setting | Value | Rationale |
|---|---|---|
| `attempts` | **3** | `architecture.md` §6.3, §11.1 explicit "3 retries" |
| `backoff` type | **exponential** | §11.1 |
| `backoff` base delay | **[CONFIRM] ~10s** (10s → 20s → 40s) — longer than Story 9's 5s | Whisper is rate-limited; a transient 429/5xx benefits from a longer breather than a local probe blip |
| **429 (rate limit) handling** | Treat as retryable; respect `Retry-After` if the SDK surfaces it; exponential backoff otherwise. `architecture.md` §11.1's Claude posture ("backoff to 5 min; queue holds") is the spirit — **[CONFIRM]** whether to honor `Retry-After` and/or cap a longer backoff for 429 specifically | Avoid hammering a rate-limited API |
| On exhausting attempts | **Mark the media item `transcription_failed`** (§6), recompute `Submission.transcript` without it, emit a failure metric, **proceed** (do **not** block analysis). | `architecture.md` §6.3, §11.1 — graceful degrade |
| Lock / stalled | Rely on BullMQ lock + stalled-job re-queue; set lock duration **>** the Whisper request timeout so a long-but-live transcription isn't reaped. **[CONFIRM]** lock duration vs `whisperTimeoutMs`. | Worker crash safety; jobs idempotent so re-queue is safe |
| Distinguishing **retryable** vs **terminal** errors | **Retryable** (throw → retry): timeout, 429, 5xx, transient network. **Terminal** (do **not** burn 3 attempts pointlessly): a clearly **unsupported/invalid file** (e.g. Whisper rejects the format/size), or a decode error → go **straight to `transcription_failed`**. The processor classifies the error. **[CONFIRM]** the classification list. | Don't retry a file Whisper will always reject; do retry a transient API hiccup |

> **`transcription_failed` is a soft degrade, not a rejection.** Unlike Story 9's quality
> auto-reject (`Submission.status = REJECTED`), a failed transcription **never** changes
> `Submission.status` and **never** drops the media item — the clip is still usable in the
> video; it just lacks a transcript. The flag is informational for the admin.

> **Re-enqueue / backfill for missing transcripts.** If enqueue failed at submit (Redis down)
> or attempts exhausted, a media item ends up with no transcript and (in the exhausted case) a
> `transcription_failed` flag. A recovery sweep can re-enqueue `transcribe.media` for VIDEO/VOICE
> media with no transcript object (idempotent by key). **[CONFIRM]** ship a minimal sweep in
> Story 10 or defer to Story 18's cron infra (recommend defer — mirrors Story 9 §5.8). (§13.)

### 5.9 Worker process registration

Reuse Story 9's `src/workers` bootstrap. Story 10 adds:

- `src/workers/transcription.worker.ts` (or `src/workers/processors/transcription.ts` — match
  whatever layout Story 9 chose **[CONFIRM]**) — the `transcribe.media` processor. Split a
  **pure** `buildTranscriptText(rawWhisperJson)` / rollup helper from the I/O (storage + Whisper
  + DB) so the text-extraction + concatenation logic is unit-testable without the API or a DB.
- Register the `transcription` Worker in `src/workers/index.ts` next to the `quality` Worker,
  with concurrency from `config.worker.concurrency.transcription` (default 8). The same process
  hosts both Workers (quality + transcription); graceful shutdown (already in Story 9) drains
  both.

No change to the encoder pool split (Story 17). No new worker process — `transcription` rides
the main worker pool (`architecture.md` §4 lists Transcription under the main Worker Service).

---

## 6. Database Design

### 6.1 Transcript storage shape — decision & justification

`architecture.md` §7.1 puts `transcript String? @db.Text` on **`Submission`** and §7.2 puts the
**raw word-timestamp JSON per media** at `…/transcripts/{media_id}.json`. Story 10 honors **both**:

**Decision (the recommended shape):**

| What | Where | Why |
|---|---|---|
| **Raw Whisper JSON, with word timestamps**, **per media item** | **S3**: `events/{eventId}/submissions/{submissionId}/transcripts/{mediaId}.json` | The canonical, per-media artifact (`architecture.md` §7.2). Word timestamps are bulky and only needed by Story 16 (subtitles) — keep them out of the DB. |
| **Plain transcript text**, **per submission** (concatenated across the submission's AV media) | **DB**: `Submission.transcript` (`@db.Text`) | The schema's defined field (`architecture.md` §7.1). It's what Story 11 (Claude analysis) and Story 16 (narration) consume — they want readable text, not timestamps. Postgres FTS over `Submission.transcript` is also called out (`architecture.md` §5 "FTS for transcripts"). |

This satisfies the source-of-truth schema (don't invent a new transcript table when
`Submission.transcript` already exists) **and** the storage layout (per-media raw JSON for Story
16) **without** duplicating bulky timestamp data into Postgres.

**Per-media DB transcript — considered and (default) rejected.** A `MediaItem.transcript` column
(per-media plain text in the DB) would make the §5.7 rollup a pure DB read (no S3 re-reads) and
let the admin show a transcript per file. **Recommendation:** add it **only if** re-reading S3
JSON on every rollup proves too chatty (§5.7 option b). Default for MVP 1: **do not** add a
per-media DB column; derive per-media text from the S3 JSON when recomputing
`Submission.transcript`. **[CONFIRM]** — this is the central open question of this story (§13 #1).
If confirmed to add it, it's an additive nullable `MediaItem.transcript String? @db.Text` (§6.3).

### 6.2 `transcription_failed` marking — flag vs dedicated field

The media item must carry a durable "transcription failed" marker the admin (Story 7) can see.
Two options:

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **(A) Add to `MediaItem.qualityFlags[]`** | append the string `transcription_failed` to the existing `String[]` | No migration; Story 7 already renders `qualityFlags` as chips (Story 9 §4) | **Semantically wrong** — `qualityFlags` is a **quality** vocabulary (Story 9 froze it: `blurry`, `low_audio`, …). Transcription is a different concern; mixing them muddies both the meaning and the Story 12 routing analyzer's "flag rate" math (it counts quality flags) |
| **(B) Dedicated field** `MediaItem.transcriptionStatus` (enum) | `enum TranscriptionStatus { PENDING DONE SKIPPED FAILED }` (or a nullable `transcriptionFailedAt DateTime?`) | Clean separation; explicit lifecycle; doesn't pollute quality-flag rate; easy to query | One additive migration |

> **Recommendation: (B) a dedicated `MediaItem.transcriptionStatus` enum** (additive, nullable
> or defaulted `PENDING`). It cleanly distinguishes transcription state from quality flags, lets
> Story 7 render a precise chip, lets the rollup/sweep query `WHERE transcriptionStatus IN
> (PENDING, FAILED)`, and avoids contaminating Story 12's quality-flag-rate signal. **[CONFIRM]**
> the field name + enum values (or a simpler `transcriptionFailed Boolean @default(false)` + a
> `transcribedAt DateTime?`). §13 #2.

If (B) is chosen, the lifecycle:

| `transcriptionStatus` | Set when |
|---|---|
| `PENDING` (default) | media item created (VIDEO/VOICE) and a job is enqueued; PHOTO/text never get one (stays null or N/A — **[CONFIRM]** whether PHOTO gets `SKIPPED` or stays null) |
| `DONE` | Whisper (or mock) returns and the raw JSON + text persist |
| `SKIPPED` | a VIDEO with `no_audio` short-circuit (§5.5 step 4), if that path is enabled **[CONFIRM]** |
| `FAILED` | retries exhausted (§5.8) — the `transcription_failed` marker the admin sees |

### 6.3 Fields written / migration notes

| Model.field | Type | Written by Story 10 | Value |
|---|---|---|---|
| `Submission.transcript` | `String? @db.Text` (exists from Story 5) | yes | concatenated plain text of the submission's AV transcripts (§5.7); null if no AV transcribed |
| `MediaItem.transcriptionStatus` *(if option B)* | new enum `TranscriptionStatus` | yes | `PENDING`→`DONE`/`FAILED`/`SKIPPED` (§6.2) |
| `MediaItem.transcript` *(only if §6.1 option b confirmed)* | new `String? @db.Text` | conditionally | per-media plain text; default not added |
| S3 object `…/transcripts/{mediaId}.json` | (object storage, not DB) | yes | raw Whisper JSON w/ word timestamps |

**Migration:**
- If **only** writing `Submission.transcript` (column exists from Story 5) → **no DB migration**;
  `prisma generate` only.
- If adding `MediaItem.transcriptionStatus` (recommended option B) → an **additive** migration
  `add_media_transcription_status` adding the new enum + nullable/defaulted column. Additive +
  nullable/defaulted → safe `prisma migrate deploy` against `swara_prd`, no backfill (existing
  media predate transcription).
- If `Submission.transcript` is **missing** (Story 5 divergence) → additive
  `add_submission_transcript` adding `transcript String? @db.Text`.
- Run `prisma generate` after any migrate so types are available to web + workers.
- **No new dedup/`JobRun` table** — Story 9 §6.2's decision holds: BullMQ `jobId` + output-by-key
  overwrite + the naturally-idempotent failure marking are sufficient (the only side effect is
  the idempotent flag write; no audit-guarded notification is emitted per §5.6).

---

## 7. External Services / Integrations / Config

### 7.1 OpenAI Whisper

- **API**: OpenAI audio **transcriptions** endpoint (speech-to-text, source language verbatim).
  **Not** the translations endpoint (§13). Request **word timestamps** (`verbose_json` +
  `timestamp_granularities: ["word"]`, model permitting — §5.5 step 5, §13).
- **Model**: `config.ai.whisperModel`, default `whisper-1` (`architecture.md` §14;
  `.env.example` `WHISPER_MODEL=whisper-1`). Keep it config-driven so a model swap is an env
  change. **[CONFIRM]** the model that reliably returns **word**-level timestamps for MVP 1
  (`whisper-1` does via `verbose_json`; some newer transcription models differ — pin
  accordingly).
- **SDK**: the official `openai` npm package (new dependency — not currently installed;
  `package.json` has `ioredis`, `pino`, `prisma`, `zod`, Next, and — from Story 9 — `bullmq`).
  Add `openai`.
- **Client wrapper**: a single module (proposed `src/lib/ai/openai.ts` or
  `src/services/transcription.ts` **[CONFIRM location]**) is the only place the OpenAI SDK is
  constructed; it reads `config.ai.openaiApiKey` (never `process.env`). It exposes a small
  typed interface, e.g. `transcribeAudio(file, opts) → { text, language, words: [...], raw }`,
  so the processor (and tests) depend on the interface, not the SDK.
- **Cost**: ~$0.006/audio-minute (`development-setup.md` §4); a $20/mo dev cap. Log audio
  duration per call for cost tracking (§11).
- **Rate limits**: the §8.1 concurrency cap of 8 is the primary control; 429s retry with backoff
  (§5.8). `architecture.md` §12 notes per-org pools / self-hosted Whisper as the scale path
  (MVP 2).

### 7.2 Mock mode (`AI_MOCK_MODE`) + `__mocks__/openai`

Two distinct mechanisms, both from `development-setup.md` §4:

| Mechanism | Purpose | Behavior |
|---|---|---|
| **`AI_MOCK_MODE=true` runtime flag** | offline dev + CI; route AI calls to deterministic mocks | The transcription client wrapper checks `config.ai.mockMode`; if true it returns a **deterministic canned transcript** instead of calling OpenAI. Mirrors `development-setup.md` §4's `new MockAiClient()` vs `new AnthropicClient()` switch — Story 10 establishes the same switch for the OpenAI/Whisper client, and Story 11 reuses it for Claude. |
| **`__mocks__/openai` (Vitest module mock)** | unit tests that exercise the real wrapper code path without the network | A `__mocks__/openai.ts` module returns **canned transcripts for known fixture audio** (`development-setup.md` §4). Used via Vitest's module mocking so the wrapper's request-building logic is still covered, but no API call is made. |

**Deterministic mock contract:** for a given fixture media id / filename, the mock returns a
**stable** transcript (same text + the same fake word timestamps every run) so tests can assert
exact persisted values and the S3 JSON shape. The mock's output JSON must match the **real**
Whisper `verbose_json` shape (text + `words[]` with `start`/`end`/`word`, + `language`) so
Story 16's later code can parse mock and real output identically. **[CONFIRM]** the canned-mock
keying (by `mediaItemId`? by `originalName`? a default fallback transcript for unknown inputs?).

`.env.test` already sets `AI_MOCK_MODE=true` (`development-setup.md` §7) — CI pre-merge runs
unit + integration with mocks (`development-setup.md` §11). Real-API integration is opt-in and
gated (§9).

### 7.3 S3 / storage access

- **Read** the media bytes from `MediaItem.storagePath` via the **same storage service** Story 9
  uses (`getObjectStream`/`downloadToFile` added in Story 9 §7.3). No new read capability needed.
- **Write** the raw transcript JSON to `…/transcripts/{mediaId}.json`. Story 9's worker was
  **read-scoped** for media; Story 10's worker additionally needs **write** to the
  `events/.../transcripts/` prefix. Add a `putObject(key, body, contentType)` capability to the
  storage service if not already present (Story 6 exposed presign + head; Story 9 added
  download — Story 10 adds upload-from-worker). **[CONFIRM]** add `putObject` to the storage
  interface in this story.
- Worker S3 credentials (`S3_*`) live in the **worker** host env (Railway/Fly, §16 secrets);
  the worker reads `config.storage`, never `process.env`. Objects are **private ACL**
  (`architecture.md` §7.2). Transcripts contain submission speech (PII) — private ACL is
  mandatory (§10).
- Local dev: MinIO (`swara-minio`, already in compose). The transcript JSON lands in the same
  bucket under the `transcripts/` prefix.

### 7.4 Config — wire through BOTH config files

Per the load-bearing convention (Story 1, `development-setup.md` §7; no `process.env` outside
`src/config/`). Add an **`ai`** block (Story 11 will extend the same block with Anthropic keys).

**Add to `src/config/env.ts`** (raw reads only — the only file allowed to touch `process.env`):

| Raw key | Source env var | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | `process.env.OPENAI_API_KEY` | Whisper auth |
| `WHISPER_MODEL` | `process.env.WHISPER_MODEL` | Model id (default `whisper-1`) |
| `AI_MOCK_MODE` | `process.env.AI_MOCK_MODE` | `'true'` routes all AI calls to deterministic mocks |
| `WORKER_CONCURRENCY_TRANSCRIPTION` | `process.env.WORKER_CONCURRENCY_TRANSCRIPTION` | Override `transcription` Worker concurrency (default 8) |
| `WHISPER_TIMEOUT_MS` | `process.env.WHISPER_TIMEOUT_MS` | Per-request hard timeout (default e.g. 120000) **[CONFIRM]** |
| `WHISPER_MAX_DURATION_SEC` *(optional)* | `process.env.WHISPER_MAX_DURATION_SEC` | Max audio duration to attempt before marking failed (guards Whisper's request-size limit) **[CONFIRM include + default]** |

**Add to `src/config/index.ts`** — extend the Zod schema with an `ai` object (+ a `transcription`
concurrency knob under the existing `worker` block from Story 9):

| Config field | Type | Mapping / default |
|---|---|---|
| `ai.openaiApiKey` | `z.string()` (optional/relaxed in mock mode — see note) | `OPENAI_API_KEY` |
| `ai.whisperModel` | `z.string()` | `WHISPER_MODEL` ?? `'whisper-1'` |
| `ai.mockMode` | `z.boolean()` | `AI_MOCK_MODE === 'true'` |
| `ai.whisperTimeoutMs` | `z.coerce.number().int().positive()` | `WHISPER_TIMEOUT_MS` ?? 120000 |
| `ai.whisperMaxDurationSec` *(optional)* | `z.coerce.number().int().positive().optional()` | `WHISPER_MAX_DURATION_SEC` |
| `worker.concurrency.transcription` | `z.coerce.number().int().positive()` | `WORKER_CONCURRENCY_TRANSCRIPTION` ?? 8 |

> **Mock-mode and the API-key requirement.** In CI/test (`AI_MOCK_MODE=true`) there is no real
> `OPENAI_API_KEY`. Make `ai.openaiApiKey` **required only when `ai.mockMode` is false** (a Zod
> `superRefine`/conditional, or accept empty and fail loudly at first real call). **Recommend**
> the conditional so a missing key in prod fails fast at boot (matching Story 1's "fail at boot
> with a clear Zod error" posture) but tests/CI don't need a key. **[CONFIRM]**.

Add the new keys to `.env.example` (the file already lists `OPENAI_API_KEY`, `WHISPER_MODEL`,
`AI_MOCK_MODE` per `development-setup.md` §7 — confirm they're present; add the new
`WORKER_CONCURRENCY_TRANSCRIPTION` / `WHISPER_TIMEOUT_MS` / optional `WHISPER_MAX_DURATION_SEC`
under the AI block). **[CONFIRM]** exact defaults.

### 7.5 New npm dependency

- `openai` (runtime) — the OpenAI SDK (Whisper). Not yet installed.

---

## 8. Seed Data

Build on Story 6's seed (3 sample `MediaItem` rows: one VIDEO, VOICE, PHOTO, each with a tiny
valid object in MinIO) and Story 9's "FFprobe-parseable" requirement.

For Story 10 specifically:

- **Canned mock transcripts for known fixture audio/video.** Because dev/CI default to mock mode
  (and the dev seed shouldn't burn real Whisper minutes), the **mock keys off the seeded VIDEO
  and VOICE media** and returns a stable canned transcript. Provide a small fixture map (e.g.
  `tests/fixtures/transcripts/{seedMediaId}.json` and/or keyed by `originalName`) so:
  - running the worker in mock mode against the seeded VIDEO/VOICE produces a deterministic
    `…/transcripts/{mediaId}.json` in MinIO and a deterministic `Submission.transcript`.
  - the seeded PHOTO is **never** transcribed (proves skip-when-no-AV locally).
- **Optionally seed a `transcription_failed` example** — a media item whose mock is configured to
  throw (or a fixture flagged "force-fail") so the failure-marking + admin flag path is
  exercisable locally without a real API error. **[CONFIRM]** include a force-fail fixture.
- **Run-the-worker-locally recipe** (document here / dev-setup): `docker compose up -d` (Redis +
  MinIO) → `npm run seed` → `AI_MOCK_MODE=true npm run workers` → the transcription processor
  picks up jobs for the seeded VIDEO/VOICE. Reuse Story 9's dev enqueue helper/script (e.g.
  `npm run enqueue:transcription -- <mediaItemId>` or a seed step that enqueues for all AV media
  with no transcript) so a dev can trigger transcription without the contributor form.
  **[CONFIRM]** add/extend the dev enqueue script.
- For a **real-API smoke** locally, a developer sets `AI_MOCK_MODE=false` + a real
  `OPENAI_API_KEY` and runs against a genuinely audible tiny clip (the seed's tiny MP3/MP4 may be
  silent — provide one short **audible** fixture for the real path). **[CONFIRM]** ship a short
  audible fixture for real-API integration (§9.2).

---

## 9. Testing

Follows the Story 1 / 6 / 9 pattern (Vitest, `tests/unit` + `tests/integration`). Integration
tests needing real Redis/MinIO are guarded by **`SKIP_INTEGRATION`**; real-API tests are
additionally gated (mock by default).

### 9.1 Unit (no infra; pure logic; mock the OpenAI client + storage)

| Test | Asserts |
|---|---|
| Skip-when-no-AV (enqueue gate) | Given a submission's media set, only VIDEO/VOICE items produce a `transcribe.media` enqueue; PHOTO and text-only produce none |
| Processor type guard | Handed a PHOTO `mediaItemId`, the processor no-ops success (defensive guard) |
| Idempotency key | `buildJobKey` yields `{eventId}:{submissionId}:transcribe.media:{mediaItemId}` (confirmed shape); stable; distinct per media item |
| Transcript text extraction | `buildTranscriptText(rawWhisperJson)` extracts the plain `text` correctly from `verbose_json` (and tolerates the mock's shape) |
| Submission rollup | `Submission.transcript` = deterministic concatenation (confirmed order/join) of the submission's AV transcripts; null when no AV; a `FAILED`/missing item contributes nothing; recompute is order-independent |
| Mock-mode determinism | With `AI_MOCK_MODE=true`, the same fixture media yields the **same** transcript text + word-timestamp JSON across runs |
| Retry vs terminal classification | A timeout/429/5xx classifies **retryable** (throws → retry); an unsupported-file/decode error classifies **terminal** (→ mark `transcription_failed`, no pointless retries) |
| Retry → fail → mark | After `attempts` exhaust on a retryable error, the media item is marked `transcription_failed` (per §6 mechanism), `Submission.transcript` recomputed without it, **no** status change, no exception escapes to crash the pool |
| Output-by-key / re-run safety | Running the processor twice on the same fixture writes the same S3 key (overwrite) and the same `Submission.transcript` (idempotent) |
| Config conditional | `ai.openaiApiKey` required only when `ai.mockMode=false`; mock mode boots without a key |

> Keep extraction + rollup as **pure functions** fed fixtures (captured/synthetic Whisper
> `verbose_json`), separate from storage/Whisper/DB I/O, so the logic is unit-tested without the
> API or a DB.

### 9.2 Integration (`SKIP_INTEGRATION` guards real Redis + MinIO; AI mocked by default)

| Test | Flow |
|---|---|
| Enqueue → transcribe[mock] → DB + S3 (happy path) | Seed a VOICE/VIDEO `MediaItem` + object in MinIO → `enqueue(transcription, 'transcribe.media', …)` → run the Worker (mock mode) → assert `…/transcripts/{mediaId}.json` exists in MinIO with the expected shape AND `Submission.transcript` populated |
| Skip-when-no-AV end-to-end | Submit (or seed) a photo-only + a text-only submission → assert **no** transcription job ran and `Submission.transcript` stays null |
| Idempotent re-enqueue | Enqueue the same `transcribe.media` twice → assert one job processed / final S3 object + DB text identical; no duplicate object |
| Retry → fail → mark | Configure the mock to throw a retryable error every time → assert the job retries to `attempts`, lands in `failed`, the media item is marked `transcription_failed`, `Submission.transcript` excludes it, and the pipeline is not blocked |
| Deleted-media no-op | Enqueue, delete the `MediaItem` (cascade) before processing → assert job no-ops success |
| Graceful shutdown | Start the Worker, enqueue, SIGTERM mid-drain → in-flight job completes or re-queues (not lost) |
| **Real-API (gated)** | With `AI_MOCK_MODE=false` + real `OPENAI_API_KEY` + an **audible** fixture clip → assert a real transcript is produced and persisted. **Off by default**; runs only when the key + a `RUN_REAL_AI`/equivalent flag are set (`development-setup.md` §11 — E2E nightly with real capped AI). **[CONFIRM]** the gating flag name (reuse `SKIP_INTEGRATION` + an explicit real-AI opt-in). |

### 9.3 Mocking strategy

- **Unit**: mock the OpenAI client wrapper interface (and storage `getObjectStream`/`putObject`)
  — no SDK, no network. The `__mocks__/openai` module (`development-setup.md` §4) provides canned
  transcripts when the wrapper itself is under test.
- **Integration**: default `AI_MOCK_MODE=true` (canned transcripts) against real Redis + MinIO,
  proving the enqueue→process→S3+DB plumbing. Real Whisper runs only behind the explicit
  real-AI gate.
- **CI**: unit always; integration via a Redis service (+ MinIO, mirroring Story 6/9), with
  `AI_MOCK_MODE=true`; never calls the real API (cost + flake). `SKIP_INTEGRATION=true` where
  infra is unavailable.

---

## 10. Security

- **No honoree exposure.** Transcription touches media + submission/event metadata only; it
  sends **no** contributor/honoree communication. Story 10 raises no per-failure notification
  (§5.6); the only alert is the internal sustained-failure metric alert (admin-facing, §11).
  Nothing in this story can email the honoree (`architecture.md` §10.1).
- **Transcript PII handling.** Transcripts are **speech content from contributors** — they
  contain names, personal messages, and potentially sensitive remarks. Treat them as PII:
  - The raw JSON in S3 is **private ACL** (`architecture.md` §7.2); access only via presigned
    GET from the admin path (Story 7). No public read; no CDN exposure.
  - **Do not log transcript text** (or the raw JSON body) in worker logs. Log ids + duration +
    outcome only (§11) — mirror Story 6/9 redaction.
  - On right-to-delete / retention (Story 19/20), the `…/transcripts/` objects are removed with
    the rest of the submission's S3 prefix (the deletion sweeps the `events/{event_id}/…`
    tree). `Submission.transcript` is dropped with the row. **[CONFIRM]** the deletion sweep
    includes the `transcripts/` prefix (it should, as it's under the event prefix).
- **Untrusted input.** Media bytes come from anonymous contributors. Reuse Story 9's defensive
  posture: hard request/processing **timeout** (`config.ai.whisperTimeoutMs`), bounded temp-file
  size (to the known `sizeBytes`), **always** clean up temp files in `finally`, and never let a
  bad file crash the Worker process (the processor catches, classifies, and fails the job —
  §5.8). A crafted file that Whisper rejects is a terminal verdict, not an infinite retry.
- **Secrets.** `OPENAI_API_KEY` lives only in the host env (worker + CI secret); read via
  `config.ai`, never `process.env` (lint-enforced). Payloads carry ids only — no key, no bytes,
  no URLs in queue data (Redis contents are visible to anyone with Redis access).
- **No new public surface.** Story 10 adds no HTTP route; it's worker-only. (Admin viewing of
  transcripts is Story 7's presigned-GET surface.)

---

## 11. Observability / Audit

**Metrics** (per `architecture.md` §13 — workers: durations, retries, success/failure; AI calls:
model, latency, validation pass/fail, **token/cost**). Emit metric-shaped structured logs now;
wire to OpenTelemetry when the observability story lands.

| Metric | Dimension | Why |
|---|---|---|
| Job duration | queue=`transcription`, job_type, outcome | spot slow transcriptions; queue-depth alert context |
| Retry count / attempts used | job_type, error_class | detect flaky API / 429 spikes |
| Success / failed / skipped counts | outcome (`done`/`failed`/`skipped_no_av`/`skipped_no_audio`) | a `failed` spike = Whisper outage; feeds the §13 sustained-failure alert |
| Queue depth (waiting/active/failed) | queue=`transcription` | autoscaling (`architecture.md` §12) + the §13 alert "queue depth > 100 for any high-priority queue" (`transcription` is High) |
| **Whisper cost** | model, audio-minutes | `architecture.md` §13 "AI calls: token counts" — Whisper bills per minute; log `duration` per call to track spend against the dev/prod caps |
| Whisper API latency / error rate | model, status | drives the **critical alert** "Whisper sustained 5xx > 10 min" (`architecture.md` §13) |

**Structured logs** (Story 1 `logger`): job start (`eventId`, `submissionId`, `mediaItemId`,
`queue`, `jobId`), Whisper call (model, duration, latency, mock-vs-real), result
(outcome, transcript **length** — never the text), retries, failures (error class, attempt n,
classification retryable/terminal). **Never** log transcript text, raw JSON, bytes, or presigned
URLs.

**Trace correlation** (`architecture.md` §13): include `event_id` + `submission_id` (+
`media_item_id`) as span/log attributes so a submission traces form-submit → quality +
transcription (parallel) → (Story 11) analysis → admin-notification.

**Admin-visible flag (not an alert).** `transcription_failed` (§6) is surfaced read-only in the
admin dashboard (Story 7, §4). It is **not** an alert and **not** an `AuditLog`/`NotificationLog`
write per-occurrence (a soft degrade — §5.6). The **sustained-failure** alert is the
metric-threshold concern above. **[CONFIRM]** whether a single transcription failure warrants
**any** audit row (recommend: no — the `transcriptionStatus = FAILED` field is the record; an
audit row only on the sustained-alert level or on a future manual-transcript admin action).

---

## 12. Definition of Done

- [ ] `openai` added to `package.json`; a single OpenAI/Whisper client wrapper module reads
      `config.ai.openaiApiKey` (never `process.env`) and exposes a typed `transcribeAudio`
      interface; mock-mode (`AI_MOCK_MODE`) routes to deterministic canned transcripts.
- [ ] `transcribe.media` job name added to Story 9's registry; `enqueue` + `buildJobKey` reused
      unchanged; idempotency key is `{eventId}:{submissionId}:transcribe.media:{mediaItemId}`
      (confirmed shape), unit-tested.
- [ ] `transcription` Worker registered in `src/workers` (concurrency from
      `config.worker.concurrency.transcription`, default 8); shares the existing graceful-shutdown
      drain with the `quality` Worker.
- [ ] `transcribe.media` processor: re-fetches the `MediaItem`, **runs only for VIDEO/VOICE**
      (PHOTO/text-only never enqueue; processor no-ops on PHOTO), streams bytes from storage,
      calls Whisper (model from config) or the mock requesting word timestamps, writes raw JSON
      to `…/transcripts/{mediaId}.json`, and recomputes `Submission.transcript`.
- [ ] **Skip-when-no-AV** enforced at the enqueue point (Story 6 submit action adds the
      conditional `transcribe.media` enqueue for VIDEO/VOICE only, **after** commit, in parallel
      with `quality`); enqueue failure does not roll back the submission.
- [ ] Retry policy: `attempts = 3`, exponential backoff (~10s base, longer than Story 9);
      retryable errors (timeout/429/5xx) retry, terminal errors don't; on exhaustion the media
      item is marked `transcription_failed` (per the confirmed §6 mechanism), the pipeline
      proceeds, **no** `Submission.status` change.
- [ ] Transcript persistence: raw word-timestamp JSON in S3 (private ACL) **and**
      `Submission.transcript` (concatenated plain text) populated; transcripts never logged.
- [ ] Config: `ai` block (`openaiApiKey`, `whisperModel`, `mockMode`, `whisperTimeoutMs`,
      optional `whisperMaxDurationSec`) + `worker.concurrency.transcription` added in **both**
      `src/config/env.ts` and `src/config/index.ts`; `.env.example` updated; `openaiApiKey`
      required only when not in mock mode; no `process.env` reads outside `src/config/`.
- [ ] Storage service gains a worker `putObject` capability (if not present) for the transcript
      JSON; worker reads/writes via `config.storage`.
- [ ] Schema: `Submission.transcript` written (no migration if it exists); if option B,
      `MediaItem.transcriptionStatus` enum added via additive migration; `prisma generate` run.
- [ ] Mock-mode determinism + skip-when-no-AV + retry→fail→mark + transcript persistence are
      unit-tested with fixtures (no network/DB for the pure logic); integration tests
      (enqueue→transcribe[mock]→DB+S3, skip, idempotent re-enqueue, fail-mark, deleted-media
      no-op, graceful shutdown) pass against Redis + MinIO and skip cleanly under
      `SKIP_INTEGRATION`; real-API integration is gated off by default.
- [ ] Seed produces canned mock transcripts for the seeded VIDEO/VOICE (and never transcribes
      the seeded PHOTO); a documented local recipe runs the worker end-to-end in mock mode (incl.
      a dev enqueue path); a force-fail fixture exercises the failure path.
- [ ] Metrics-shaped logs (durations, retries, outcomes, Whisper cost/latency) emitted; no
      transcript text / bytes / URLs in logs; `transcription_failed` surfaced read-only to admin
      (coordinated with Story 7).
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green.
- [ ] No TODO comments left in committed code.

---

## 13. Open Questions / Assumptions

| # | Item | Recommendation / default | Needs |
|---|---|---|---|
| 1 | **Transcript storage shape: per-media DB column vs derive-from-S3 for the rollup** | Raw word-timestamp JSON per media in S3 (canonical) + concatenated plain text on `Submission.transcript`; **do not** add a per-media DB transcript column in MVP 1 — derive per-media text from the S3 JSON when recomputing. Add `MediaItem.transcript` only if S3 re-reads on rollup prove too chatty. | **[CONFIRM]** |
| 2 | **`transcription_failed` marker mechanism** | A dedicated `MediaItem.transcriptionStatus` enum (`PENDING/DONE/FAILED/SKIPPED`), **not** a string in `qualityFlags[]` (keeps quality vocabulary clean and Story 12's flag-rate signal accurate). | **[CONFIRM] field name + values** |
| 3 | **Whisper model returning WORD timestamps** | `whisper-1` with `verbose_json` + `timestamp_granularities:["word"]`. Pin to a model that returns word timestamps; if a newer default only gives segment timestamps, fall back to segments + flag the limitation for Story 16. | **[CONFIRM] model + params** |
| 4 | **Language: auto-detect vs forced default** | Auto-detect (capture detected language in the raw JSON); contributor audio may be any language even though the product UI is English-only. | **[CONFIRM]** |
| 5 | **Max audio duration / size guard + chunking** | Add `WHISPER_MAX_DURATION_SEC` guard; if a file exceeds Whisper's per-request size (~25 MB) or the duration cap, mark `transcription_failed` rather than infinite-retry. Full chunking/segmentation deferred unless real submissions hit the limit. | **[CONFIRM] cap + behavior** |
| 6 | **Per-media job granularity** | One job per AV media item (`transcribe.media`); submission text via recompute-from-DB/S3 — mirrors Story 9. | **[CONFIRM]** |
| 7 | **Idempotency key per-media segment** | `…:transcribe.media:{mediaItemId}` via shared `buildJobKey()` — must match Story 9's finalized shape. | **[CONFIRM] consistency with Story 9** |
| 8 | **Rollup order + join** | Order by `uploadedAt` then `id`; blank-line join, no per-segment labels. | **[CONFIRM]** |
| 9 | **`no_audio` short-circuit** | If Story 9 has set `no_audio` (may race since quality + transcription are parallel), optionally skip the API call and mark `SKIPPED`; if the flag isn't set yet, just attempt and let Whisper return empty. | **[CONFIRM]** |
| 10 | **Retry vs terminal error classification** | Retryable: timeout/429/5xx/network. Terminal: unsupported/invalid file, decode error → straight to `transcription_failed`. Honor `Retry-After` on 429 if surfaced. | **[CONFIRM] classification list** |
| 11 | **Backoff base delay** | ~10s exponential (10→20→40), longer than Story 9's 5s because Whisper is rate-limited. | **[CONFIRM]** |
| 12 | **Per-failure notification/audit** | None per occurrence (soft degrade); only the sustained-failure metric alert (`architecture.md` §13). `transcriptionStatus=FAILED` is the record. | **[CONFIRM]** |
| 13 | **Translation endpoint** | Not used in MVP 1 — `transcribe` (verbatim) only. | confirm out-of-scope |
| 14 | **Mock keying** | Canned mock keyed by `mediaItemId`/`originalName` with a default fallback transcript; mock JSON matches real `verbose_json` shape so Story 16 parses both identically. | **[CONFIRM]** |
| 15 | **`config.ai.openaiApiKey` required only when not mock** | Conditional Zod refine — fail fast at boot in prod, no key needed in CI/test mock mode. | **[CONFIRM]** |
| 16 | **Storage `putObject` from worker** | Add an upload capability to the storage service (Story 6 had presign+head, Story 9 added download). | **[CONFIRM]** |
| 17 | **Re-enqueue/backfill sweep for missing transcripts** | Minimal cron/admin re-enqueue of VIDEO/VOICE media lacking a transcript object (idempotent); recommend defer to Story 18 cron infra. | **[CONFIRM ship vs defer]** |
| 18 | **Audible real-API fixture + real-AI gate flag** | Ship one short audible clip for the gated real-API integration test; reuse `SKIP_INTEGRATION` + an explicit real-AI opt-in flag. | **[CONFIRM]** |
| 19 | **Worker file layout** | Match Story 9's chosen layout (`*.worker.ts` vs `processors/*`); split a pure `buildTranscriptText`/rollup helper from I/O. | **[CONFIRM] match Story 9** |
| 20 | **Story 12 routing uses transcription-failed as a signal?** | Out of scope for Story 10; Story 10 only writes the flag. Flag for Story 12 to decide. | defer to Story 12 |
