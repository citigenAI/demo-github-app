# Sequence 11 / Story 17 — AI Video Assembly + Encoding Variants

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (the dedicated encoder worker pool, the `encoding` queue, the storyboard-driven
assembly steps, every output variant's target spec, idempotency keys, storage paths,
`FinalVideo` rows, retry/backoff, partial-failure handling, error cases) so a later
code-generation step implements exactly this and nothing more. **No code, no FFmpeg command
strings, appear in this document** — encode operations are described in prose/tables. Where a
value is a proposal awaiting confirmation it is flagged **[CONFIRM]**; genuine ambiguities are
listed in §13, not silently chosen.

| Field | Value |
|---|---|
| Story number / title | Story 17 — AI video assembly + encoding variants |
| Epic | I — AI Path |
| Sequence number | 11 (this is the 11th design in build order) |
| Depends on | Story 16 (AI storyboard + narration — produces `AiArtifact.storyboardJson`, `introText`, `outroText`, `narrationScript`, subtitles; the `storyboard`/`script` queues + the AI-service wrapper) |
| Parallel with | Story 14 (Editor upload back) — both write `FinalVideo` rows; they **share** the `VideoSource`/`VideoVariant` enums and the `final/` storage layout (§6) |
| Also assumes on `main` | Story 1 (config `env.ts`+`index.ts`, `db`, `redis` singleton, `logger`, worker scaffold, CI, docker-compose), Story 3 (`Event` + `EventStatus`/`OccasionType`), Story 6 (`MediaItem` + storage service: object read/download, key helpers, `S3_*` config), Story 9 (BullMQ queue registry + `enqueue` helper + idempotency `jobId` convention + worker bootstrap + graceful shutdown + FFmpeg/FFprobe-in-worker pattern), Story 11 (AI-service wrapper; `AiArtifact` model introduced), Story 12 (the `AI_ROUTED` status that gates this pipeline) |
| Unlocks | Story 15 (Delivery — share page + download link + delivery email reads the `FinalVideo` rows this story writes) |
| Complexity | **XL (5–8 days)** |

> **Sources of truth honored:** `docs/requirements.md` §5.8 (the four output specs: Full HD
> master 1920×1080 MP4, Instagram Reel 1080×1920 MP4 ≤90s vertical, YouTube 1920×1080 MP4,
> thumbnail JPG 1280×720; download link + share page), §5.3 (storyboard drives sequence;
> subtitles), §9 (out of scope: in-browser editing, music licensing). `docs/architecture.md`
> §4 (the Encoder Service split from main workers — FFmpeg CPU-heavy, dedicated pool on
> Railway/Fly, scales on queue depth; final videos served via CDN), §6.3 (the AI pipeline path
> after `AI_ROUTED`), §7.1 (`FinalVideo` model — `source AI_GENERATED`, `variant
> MASTER/REEL/YOUTUBE/THUMBNAIL`, `storagePath`, `durationSec`, `sizeBytes`, `eventId`,
> `createdAt`; `AiArtifact.storyboardJson`/`introText`/`outroText`; `VideoSource`/`VideoVariant`
> enums), §7.2 (storage layout: `final/master.mp4`, `reel.mp4`, `youtube.mp4`, `thumbnail.jpg`;
> CDN-served paths use signed URLs), §8.1 (`encoding` queue: concurrency 2, dedicated encoder
> workers), §8.2 (idempotency contract), §9.2 (the canonical `StoryboardSchema` shape this story
> consumes), §11.1 (failure handling), §12 (encoder scaling on queue depth), §13 (observability),
> §14 (env vars incl. `CDN_DOMAIN`, `CDN_SIGNING_KEY`), §15 (no automatic music selection — mood
> is a brief only). `docs/branding.md` §6 (wordmark), §4 (palette/gradient for title cards), §9
> (the one "magical" moment — gentle reveal), §10 (honoree name is sacred — exact spelling). Also:
> `docs/stories.md` (Story 17 is XL; the **manual path ships MVP1**, AI auto-render is a scaling
> improvement, not a launch blocker — §13 Q14), `prisma/schema.prisma` (current: `User`+`Role`),
> and the sibling designs `seq06-story09-workers-quality-scoring.md` (queue/idempotency/FFmpeg
> patterns reused verbatim), `seq09-story12-routing-analyzer-approval.md` (the `AI_ROUTED`
> trigger seam), `seq08-story11-claude-analysis.md` (`AiArtifact` shape, config style).

> **Note on the Story 16 source.** `docs/design/seq10-story16-ai-storyboard-narration.md` is
> **not present** in the repo at the time of writing. The storyboard contract this story consumes
> is therefore taken from **`architecture.md` §9.2 `StoryboardSchema`** (the canonical shape) and
> `AiArtifact.storyboardJson` / `introText` / `outroText` / `narrationScript` (architecture §7.1).
> If Story 16's design lands first and stores `storyboardJson` at a richer or differently-named
> shape, **reconcile §5.3 (the assembly mapping) against it before generating code.** Flagged §13
> Q1. Likewise, Story 16 owns **subtitle generation** (`requirements.md` §5.3 "Generate subtitle
> files (.srt)"); this story consumes those `.srt` artifacts and burns them in — it does **not**
> generate them (§5.7, §13 Q2).

---

## 1. Story Summary

By Story 16 an `AI_ROUTED` event (Story 12 gate) has a complete, admin-approved AI plan on its
single `AiArtifact` row: a **storyboard** (`storyboardJson` — the ordered sequence of media clips
with per-clip durations, transitions, and captions), **intro/outro title-card text**, a
**narration script**, and **subtitle files**. Until now nothing turns that plan into a watchable
video.

Story 17 builds the **rendering** half of the AI path:

1. **A dedicated FFmpeg encoder worker pool** — a worker process **separate** from the main AI/
   quality worker pool (`architecture.md` §4), running the **`encoding` queue at concurrency 2**
   (§8.1). It is split out because FFmpeg is CPU-bound, runs for minutes per job, and would cause
   head-of-line blocking if it shared a pool with the cheap, bursty AI jobs. It scales
   horizontally on queue depth, independently of the AI pool (§5.1, §12).

2. **The assembly job** — driven by `AiArtifact.storyboardJson`: it fetches each approved media
   item from S3 in storyboard order, applies per-clip durations / transitions / captions,
   generates **intro and outro title cards** from `introText` / `outroText` + the event theme,
   **burns in subtitles**, and produces the **MASTER** (1920×1080).

3. **The variant derivation** — from the master it derives the **Instagram Reel** (1080×1920,
   ≤90s, vertical crop), the **YouTube** version (1920×1080), and extracts the **thumbnail**
   (JPG, 1280×720).

4. **Persistence** — each output is uploaded to its `final/` path and recorded as a `FinalVideo`
   row (`source = AI_GENERATED`, the right `variant`, `storagePath`, `durationSec`, `sizeBytes`).
   These four rows are the **handoff seam to Story 15** (delivery): Story 15 reads them to build
   the share page + download links and never re-encodes.

**This story is the AI assembly path only.** Storyboard/subtitle **generation** (Story 16),
delivery/share (Story 15), and the editor-uploaded path (Story 14) are out of scope. **No
licensed music is added** — music licensing is the editor's job and explicitly out of scope
(`architecture.md` §15, `requirements.md` §9); the AI path uses only the contributors' own clip
audio + (if Story 16 produced one) a TTS narration track, never a licensed music bed (§5.6, §13
Q5).

### Success criteria

- [ ] A dedicated **encoder worker process** (distinct entry + start command) registers the
      `encoding` Worker at concurrency 2, reads config, and shuts down gracefully (drains in-flight).
- [ ] An `encoding.assemble_ai_video` job, keyed idempotently per event, assembles the master from
      `storyboardJson` (ordered clips + durations + transitions + captions + intro/outro cards +
      burned subtitles) at exactly 1920×1080.
- [ ] The job derives REEL (1080×1920, **≤90s**), YOUTUBE (1920×1080), and THUMBNAIL (1280×720 JPG)
      from the master, uploads each to its `final/` path, and writes one `FinalVideo` row per variant
      (`source = AI_GENERATED`).
- [ ] Re-render is idempotent by `{eventId}:{variant}` — re-running overwrites the same `final/`
      object and upserts (not duplicates) the `FinalVideo` row.
- [ ] Partial failure is handled: a per-variant failure does not lose completed variants; the master
      is the gate for the derived variants.
- [ ] Schema gains the `FinalVideo` model (if not already on `main`) + `VideoSource`/`VideoVariant`
      enums, shared with Story 14; migration is additive.
- [ ] Config: encoder concurrency, FFmpeg path, render timeouts, `CDN_DOMAIN`/`CDN_SIGNING_KEY`,
      encoder host knobs added in **both** `src/config/env.ts` and `src/config/index.ts`; no
      `process.env` outside `src/config/`.
- [ ] Unit + integration tests (§9) pass; integration skips cleanly under `SKIP_INTEGRATION`; the
      heavy real-encode path is behind a separate `ENCODE_INTEGRATION` gate.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green.

---

## 2. Scope

### In scope (this story)

- **The dedicated FFmpeg encoder worker pool** — a process **separate** from the Story 9 main
  worker pool (deployment target, start command, scaling rationale; §5.1, §7.4).
- **The `encoding` queue** (concurrency **2**, Normal priority — `architecture.md` §8.1), already
  *declared* in the Story 9 registry; this story adds the **processor** in the encoder process.
- **The assembly job** (`encoding.assemble_ai_video`): driven by `storyboardJson` — fetch approved
  media from S3 per sequence entry, apply per-clip durations / transitions / captions, generate
  **intro/outro title cards** from `AiArtifact.introText`/`outroText` + theme/music-mood brief,
  **burn in subtitles**, produce **MASTER 1920×1080** (§5.3–§5.7).
- **Variant derivation** from the master: **REEL** 1080×1920 ≤90s (vertical crop strategy, §5.8),
  **YOUTUBE** 1920×1080, **THUMBNAIL** 1280×720 JPG (§5.8, §5.9).
- **Upload + persistence**: write each output to its `final/` path; create/upsert one `FinalVideo`
  row per variant (`source = AI_GENERATED`) with `storagePath`/`durationSec`/`sizeBytes` (§5.10, §6).
- **Idempotency** per `{eventId}:{variant}` (output-by-key overwrite of both the S3 object and the
  `FinalVideo` row) + the event-level job key (§5.11).
- **Retry/backoff + partial-failure handling** (§5.12), **resource/timeout bounds** (§5.13).
- **The trigger seam** — fired when an event becomes `AI_ROUTED` *and* its `AiArtifact` is
  admin-approved/storyboard-ready (§3, §5.2).
- **The handoff seam to Story 15** — the `FinalVideo` rows + the CDN-signing contract for delivery
  (§5.14, §7.3).
- **Schema growth** — `FinalVideo` model + `VideoSource`/`VideoVariant` enums (shared with Story 14;
  added by whichever of 14/17 lands first — §6.4); additive migration.
- **Config** — encoder concurrency, FFmpeg path, render timeouts/resource caps, `CDN_DOMAIN`/
  `CDN_SIGNING_KEY`, encoder host vars in **both** config files (§7.5).
- **Seed** — an `AI_ROUTED` event with an approved storyboard/artifacts + mock/sample `FinalVideo`
  rows (real encoding needs sample media; §8).
- **Tests** — variant spec correctness, storyboard→assembly-plan mapping, idempotency, thumbnail
  params (unit); small storyboard→encode→`FinalVideo`+S3 (integration, gated) (§9).

### Out of scope (deferred — with owners)

| Deferred item | Owner / where | Note |
|---|---|---|
| **Storyboard / narration / intro-outro text generation** | Story 16 | This story **consumes** `storyboardJson`/`introText`/`outroText`/`narrationScript`; it does not produce them |
| **Subtitle (.srt) generation / alignment** | Story 16 (Whisper alignment) | This story **burns in** the subtitle artifact; it does not generate it (§5.7, §13 Q2) |
| **Delivery: share page, download link, delivery email** | Story 15 | Reads the `FinalVideo` rows + uses the CDN-signing contract (§5.14) |
| **Editor-uploaded final-video path** | Story 14 | Writes `FinalVideo` with `source = EDITOR_UPLOADED`; shares the enums + `final/` layout (§6) |
| **Licensed music / audio bed selection** | Out of scope entirely | `architecture.md` §15, `requirements.md` §9 — editor's job; AI path adds **no** licensed music (§5.6, §13 Q5) |
| **TTS / voiceover synthesis of `narrationScript`** | **[CONFIRM]** Story 16 vs out of scope | Whether the narration script becomes an **audio** track is ambiguous; if no narration audio exists, the master uses clip audio only (§5.6, §13 Q4) |
| **Admin "re-render" UI button** | Story 7 / Story 15 area | This story makes re-render **idempotent + safe**; the admin button that enqueues it is **[CONFIRM]** (§4, §13 Q9) |
| **Custom thumbnail upload by admin** | MVP 2 | MVP 1 auto-extracts only (`architecture.md` §18) |
| **Full OpenTelemetry export** | Observability story | This story emits metric-shaped structured logs now (§11) |
| **ClamAV / content moderation of the output** | n/a | Inputs were scanned upstream (Story 6/9 area); the rendered output is derived from already-vetted media |

---

## 3. Dependencies & Sequence

### Must already be on `main`

- **Story 1 (Foundation):** typed `config` (`src/config/env.ts` + `src/config/index.ts`), Prisma
  singleton `src/lib/db.ts`, Redis singleton `src/lib/redis.ts` (`maxRetriesPerRequest: null`,
  `lazyConnect`), `logger`, the worker entry `src/workers/index.ts`, CI, `SKIP_INTEGRATION`
  convention, docker-compose (Redis + MinIO).
- **Story 3 (Event):** `Event` model (`id`, `slug`, `status: EventStatus`, `theme`, `musicMood`,
  `honoreeName`, `occasionType`, `deliveryDate`) — read for theme/mood brief + title-card text +
  the trigger gate.
- **Story 6 (Media uploads):** `MediaItem` (`storagePath`, `type`, `width`, `height`, `duration`,
  `mimeType`) and the **storage service** with an object **read/download** capability (Story 9 §7.3
  already adds `getObjectStream`/`downloadToFile`) + key helpers. Encoder needs **read** of
  `events/{id}/submissions/.../media/*` and **write** of `events/{id}/final/*` (§7.2).
- **Story 9 (Workers + quality):** the **BullMQ queue registry** (which already *declares*
  `encoding`), the **`enqueue` helper**, the **`buildJobKey()`** idempotency convention, the worker
  bootstrap + graceful-shutdown pattern, and the **FFmpeg-in-worker** provisioning pattern
  (`config.worker.ffmpegPath`, child-process-with-timeout wrapper, temp-file cleanup). Story 17
  **reuses these verbatim** in a separate process; it does not re-invent them.
- **Story 11 (Claude analysis):** introduces the **`AiArtifact`** model (per architecture §7.1) and
  the AI-service wrapper. Story 17 **reads** `AiArtifact.storyboardJson`/`introText`/`outroText`;
  it makes **no** AI call (it is pure FFmpeg work).
- **Story 12 (Routing gate):** the **`AI_ROUTED`** `EventStatus`. Story 17's pipeline fires only
  for `AI_ROUTED` events; Story 12 §5.6 explicitly leaves "what `AI_ROUTED` triggers (Story 16/17)"
  as the handoff seam this story (and Story 16) consume.
- **Story 16 (AI storyboard + narration):** populates `AiArtifact.storyboardJson`, `introText`,
  `outroText`, `narrationScript`, and the subtitle artifact(s); flips/owns the artifact-ready/
  admin-approved signal this story keys off (§5.2). **This is the hard upstream dependency.**

> **Dependency flags.**
> 1. The live `prisma/schema.prisma` currently has only `User`+`Role`. This design assumes Stories
>    3/6/9/11/12/16 land `Event`, `MediaItem`, `AiArtifact`, the queue infra, and the enums per
>    `architecture.md` §7.1/§8. Reconcile §6 against the merged schema before migrating.
> 2. **Story 16's `storyboardJson` shape is the authoritative input contract.** §5.3 maps the
>    architecture §9.2 `StoryboardSchema`; if Story 16 lands a richer shape (e.g. explicit clip
>    in/out trim points, audio-ducking hints, per-clip Ken-Burns for photos), reconcile before
>    coding. Flagged §13 Q1.
> 3. **Subtitles** are a Story 16 artifact (architecture §7.2 `artifacts/subtitles.srt`). If Story
>    16 stores them per-segment instead of one event `.srt`, reconcile §5.7. Flagged §13 Q2.

### Provides to later stories

- The four **`FinalVideo` rows** (`source = AI_GENERATED`, variants MASTER/REEL/YOUTUBE/THUMBNAIL) +
  their `final/` objects — **Story 15** reads these to deliver. This is the only seam Story 15
  needs from the AI path; the **same** seam Story 14 provides for the editor path
  (`source = EDITOR_UPLOADED`), so Story 15 is source-agnostic.
- The **`VideoSource`/`VideoVariant` enums** and the **`final/` storage layout**, shared with Story 14.
- The **encoder pool** + the `encoding` queue processor — a future "re-encode editor upload to
  variants" need (architecture §6.5 "enqueue: encode variants" on editor approval) can reuse this
  same encoder, parameterized by source (§13 Q11).

### Sequence within this story

```
1. Schema: add FinalVideo model + VideoSource/VideoVariant enums (if not on main)
   → verify: prisma migrate runs; generate clean
2. Encoder process: separate entry + start command; register `encoding` Worker (concurrency 2);
   graceful shutdown; FFmpeg available
   → verify: process boots, picks up an enqueued job, drains on SIGTERM
3. Assembly-plan builder: pure storyboardJson → ordered render plan (clips, durations,
   transitions, captions, intro/outro, subtitle ref)
   → verify: unit — mapping correctness, total-duration math, missing-media handling
4. Master encode: plan → MASTER 1920×1080 with burned subtitles + title cards
   → verify: integration (gated) — probe output dims/duration; subtitles present
5. Variant derivation: REEL (1080×1920 ≤90s crop), YOUTUBE (1920×1080), THUMBNAIL (1280×720)
   → verify: unit (spec params) + integration (gated, probe each)
6. Upload + persist: write final/ objects; upsert FinalVideo rows per variant; idempotent
   → verify: integration — rows + objects exist; re-run overwrites, no duplicates
7. Trigger seam: enqueue assemble job when AI_ROUTED + artifact-ready (§5.2)
   → verify: integration — enqueue on the signal; idempotent
8. Seed + tests + DoD → verify: lint/typecheck/test green
```

---

## 4. Frontend / UI Design

**Mostly N/A.** Story 17 is encoder-worker work; it ships no contributor- or organizer-facing UI,
and is never honoree-facing.

**Optional, read-only, coordinate with Story 7 (admin per-event detail) and Story 15.** The admin
may see **render progress/status + preview links** in the event detail. This story **produces** the
status signals + the `FinalVideo` rows; Story 7/15 **render** them. Suggested contract:

| Surface | Field source | Display (Story 7/15 renders) |
|---|---|---|
| Render status | `Event.status` (`AI_ROUTED` = queued/rendering; a later `IN_REVIEW`/`DELIVERED` = done — **[CONFIRM]** which status means "render complete", §13 Q8) and/or presence of `FinalVideo` rows | a status chip: "Rendering…", "Ready to review", "Delivered" |
| Per-variant availability | `FinalVideo` rows for the event (one per `variant`) | a checklist: Master ✓ / Reel ✓ / YouTube ✓ / Thumbnail ✓; missing = "pending" |
| Preview links | a **presigned GET** (15-min, Story 9/6 pattern) or **CDN signed URL** (§7.3) for each `FinalVideo.storagePath` | inline `<video>` preview / "Download" — admin-only, authenticated |
| Re-render control **[CONFIRM]** | an admin action that re-enqueues `encoding.assemble_ai_video` (idempotent by key) | "Re-render" button; §13 Q9 — whether this ships here or in Story 15 |

All admin copy honors `branding.md` §3/§10: **warm, confident, clear; no exclamation marks**;
honoree name spelled exactly as entered; occasion-aware nouns. The signature gold/gradient is
reserved for the **delivery** moment (Story 15), **not** this operational surface.

> **No render-status persistence is mandated by this story** beyond `Event.status` + the presence of
> `FinalVideo` rows. A richer per-variant progress field (e.g. `RenderJob` table or a JSON status
> column) is **[CONFIRM]** (§13 Q8) — recommendation: derive status from `FinalVideo` row presence +
> the queue/job state for MVP 1; add a status column only if the admin needs live progress mid-encode.

---

## 5. Backend / Encoder-Worker Design

This is the heart of the story. §5.1 defines the **dedicated encoder pool** (the part split from
Story 9's main worker). §5.2 defines the **trigger**. §5.3–§5.9 define the **assembly + encode**
operations. §5.10–§5.14 define persistence, idempotency, failure handling, and the Story-15 seam.

### 5.1 The dedicated encoder worker pool (separate from the AI/quality pool)

`architecture.md` §4 mandates the **Encoder Service** as a deployment target **distinct** from the
main Worker Service. The split is load-bearing, not cosmetic:

| Concern | Main worker pool (Story 9) | Encoder pool (this story) |
|---|---|---|
| Workload | transcription, analysis, quality, storyboard, script, brief-zip, notifications | **encoding only** (FFmpeg assemble + variants + thumbnail) |
| Job profile | mostly IO-bound / API-bound; seconds; bursty | **CPU-bound; minutes per job**; serialized at concurrency 2 |
| Scaling signal | queue depth on the AI queues | **`encoding` queue depth** (`architecture.md` §12 — "horizontally scale encoder workers based on queue depth") |
| Why separate | FFmpeg pegging CPU in the shared pool would cause **head-of-line blocking** of the cheap, latency-sensitive AI jobs (`architecture.md` §4) | a dedicated pool with different machine sizing (more vCPU/RAM) + autoscale rules |

**Process layout (reuse, do not re-invent, the Story 9 infra):**

- A **new entry point** — proposed `src/workers/encoder.ts` **[CONFIRM name]** (Story 9 §5.9 already
  anticipated "the encoder pool is a separate process … registers in a distinct entry e.g.
  `src/workers/encoder.ts`"). It imports the **same** queue registry + `enqueue`/`buildJobKey`
  helpers + Redis singleton-pattern + graceful-shutdown helper as `src/workers/index.ts`, but
  registers **only** the `encoding` Worker.
- **Start command:** a distinct npm script + a distinct Railway/Fly service. Proposed
  `npm run encoder` → runs `src/workers/encoder.ts` (mirrors `npm run workers` → `src/workers/
  index.ts`). **[CONFIRM]** script name (§13 Q12). The main worker process does **not** register
  `encoding`; the encoder process does **not** register the AI/quality queues. Each scales
  independently.
- **Concurrency:** the `encoding` Worker runs at concurrency **2** (`architecture.md` §8.1), read
  from `config.encoder.concurrency` (default 2). With N encoder replicas, effective concurrency =
  2 × N (autoscaled on queue depth — same per-process-default interpretation as Story 9 §5.1).
- **Redis connection rule (Story 9 §7.1):** the encoder `Worker` gets its **own** IORedis
  connection (blocking commands), created from `config.redis.url` with `maxRetriesPerRequest: null`.
  The web app and main workers, which only **enqueue**, reuse the shared singleton.
- **Graceful shutdown (Story 9 §5.9):** on SIGINT/SIGTERM call `worker.close()` (lets the in-flight
  encode finish or returns the job to the queue), then `redis.quit()`, then exit. **Encoder jobs are
  long** — set the shutdown grace timeout generously (encodes can run minutes); a rolling deploy
  should not kill a half-done render. **[CONFIRM]** grace timeout (e.g. up to the render timeout,
  §5.13 / §13 Q13). Because the job is idempotent (§5.11), a job returned to the queue and re-run is
  safe.

### 5.2 The trigger — when assembly is enqueued

The encode pipeline fires for an event that is **`AI_ROUTED`** (Story 12) **and** whose `AiArtifact`
is **storyboard-ready and admin-approved** (Story 16 owns "admin-editable" + `AiArtifact.adminApproved`).

| Question | Decision | Rationale |
|---|---|---|
| What enqueues `encoding.assemble_ai_video`? | **Story 16's pipeline tail**, after the storyboard/narration/intro-outro/subtitles are generated **and** the admin approves the artifact (`AiArtifact.adminApproved = true`). **[CONFIRM]** whether enqueue is on **admin approval** (recommended — matches "admin as creative director", lets the admin edit the script first) or on **generation completion** (faster but renders an unreviewed plan) — §13 Q3 | `requirements.md` §5.5/§5.6 + `architecture.md` §6.4: the admin is in the loop; the storyboard/script are admin-editable before render |
| Is there an admin "Render now" action? | **[CONFIRM]** (§13 Q9). Recommended: the admin-approve action (Story 16/7) enqueues; a manual "Re-render" is a thin idempotent re-enqueue (§4, §5.11) | Re-render must be safe (idempotent), so a button is low-risk |
| Pre-conditions checked by the processor at run time | `Event.status == AI_ROUTED` (or a later "rendering" status), `AiArtifact` exists with a **non-empty `storyboardJson`** and at least one resolvable media item. If not met → fail fast with a typed error (no partial output) | Defensive: a stale/duplicate enqueue must not render garbage |

The processor **re-reads** the authoritative `Event` + `AiArtifact` + referenced `MediaItem` rows at
run time (ids-only payload, Story 9 §5.3 rule), so a retry always sees current state (e.g. an
admin-edited storyboard).

### 5.3 The assembly job — payload & the storyboard→plan mapping

| Item | Value |
|---|---|
| Queue | `encoding` (declared in Story 9 registry; processor added here, in the encoder process) |
| Concurrency / priority | **2 / Normal** (`architecture.md` §8.1) |
| Job name (`job_type`) | `encoding.assemble_ai_video` |
| Payload | `{ eventId }` — **id only** (Story 9 §5.3). The processor re-fetches `Event` + `AiArtifact` + the storyboard's referenced `MediaItem`s |

**The storyboard contract (architecture §9.2 `StoryboardSchema` — the input this story maps).**
Each `sequence[]` entry and the top-level fields:

| `storyboardJson` field | Type (per §9.2) | How this story uses it |
|---|---|---|
| `sequence[].submission_id` | string | provenance / scoping; resolve the owning submission |
| `sequence[].media_item_id` | string | **the clip to render** — resolve to `MediaItem.storagePath` + `type`/`width`/`height`/`duration` |
| `sequence[].media_type` | `video`\|`voice`\|`photo`\|`text` | selects the per-type render treatment (§5.5) |
| `sequence[].duration_sec` | number | **the on-screen duration** for this entry (a photo is held this long; a video may be trimmed to it — §5.5, §13 Q1 trim semantics) |
| `sequence[].clip_note` | string | editor-readable note; **not rendered** (ignored by the encoder) |
| `sequence[].transition_in` | string | the transition **into** this clip (§5.5.4 transition vocabulary) |
| `sequence[].caption` | string (optional) | an **on-screen caption** for this clip (distinct from burned subtitles — §5.5.5, §13 Q6) |
| `total_duration_sec` | number | expected total; used as a **sanity check** vs the summed plan (§5.3 validation) |
| `pacing_notes` | string | editor-readable; **not rendered** |

**The assembly-plan builder (a pure function — unit-testable without FFmpeg).** Map
`storyboardJson` + `AiArtifact.introText`/`outroText` + `Event.theme`/`musicMood` into an ordered
**render plan**: a list of **segments** (intro card → clip₁ → clip₂ → … → outro card) where each
segment carries `{ kind, source, durationSec, transitionIn, caption }`, plus a top-level
`{ subtitleRef, theme, masterSpec }`. This pure plan is the seam the unit tests assert against; the
FFmpeg layer consumes the plan (§5.4). Validation in the builder:

- Every `media_item_id` must resolve to a readable `MediaItem` with a non-empty `storagePath`;
  unresolved entries are handled per the **missing-media policy** (§5.12 — skip-with-log vs fail,
  §13 Q7).
- The summed segment duration is compared to `total_duration_sec`; a large mismatch is logged (not
  fatal) — the plan's summed duration is authoritative.
- The plan is **deterministic** given the same `storyboardJson` + artifact + media metadata.

### 5.4 The encode pipeline — overall shape (described, not coded)

The encoder builds outputs in a **gated order**: **MASTER first**, then the three derived variants
**from the master**. Deriving REEL/YOUTUBE/THUMBNAIL from the finished master (rather than
re-assembling from source per variant) guarantees they are the same edit and is far cheaper.

```
storyboardJson + intro/outro + theme + subtitles
                    │
        ┌───────────▼───────────┐
        │  build render plan     │ (pure, §5.3)
        └───────────┬───────────┘
                    ▼
        ┌───────────────────────┐
        │  ENCODE MASTER         │  1920×1080, clip audio (+narration?), burned subtitles,
        │  (assemble segments)   │  intro/outro title cards, transitions
        └───────────┬───────────┘
                    │  master.mp4 (gate — derived variants need it)
        ┌───────────┼───────────────┬─────────────────┐
        ▼           ▼               ▼                 ▼
   ┌─────────┐ ┌──────────┐  ┌────────────┐    ┌────────────┐
   │  REEL   │ │ YOUTUBE  │  │ THUMBNAIL  │    │  (upload    │
   │1080×1920│ │1920×1080 │  │ 1280×720   │    │  + persist  │
   │ ≤90s    │ │          │  │  JPG       │    │  each, §5.10)│
   └─────────┘ └──────────┘  └────────────┘    └────────────┘
```

All four targets are described per-spec in §5.8. Each target's encode runs the FFmpeg binary via the
**Story 9 child-process-with-timeout wrapper** (`config.encoder.ffmpegPath`, per-job timeout, temp
files cleaned in `finally`, child killed on timeout — §5.13).

### 5.5 MASTER assembly — per-clip treatment, intro/outro, transitions, captions

The master is a single 1920×1080 timeline built from the plan's segments.

#### 5.5.1 VIDEO clips
- Scaled/letterboxed-or-cropped to fit the 1920×1080 master frame (preserve aspect; **[CONFIRM]**
  pad-to-fit vs fill-crop for landscape source — recommend **scale-to-fit with a themed pad/blur
  background** for non-16:9 source so nothing is lost; §13 Q10).
- **Portrait source video** in a landscape master: scale-to-fit centered, with a blurred-fill or
  themed background filling the side bars (a common, tasteful treatment). **[CONFIRM]** background
  fill style (§13 Q10).
- Trimmed to the entry's `duration_sec` if the source is longer; if shorter, **[CONFIRM]** hold the
  last frame vs use the natural length (§13 Q1). Audio comes from the clip (§5.6).

#### 5.5.2 PHOTO clips
- Displayed as a still for `duration_sec`, scaled to fit 1920×1080 with the same themed
  pad/blur-fill treatment. **Optional gentle Ken-Burns** (slow zoom/pan) — **[CONFIRM]** whether
  MVP 1 does a static hold (simpler, recommended) or Ken-Burns (nicer, more parameters) — §13 Q10.

#### 5.5.3 VOICE / TEXT entries
- **VOICE:** audio-only source. Render a **themed visual** (the intro/outro title-card style — §5.5.6
  — or a "now playing" card with the contributor's caption) for the audio's duration. **[CONFIRM]**
  visual treatment for voice (§13 Q6).
- **TEXT** (`media_type == 'text'`): render the text as an on-screen card in the title-card style for
  `duration_sec`. (Whether Story 16 ever emits `text` sequence entries is its decision; the encoder
  handles it if present.)

#### 5.5.4 Transitions (`transition_in`)
- A small, fixed **transition vocabulary** maps each storyboard `transition_in` string to a concrete
  effect: e.g. `cut` (hard), `fade` (cross-dissolve / fade-through-black), `dissolve`. Unknown/empty
  → default to `cut` (or a short `fade` — **[CONFIRM]** default, §13 Q6). The vocabulary is a
  **closed set in code**; the storyboard's free string is normalized to it (a typo → default, never
  a render failure). Transition fidelity is best-effort (§13 Q15) — the storyboard is a spec, not a
  frame-accurate timeline.

#### 5.5.5 Per-clip captions (`sequence[].caption`)
- The optional `caption` is an **on-screen lower-third caption** for that clip (e.g. the
  contributor's name/relationship), **distinct** from the **subtitle burn-in** (§5.7, which is the
  spoken-word transcript). **[CONFIRM]** caption vs subtitle layering (don't overlap visually) —
  §13 Q6. Captions are styled per theme (§5.5.6).

#### 5.5.6 Intro / outro title cards
- Generated from `AiArtifact.introText` (open) and `outroText` (close), rendered as **title cards**
  in the **branding visual style** (`branding.md` §6 wordmark, §4 palette/gradient, §5 typography):
  - Intro: the event/honoree framing (honoree name **spelled exactly as entered** — `branding.md`
    §10), themed background per `Event.theme` (Classic/Cinematic/Vibrant/Minimal — `requirements.md`
    §5.1), the **Swara Magical Memories wordmark** (`branding.md` §6).
  - Outro: the `outroText` close + wordmark + the co-brand "by Swara Media" line (`branding.md` §6).
  - The signature **gradient** (`branding.md` §4) and a gentle reveal feel may be used on the
    title cards (this is the product's "magical" register — `branding.md` §9). **[CONFIRM]** exact
    card layout/templates per theme — these are visual-design decisions (§13 Q10). Title-card text is
    rendered (drawn) onto the frame, not burned as subtitles.
- **Theme/music-mood as a brief only:** `Event.theme` selects the title-card visual template +
  caption styling; `Event.musicMood` is captured as a **brief** and does **not** select or add music
  (no music in the AI path — §5.6). It may influence pacing/transition defaults **[CONFIRM]** or be
  ignored by the encoder entirely (§13 Q5).

### 5.6 Audio in the master — and the music-licensing flag

| Audio source | Treatment |
|---|---|
| **Clip audio** (VIDEO/VOICE) | The contributors' own recorded audio plays during their clip. Normalize levels across clips so volumes are consistent **[CONFIRM]** loudness normalization target (§13 Q5). |
| **Narration track** | **[CONFIRM]** (§13 Q4): if Story 16 produces a **TTS audio** of `narrationScript`, mix/duck it over the timeline. If Story 16 produces only **text** narration (no audio), there is **no narration audio** and the master uses clip audio only. **Default assumption (MVP 1): no synthesized narration audio** — the narration script informs subtitles/title cards, not a voiceover — until Story 16 confirms otherwise. |
| **Music bed** | **NONE.** Music licensing is the editor's responsibility and **out of scope** (`architecture.md` §15 "No automatic music selection", `requirements.md` §9). The AI path adds **no** licensed or stock music track. `Event.musicMood` is a brief only and is not realized as audio here. **This is a hard constraint — flag in review if any music source is introduced.** |
| **Silent stretches** (photo/text cards with no audio) | Render with silence (or, if narration audio exists, that narration) — never a music bed. |

### 5.7 Subtitle burn-in

- The subtitle artifact is produced by **Story 16** (Whisper-aligned `.srt`, `architecture.md` §7.2
  `artifacts/subtitles.srt`; `requirements.md` §5.3 "Generate subtitle files (.srt)"). This story
  **burns** those subtitles into the **MASTER** so they are visually present (no separate sidecar
  track needed for the social variants).
- The subtitle reference comes from the artifact (`AiArtifact` or the `artifacts/subtitles.srt`
  storage path — **[CONFIRM]** where Story 16 stores it; §13 Q2). The encoder downloads the `.srt`
  and burns it via FFmpeg's subtitle filter, styled per theme (legible, WCAG-contrast caption box).
- **Timing alignment:** subtitles must align to the **assembled** timeline (clip cuts/trims shift
  word timings). **[CONFIRM]** whether Story 16 emits subtitles already aligned to the storyboard
  cut list, or per-source-clip (then the encoder must offset each clip's subtitles by its position
  in the master). This is a real coupling between Story 16 and 17 — §13 Q2.
- Because REEL/YOUTUBE are derived **from the master** (§5.4), the burned subtitles propagate to all
  variants automatically (the thumbnail is a single frame — pick a frame **without** a subtitle
  overlay if possible, §5.9).

### 5.8 Output variant specifications (the exact target specs)

All four are derived **from the finished master** (§5.4). Container/codec defaults follow common
web-delivery + social-platform conventions; exact codec params are **[CONFIRM]** (§13 Q15) but the
**dimensions, container, and duration caps below are firm** (they come from `requirements.md` §5.8).

| Variant (`VideoVariant`) | Dimensions | Container / type | Duration | Source | `final/` path | Notes |
|---|---|---|---|---|---|---|
| **MASTER** | **1920×1080** (16:9) | MP4 (H.264 + AAC) | full assembled length | assembled from storyboard | `events/{id}/final/master.mp4` | Primary deliverable; the gate for the others; subtitles burned in |
| **YOUTUBE** | **1920×1080** (16:9) | MP4 (H.264 + AAC), YouTube-friendly | full length | from master | `events/{id}/final/youtube.mp4` | Re-encode of the master tuned for YouTube upload (`requirements.md` §5.8). **[CONFIRM]** whether YOUTUBE is a distinct re-encode (different bitrate/keyframe tuning) or effectively identical to MASTER — §13 Q16 |
| **REEL** | **1080×1920** (9:16 vertical) | MP4 (H.264 + AAC) | **≤90s** (hard cap) | from master | `events/{id}/final/reel.mp4` | Vertical crop of the master (§5.8.1); trimmed to ≤90s (§5.8.2) |
| **THUMBNAIL** | **1280×720** | **JPG** | n/a (single frame) | from master | `events/{id}/final/thumbnail.jpg` | Extracted frame (§5.9); for YouTube + share page (`requirements.md` §5.8) |

#### 5.8.1 Reel vertical-crop strategy (1920×1080 → 1080×1920)
The master is 16:9 landscape; the Reel is 9:16 portrait — a fundamental aspect change. Options
(**[CONFIRM]** — this is the headline open question, §13 Q10):

| Strategy | Description | Trade-off |
|---|---|---|
| **(A) Center-crop** | Crop a centered 1080-wide column out of the 1920-wide master, scale to 1080×1920 | Simple; **risks cutting off faces** at frame edges — bad for tribute video where the person is the point |
| **(B) Blurred-pad (letterbox)** *(recommended)* | Place the full 16:9 master (scaled to 1080 wide) centered on a 1080×1920 canvas, fill top/bottom with a blurred/themed background | **No content lost**, faces preserved; the standard tasteful social treatment; matches the §5.5 pad/blur-fill choice |
| **(C) Smart/face-aware crop** | Detect the subject and crop around it | Best result, **most complex** (needs face detection) — defer to MVP 2 |

**Recommendation: (B) blurred-pad** for MVP 1 (consistent with the master's non-16:9 source
treatment, §5.5.1). Flagged §13 Q10.

#### 5.8.2 Reel ≤90s cap
The master may exceed 90s. The Reel must be **≤90s** (`requirements.md` §5.8). **[CONFIRM]** the
trim policy (§13 Q17):
- **(Recommended) Trim to the first 90s** of the assembled timeline (intro + as many clips as fit),
  ending on a clean clip/segment boundary where possible.
- Alternative: a storyboard-provided "reel cut" (a shorter sequence) if Story 16 emits one — it does
  not, per §9.2, so first-90s is the MVP default.
The cap is enforced at encode time; the resulting `durationSec` is recorded (§5.10).

### 5.9 Thumbnail extraction (1280×720 JPG)
- Extract **one frame** from the master, scaled to **1280×720**, written as **JPG**
  (`requirements.md` §5.8). Frame-selection policy **[CONFIRM]** (§13 Q18):
  - **(Recommended) A representative frame** — e.g. a frame a few seconds in (past the intro card),
    avoiding black/transition frames and (ideally) frames with a subtitle overlay. A simple,
    deterministic rule (e.g. "frame at t = intro_duration + 2s") is enough for MVP 1.
  - Story 16 may provide AI-picked thumbnail-candidate stills (`architecture.md` §7.2
    `artifacts/thumbnail-candidates/`); if present, prefer the top candidate — **[CONFIRM]** (§13 Q18).
- **Surprise/honoree safety (§10):** the thumbnail is used on the share page; per `architecture.md`
  §10.1 the share OG image should be honoree-name-free by default. The thumbnail JPG itself is a
  video frame (may show the honoree), but it is served only behind the **private** share token, not
  as a public OG preview. The public OG image (`share/poster.jpg`, §7.2) is a Story 15 concern; this
  story produces only the private `final/thumbnail.jpg`. Flag the distinction (§10).

### 5.10 Upload + persistence (`FinalVideo` rows)
For each produced output, after the encode succeeds:
1. **Upload** the file to its `final/` path (§5.8 table) via the storage service (**write** scope),
   private ACL (`architecture.md` §7.2).
2. **Probe** the uploaded/just-encoded file for `durationSec` (null for THUMBNAIL) and read
   `sizeBytes` from the file/upload.
3. **Upsert one `FinalVideo` row** per variant (§6.1): `eventId`, `source = AI_GENERATED`, `variant`,
   `storagePath`, `durationSec`, `sizeBytes`. Upsert (not insert) so a **re-render overwrites** the
   existing row for `{eventId, variant}` instead of duplicating (§5.11, §6.3).

### 5.11 Idempotency — key per `{event}:{variant}` + the event-level job key
Two idempotency layers (Story 9 §5.4 contract):

- **Job-level (BullMQ `jobId`):** `buildJobKey({ eventId }, 'encoding.assemble_ai_video')` →
  **`{eventId}::encoding.assemble_ai_video`** (no submission segment — this is event-level, like
  Story 12's `routing.finalize`). BullMQ dedups an in-flight duplicate enqueue.
- **Output-by-key (the brief's `{event}:{variant}` key):** each output writes to a **deterministic
  S3 path** (`final/{variant}.{ext}` — fixed per variant) and **upserts** the `FinalVideo` row keyed
  by **`(eventId, variant)`** (a unique constraint, §6.2). Re-running the job **overwrites** the same
  object and the same row — never appends, never duplicates. This realizes the brief's "idempotency
  key per `{event}:{variant}`" and "re-render overwrites by key" (§6.3).

> **Why event-level job key + per-variant output key.** One job renders all four variants for an
> event, so the **job** is keyed by event. The **outputs** are keyed by `{event, variant}` so a
> re-render (or a partial-failure retry that re-does only some variants) overwrites the right object/
> row. The two layers compose: the job is safe to re-enqueue (dedup), and safe to re-run (overwrite).

### 5.12 Retry / backoff + partial-failure handling
| Setting | Value | Rationale |
|---|---|---|
| `attempts` (BullMQ) | **3** **[CONFIRM]** (encodes are expensive — maybe **2**, §13 Q19) | Story 9 posture; but each retry re-encodes (costly), so keep low |
| `backoff` | exponential, base ~30s **[CONFIRM]** | Encoder failures (OOM, transient storage) benefit from a pause; not a rate-limited API |
| Lock / stalled | BullMQ lock duration **> the render timeout** (§5.13) so a long legitimate encode is not declared stalled and re-queued mid-render | A 1080p assemble can run minutes; the lock must outlast it |
| On exhausting attempts | Job → `failed` set (kept for inspection). `Event` status **not** advanced to a "ready" state; **alert** (§11). No partial `FinalVideo` rows are presented as a complete deliverable | Distinguish "render failed" from "rendered" |

**Partial-failure handling (the brief's explicit requirement):**

- **The master gates the variants.** If the **master** encode fails, the job fails (no variants are
  attempted) — there is nothing to derive from.
- **Per-variant resilience.** Once the master exists and is uploaded + persisted, each derived
  variant (REEL/YOUTUBE/THUMBNAIL) is attempted; a failure of **one** variant must not discard the
  **completed** variants (the master + any already-finished derived variants stay persisted as
  `FinalVideo` rows). Two designs (**[CONFIRM]** §13 Q20):
  - **(Recommended) Single job, idempotent per-variant skip.** The job, on (re)run, **skips
    variants whose `FinalVideo` row + object already exist** and only (re)does the missing ones. So a
    retry after a REEL failure re-uses the already-uploaded master/youtube/thumbnail and only
    re-renders REEL. Output-by-key (§5.11) makes this safe. The job succeeds only when **all four**
    rows exist; otherwise it throws (so BullMQ retries the remaining work).
  - Alternative: **fan-out** — the assemble job produces the master, then **enqueues one job per
    derived variant** (`encoding.derive_variant` keyed `{eventId}:{variant}`). Each variant retries
    independently. Richer, more queue traffic; defer unless per-variant scaling is needed.
- **Completed-variant visibility.** Story 15 should only treat the event as deliverable when the
  **required** variants exist (at minimum MASTER + the package's variants — `requirements.md` §4
  packages read `features[]`; MVP 1 = all four). **[CONFIRM]** the minimum-set gate with Story 15
  (§13 Q21).

### 5.13 Resource / timeout considerations
- **Per-job render timeout** (`config.encoder.renderTimeoutMs`, §7.5): the child FFmpeg process is
  killed if it exceeds the timeout → job fails (retryable). A pathological storyboard (hundreds of
  long clips) must not hang an encoder slot forever.
- **Temp/scratch disk:** the encoder downloads source clips + the subtitle file + writes
  intermediate/output files to a temp dir; **always clean up in `finally`** (Story 9 §5.5). Bound
  total scratch use; the encoder host needs enough ephemeral disk for the largest event's source set
  + outputs. **[CONFIRM]** scratch-dir sizing / a streaming-vs-download strategy for large source
  sets (§13 Q22).
- **CPU/RAM sizing:** the encoder host is sized larger than the AI worker (CPU-bound encodes);
  concurrency 2 means up to 2 simultaneous FFmpeg processes per replica — size RAM/CPU accordingly.
- **Hostile/oversized input is already mitigated upstream** (Story 6/9 validated + quality-scored the
  media); still apply per-process timeouts + bounded decode work (Story 9 §10) defensively.
- **Total render time** is an open product question (§13 Q23) — a large event could take many
  minutes; the SLA/delivery-date tracking (`architecture.md` §11.2) must account for encode time.

### 5.14 Handoff seam to Story 15 (Delivery)
Story 15 (share page + download link + delivery email) consumes **only**:
- The **`FinalVideo` rows** for the event (`source` agnostic — AI or editor), one per `variant`.
- The **CDN-signing contract** (§7.3): final videos are served via the CDN with **signed URLs**
  (`CDN_DOMAIN`/`CDN_SIGNING_KEY`, `architecture.md` §4/§7.2/§14). This story does **not** build the
  share page or send any email; it guarantees the rows + objects exist at the documented `final/`
  paths so Story 15 can sign + serve them. The CDN-signing helper may be authored here (it's needed
  to validate delivery) or in Story 15 — **[CONFIRM]** ownership (§13 Q24); recommend the
  **config keys** (`CDN_DOMAIN`/`CDN_SIGNING_KEY`) land here (the encoder writes the CDN-served
  objects) and the signing **helper** lands wherever it's first consumed.

---

## 6. Database Design

Story 17 adds the **`FinalVideo`** model and the **`VideoSource`/`VideoVariant`** enums from
`architecture.md` §7.1, **shared with Story 14** (the editor-upload path). It reuses `Event`
(Story 3) and `AiArtifact` (Story 11) unchanged (it only **reads** `AiArtifact`).

### 6.1 `FinalVideo` model (added this story, or by Story 14 — whichever lands first)

| Field | Type | Null? | Default | Written by | Meaning |
|---|---|---|---|---|---|
| `id` | `String` (cuid) | no | `cuid()` | — | PK |
| `eventId` | `String` | no | — | this story | FK → `Event` (with `event Event @relation(... onDelete: Cascade)`) |
| `source` | `VideoSource` | no | — | this story | `AI_GENERATED` (this story) \| `EDITOR_UPLOADED` (Story 14) |
| `variant` | `VideoVariant` | no | — | this story | `MASTER` \| `REEL` \| `YOUTUBE` \| `THUMBNAIL` |
| `storagePath` | `String` | no | — | this story | the `final/` object key (§5.8 table) |
| `durationSec` | `Int?` | yes | — | this story | seconds; **null for THUMBNAIL** |
| `sizeBytes` | `Int` | no | — | this story | file size of the uploaded object |
| `createdAt` | `DateTime` | no | `now()` | — | when the row was first created (upsert keeps original on overwrite, or refreshes — §6.3) |

This matches `architecture.md` §7.1 `FinalVideo` exactly (no extra columns invented). The
`Event.finalVideos FinalVideo[]` relation already appears in architecture §7.1.

### 6.2 Uniqueness — the idempotency key in the schema
Add a **`@@unique([eventId, variant])`** constraint so each event has **at most one** row per
variant. This is what makes the `{event}:{variant}` re-render idempotent (§5.11): the persist step
is an **upsert on `(eventId, variant)`**.

> **[CONFIRM] with Story 14** (§13 Q25): the `(eventId, variant)` unique key means an event has one
> MASTER, one REEL, etc., **regardless of source**. An AI render then an editor upload of the same
> variant would **overwrite** (last-writer-wins) — which is the desired behavior for MVP 1 (an event
> goes down **one** path, AI or manual, never both; Story 12's gate is exclusive). If both sources
> could coexist, the unique key would need `(eventId, source, variant)` — but per the routing gate
> they cannot, so `(eventId, variant)` is correct and simpler. Confirm with Story 14.

### 6.3 How re-render overwrites by key
- **S3 object:** fixed path per variant (`final/{variant}.{ext}`) → re-upload overwrites in place
  (R2/S3 PUT to the same key replaces the object; versioning is enabled on `final/` per
  `architecture.md` §11.3, so prior versions are retained for recovery).
- **`FinalVideo` row:** `upsert` on `(eventId, variant)` → updates `storagePath`/`durationSec`/
  `sizeBytes` (and **[CONFIRM]** whether to refresh `createdAt` or keep the original — recommend
  keep original `createdAt`; add an `updatedAt @updatedAt` only if a later story needs it, but
  architecture §7.1 does **not** list `updatedAt` on `FinalVideo`, so do **not** add it — §13 Q26).
- **Concurrency:** the event-level job key (§5.11) means only one assemble job per event runs at a
  time (BullMQ dedup); the per-variant upserts within it are sequential, so no intra-event row race.

### 6.4 Migration notes
- **`FinalVideo` model + `VideoSource` + `VideoVariant` enums:** added by whichever of **Story 14 or
  Story 17** lands first; the other story finds them present and only **writes** rows. Since 14 and
  17 are **parallel** (`stories.md`), coordinate which PR owns the migration. **[CONFIRM]** owner
  (§13 Q27). The migration is **additive + nullable-where-noted** → safe `prisma migrate deploy`, no
  backfill.
- Enums (architecture §7.1): `enum VideoSource { AI_GENERATED EDITOR_UPLOADED }`,
  `enum VideoVariant { MASTER REEL YOUTUBE THUMBNAIL }` — define exactly these values.
- The `Event.finalVideos FinalVideo[]` relation + `onDelete: Cascade` (so right-to-delete /
  hard-delete, `architecture.md` §11.4, removes the rows; the **S3 objects** are removed by the
  delete sweep, not the cascade).

---

## 7. External Services / Integrations / Config

### 7.1 FFmpeg in the encoder runtime
- The encoder process invokes **FFmpeg** for assembly, scaling/crop/pad, transitions, subtitle
  burn-in, variant re-encodes, and thumbnail extraction. The binary must be present in the
  **encoder** Docker image — reuse the Story 9 provisioning pattern (system `ffmpeg` in the image,
  path overridable via config). FFmpeg here is **heavier** than Story 9's FFprobe metadata use (full
  encodes), so the encoder image/host is sized for it (§5.13).
- Run via the **same child-process-with-timeout wrapper** as Story 9 (timeout, kill-on-timeout, temp
  cleanup). **[CONFIRM]** whether to reuse Story 9's wrapper module directly or have a
  encoder-specific wrapper with longer default timeouts (§13 Q13).

### 7.2 S3 / object storage — read media, write `final/`
- **Read:** source clips from `events/{id}/submissions/.../media/*` + the subtitle artifact from
  `events/{id}/artifacts/subtitles.srt` (Story 16) + (optional) thumbnail candidates. Reuse the
  Story 6/9 storage **read/download** capability.
- **Write:** the four outputs to `events/{id}/final/master.mp4` / `reel.mp4` / `youtube.mp4` /
  `thumbnail.jpg` (`architecture.md` §7.2). Private ACL. The encoder host's `S3_*` credentials need
  **read** on `submissions/`+`artifacts/` and **write** on `final/` (scoped per `architecture.md`
  §7.2 / §10.3). For large outputs, use multipart upload (Story 13's streaming-upload pattern is a
  reference).

### 7.3 CDN signing for delivery (`CDN_DOMAIN` / `CDN_SIGNING_KEY`)
- Final videos are **served via the CDN** with **signed URLs** (`architecture.md` §4 "Final videos
  served via CloudFront/Cloudflare CDN", §7.2 "CDN-served paths … use signed URLs with 24-hour
  expiry", §14 `CDN_DOMAIN`/`CDN_SIGNING_KEY`). This story **writes** the CDN-served objects (the
  `final/` files); the **signing helper** (build a signed `https://{CDN_DOMAIN}/...` URL with a 24h
  expiry using `CDN_SIGNING_KEY`) is consumed by **Story 15** (delivery) and the admin preview (§4).
- **[CONFIRM]** signing-helper ownership (§13 Q24); the **config keys** land here (§7.5) regardless,
  since the encoder is the producer of CDN-served content and the delivery seam (§5.14) references them.

### 7.4 Dedicated encoder worker host
- A **separate** Railway/Fly service from the main worker (`architecture.md` §4), running the
  `src/workers/encoder.ts` entry via `npm run encoder` (§5.1). Autoscales on **`encoding` queue
  depth** (`architecture.md` §12). Sized for CPU-bound encodes (more vCPU/RAM than the AI worker).
  **[CONFIRM]** provider + autoscale rule (§13 Q12).

### 7.5 Config — wire through BOTH config files
Per the load-bearing convention (no `process.env` outside `src/config/`). Current `env.ts` exposes
only `NODE_ENV`/`DATABASE_URL`/`REDIS_URL`/`NEXT_PUBLIC_APP_URL`; this story adds an **`encoder`**
block + **`cdn`** block (and reuses Story 9's `worker.ffmpegPath` if shared, or adds an
encoder-specific path).

**Add to `src/config/env.ts`** (raw reads only):

| Raw key | Source env var | Purpose |
|---|---|---|
| `ENCODER_CONCURRENCY` | `process.env.ENCODER_CONCURRENCY` | Encoder Worker concurrency (default **2**, `architecture.md` §8.1) |
| `FFMPEG_PATH` | `process.env.FFMPEG_PATH` | FFmpeg binary path (default `ffmpeg` on PATH; shared with Story 9 if present) |
| `ENCODE_RENDER_TIMEOUT_MS` | `process.env.ENCODE_RENDER_TIMEOUT_MS` | Per-job render timeout (default e.g. **1800000** = 30 min) **[CONFIRM]** |
| `ENCODE_SCRATCH_DIR` | `process.env.ENCODE_SCRATCH_DIR` | Temp/scratch dir for downloads + intermediates (default OS tmp) **[CONFIRM]** |
| `CDN_DOMAIN` | `process.env.CDN_DOMAIN` | CDN host for signed delivery URLs (`architecture.md` §14) |
| `CDN_SIGNING_KEY` | `process.env.CDN_SIGNING_KEY` | CDN URL-signing key (`architecture.md` §14) |

**Add to `src/config/index.ts`** — `encoder` + `cdn` objects on the Zod schema:

| Config field | Type | Mapping / default |
|---|---|---|
| `encoder.concurrency` | `z.coerce.number().int().positive()` | `ENCODER_CONCURRENCY` ?? `2` |
| `encoder.ffmpegPath` | `z.string()` | `FFMPEG_PATH` ?? `'ffmpeg'` |
| `encoder.renderTimeoutMs` | `z.coerce.number().int().positive()` | `ENCODE_RENDER_TIMEOUT_MS` ?? `1800000` **[CONFIRM]** |
| `encoder.scratchDir` | `z.string()` | `ENCODE_SCRATCH_DIR` ?? OS tmp **[CONFIRM]** |
| `cdn.domain` | `z.string()` | `CDN_DOMAIN` (**[CONFIRM]** `.optional()` in dev/test where no CDN — §13 Q28) |
| `cdn.signingKey` | `z.string()` | `CDN_SIGNING_KEY` (optional in dev/test; required in prod via superRefine, mirror Story 11 §7.5 key-required pattern) |

Add the new keys to `.env.example` under `# === Encoder ===` and `# === CDN ===` blocks. **[CONFIRM]**
exact defaults (§13 Q28). The `S3_*` keys already exist (Story 6). No new npm dependency strictly
required (FFmpeg is a system binary; `bullmq`/`zod` already present) — **[CONFIRM]** whether a
filter-graph/helper library is wanted vs raw FFmpeg invocation (recommend raw FFmpeg via the wrapper;
§13 Q29).

---

## 8. Seed Data
Extend the existing `npm run seed` path so the AI-render path is exercisable locally and the admin
UI (Story 7/15) has sample data.

- **An `AI_ROUTED` event with an approved storyboard/artifacts.** Seed an `Event` (status
  `AI_ROUTED`, a `theme` + `musicMood`, an exact honoree name) with a few approved submissions +
  `MediaItem` rows (the Story 6/9 seed media — valid tiny MP4/MP3/JPG), and an `AiArtifact` with a
  **valid `storyboardJson`** (a small `sequence[]` referencing the seeded media item ids, per the
  §9.2 shape), `introText`, `outroText`, and a tiny `subtitles.srt` artifact. This is the input the
  assemble job consumes.
- **Mock / sample `FinalVideo` rows.** Seed four `FinalVideo` rows (one per variant,
  `source = AI_GENERATED`) pointing at placeholder `final/` paths so the **admin/delivery UI renders
  without running a real encode**. Note clearly that these are **placeholders** — the `storagePath`
  objects may not exist until a real encode runs.
- **Real-encode local recipe (documented, gated).** `docker compose up -d` (Redis + MinIO), `npm run
  seed`, `npm run encoder`, then enqueue `encoding.assemble_ai_video` for the seeded event (a dev
  enqueue script, mirroring Story 9 §8). **Note:** a *real* encode needs **valid sample media** with
  real frames/audio (the tiny seed assets must be genuinely decodable, not zero-byte) and **FFmpeg
  installed locally**. **[CONFIRM]** seed media are real, decodable clips of a few seconds (§13 Q20
  / Story 9 §13 Q20).
- The placeholder-rows path keeps `npm run seed` + CI **fast and offline** (no FFmpeg needed); the
  real-encode path is opt-in behind `ENCODE_INTEGRATION` (§9).

---

## 9. Testing
Follows the Story 1/9/11 pattern (Vitest, `tests/unit` + `tests/integration`). Two gates:
**`SKIP_INTEGRATION`** (skips anything needing Redis/MinIO) and a **heavier `ENCODE_INTEGRATION`**
gate (skips the real-FFmpeg-encode tests, which need FFmpeg + are slow) so normal CI stays green and
fast.

### 9.1 Unit (no infra, no FFmpeg — pure logic)
| Test | Asserts |
|---|---|
| Variant spec correctness | each variant's target spec is exactly: MASTER 1920×1080, YOUTUBE 1920×1080, REEL 1080×1920, THUMBNAIL 1280×720; REEL duration cap = 90s; THUMBNAIL is JPG (the spec table §5.8 is encoded as constants and asserted) |
| Storyboard → assembly-plan mapping | a fixture `storyboardJson` maps to the expected ordered segment plan (intro card → clips in order → outro card); per-clip `durationSec`/`transitionIn`/`caption` carried through; `clip_note`/`pacing_notes` ignored |
| Plan total-duration math | summed segment duration = expected; mismatch vs `total_duration_sec` is logged not fatal |
| Missing-media handling | an unresolved `media_item_id` is handled per the confirmed policy (skip-with-log vs fail, §5.12 / §13 Q7) |
| Reel ≤90s trim policy | given a master longer than 90s, the plan/trim yields ≤90s (first-90s rule, §5.8.2) |
| Reel crop strategy params | the confirmed crop (blurred-pad) produces the right target geometry params (no content lost) |
| Thumbnail frame-selection rule | the deterministic frame-time rule (e.g. intro+2s) is computed correctly; prefers a Story-16 candidate when present (§5.9) |
| `final/` path construction | each variant's storage key is exactly `events/{id}/final/{name.ext}` (master.mp4/reel.mp4/youtube.mp4/thumbnail.jpg) |
| Idempotency key | job key = `{eventId}::encoding.assemble_ai_video`; output upsert key = `(eventId, variant)`; stable for same inputs |
| `FinalVideo` row mapping | a produced output maps to a row with `source = AI_GENERATED`, the right `variant`, `storagePath`, `durationSec` (null for THUMBNAIL), `sizeBytes` |
| Transition vocabulary normalization | known `transition_in` strings map to the effect; unknown/empty → the default |
| No-music invariant | the audio-plan never includes a music-bed source (a guard test for the §5.6 hard constraint) |

> Keep the **plan builder** a pure function (`buildRenderPlan(storyboardJson, artifact, event,
> mediaById) → RenderPlan`) and the **spec table** as constants, so the bulk of the logic is
> unit-tested without FFmpeg, a DB, or S3. The FFmpeg layer (which consumes the plan) is exercised
> only in the gated integration tests.

### 9.2 Integration (`SKIP_INTEGRATION` guards Redis + MinIO; `ENCODE_INTEGRATION` guards real FFmpeg)
| Test | Flow | Gate |
|---|---|---|
| Enqueue → assemble → `FinalVideo` rows + S3 objects (happy path, small storyboard) | seed an `AI_ROUTED` event + valid tiny media + `storyboardJson` → enqueue `encoding.assemble_ai_video` → run the encoder → assert 4 `FinalVideo` rows (correct variants/source) + 4 objects at the `final/` paths; **probe** each object's dimensions/duration against §5.8 (master/youtube 1920×1080; reel 1080×1920 & ≤90s; thumbnail 1280×720 JPG) | `ENCODE_INTEGRATION` (real FFmpeg) |
| Subtitle burn-in present | a master encoded with a seed `.srt` shows burned subtitles (probe/visual check on a sampled frame) | `ENCODE_INTEGRATION` |
| Idempotent re-render | run the job twice → assert the `final/` objects are overwritten (not duplicated) and exactly 4 `FinalVideo` rows remain (upsert, not insert) | `ENCODE_INTEGRATION` (or mockable-FFmpeg variant) |
| Partial-failure resilience | force one variant (e.g. REEL) to fail → assert master/youtube/thumbnail rows persist; re-run completes only the missing REEL (skip-existing, §5.12) | `ENCODE_INTEGRATION` |
| Master-fails-gates-variants | force the master encode to fail → assert no variant rows/objects are created and the job fails (no partial deliverable) | `ENCODE_INTEGRATION` |
| Plumbing without real FFmpeg | with a **mockable FFmpeg interface** injecting canned output files, run enqueue→process→DB so the queue/upload/persist plumbing is tested under `SKIP_INTEGRATION`-only (no FFmpeg) | `SKIP_INTEGRATION` only |
| Graceful shutdown mid-encode | start encoder, enqueue, SIGTERM mid-render → assert the in-flight job completes or returns to the queue (idempotent re-run safe), not lost | `ENCODE_INTEGRATION` |

### 9.3 Mocking FFmpeg vs real
- **Unit tests** never invoke FFmpeg — they test the **pure plan builder** + spec constants +
  key/path/row mapping with fixtures.
- The **FFmpeg invocation** sits behind a small interface (`encodeMaster(plan)`/`deriveVariant(...)`/
  `extractThumbnail(...)`) so it can be **mocked** (inject canned output files) for the
  `SKIP_INTEGRATION`-only plumbing test, and run **for real** under `ENCODE_INTEGRATION` against tiny
  valid seed media.
- **CI:** unit always; `SKIP_INTEGRATION` integration via a Redis + MinIO service (mirror Story 9);
  `ENCODE_INTEGRATION` only where FFmpeg is installed (a dedicated/optional CI lane, given encode
  cost). **[CONFIRM]** whether CI runs a tiny real encode at all or relies on local-only
  `ENCODE_INTEGRATION` (§13 Q30).

---

## 10. Security
- **S3 scoping.** The encoder host's credentials are scoped to **read** `events/{id}/submissions/.../
  media/*` + `events/{id}/artifacts/*` and **write** `events/{id}/final/*` only (`architecture.md`
  §7.2/§10.3). Private ACL on all `final/` objects; never public.
- **CDN signed URLs.** Final videos are delivered only via **signed** CDN URLs (24h expiry, rotating
  — `architecture.md` §7.2). No `final/` path is publicly listable or guessable-into. The signing
  key (`CDN_SIGNING_KEY`) lives only in host env (config), never in logs/payloads.
- **No honoree exposure in outputs/thumbnails (surprise integrity, `architecture.md` §10.1).** The
  encoder sends **no** communication (it only writes objects + rows). The **thumbnail** is a video
  frame served behind the **private** share token, **not** as a public OG image — the public
  share-preview image (`share/poster.jpg`) is honoree-name-free and is **Story 15's** concern, not
  this story's. Title cards render the honoree name **inside** the video (intended — it's the
  tribute), which is only ever viewed behind the private share token / download link. **Do not** put
  the honoree name in any public-facing artifact this story produces (it produces none).
- **Resource limits / abuse.** Source media is anonymous-contributor content already validated +
  quality-scored upstream (Story 6/9). Still: per-job render timeout + bounded scratch + child-kill
  on timeout (§5.13) prevent a crafted/pathological storyboard from pegging an encoder slot
  indefinitely. One bad event must not take down the pool (catch + fail the job, not the process —
  Story 9 §10).
- **No secrets/PII/bytes in logs.** Log ids + variant + durations + sizes; never presigned URLs,
  signing keys, media bytes, or honoree PII (mirror Story 9 §10/§11 redaction).
- **Payloads are ids-only** (§5.3) — queue contents carry no secrets.

---

## 11. Observability / Audit
**Metrics (per `architecture.md` §13 — workers: durations, retry counts, success/failure, queue
depth; §12 — encoder scales on queue depth).** Emit metric-shaped structured logs now; wire to
OpenTelemetry when the observability story lands.

| Metric | Dimension | Why |
|---|---|---|
| Encode duration | event, variant, outcome | the dominant cost/SLA driver (`architecture.md` §11.2 delivery SLA); per-variant breakdown spots a slow stage |
| `encoding` queue depth (waiting/active/failed) | — | **the autoscale signal** (`architecture.md` §12) + the §13 critical alert "queue depth > 100" context; encoder pool sizing |
| Per-variant success / failure count | variant, outcome | a spike in MASTER failures = bad input/plan; a REEL-only spike = crop/trim bug |
| Render attempt / retry count | event | flaky encoder host / OOM detection |
| Output size + duration distribution | variant | sanity (a 0-byte/0-duration output is a silent failure to alert on) |

**Structured logs** (Story 1 `logger`): job start (`eventId`, `jobId`, storyboard segment count),
per-variant start/finish (variant, duration, output size, dims), retries, failures (error class,
attempt n). Trace correlation: include `event_id` as a span/log attribute so an event traces
storyboard (Story 16) → encode (this story) → delivery (Story 15).

**Audit (`AuditLog`).** A render is a **system** action. **[CONFIRM]** (§13 Q31) whether to write an
`AuditLog` row on render completion/failure (`action = 'video.rendered'` / `'video.render_failed'`,
`actorId: null`, `metadata: { variants, durations, sizes }`). Recommendation: write a **system audit
row on completion and on terminal failure** — it gives the admin/SLA view a record and survives
right-to-delete de-identified (`architecture.md` §11.4). If an admin manually triggers a re-render
(§4), that action is **admin-attributed** (`actorId = admin`, `action = 'video.rerender_requested'`).

**Alerts (per `architecture.md` §13 / §11.1):** alert on **render failures** (a terminal
`encoding.assemble_ai_video` failure for an event whose `deliveryDate` is near) and on
**`encoding` queue depth sustained high** (autoscale lag) — `architecture.md` §13 lists "any event
with `delivery_date < NOW()+24h` and `status != DELIVERED`" as a paging alert; a stuck render is a
direct cause. This story **emits the signals**; the paging wiring is the observability story.

---

## 12. Definition of Done
- [ ] A **dedicated encoder process** (`src/workers/encoder.ts` + `npm run encoder`, separate
      Railway/Fly service) registers **only** the `encoding` Worker at concurrency 2, with its own
      Redis connection, FFmpeg available, and graceful shutdown that drains long in-flight encodes.
- [ ] `encoding.assemble_ai_video` job (event-keyed) builds a render plan from `storyboardJson` +
      `introText`/`outroText` + theme, encodes the **MASTER 1920×1080** with intro/outro title cards,
      transitions, per-clip captions, and **burned subtitles** (from the Story 16 `.srt`).
- [ ] Derives **REEL 1080×1920 ≤90s** (confirmed crop strategy), **YOUTUBE 1920×1080**, and
      **THUMBNAIL 1280×720 JPG** from the master; uploads each to its `final/` path; upserts one
      `FinalVideo` row per variant (`source = AI_GENERATED`).
- [ ] **No music** is added (hard constraint); audio is clip audio (+ narration only if Story 16
      provides audio); a unit guard test enforces the no-music invariant.
- [ ] **Idempotent**: job key `{eventId}::encoding.assemble_ai_video`; outputs keyed `(eventId,
      variant)` via a `@@unique` constraint + S3 fixed paths; re-render overwrites object + upserts
      row (no duplicates).
- [ ] **Partial-failure safe**: master gates the variants; a per-variant failure preserves completed
      variants; re-run completes only the missing ones.
- [ ] Retry/backoff (low attempts; lock duration > render timeout); per-job **render timeout** +
      scratch cleanup + child-kill on timeout.
- [ ] Schema: `FinalVideo` model + `VideoSource`/`VideoVariant` enums + `@@unique([eventId, variant])`
      + cascade; additive migration (coordinated with Story 14 for ownership).
- [ ] Config: `encoder` + `cdn` blocks (concurrency, ffmpeg path, render timeout, scratch dir,
      `CDN_DOMAIN`, `CDN_SIGNING_KEY`) in **both** `src/config/env.ts` and `src/config/index.ts`;
      `.env.example` updated; no `process.env` outside `src/config/`.
- [ ] Storage: encoder reads media + subtitle artifact, writes `final/` (scoped creds); CDN-signing
      config present for the Story 15 delivery seam.
- [ ] Trigger: assemble job enqueued when an `AI_ROUTED` event's artifact is approved/ready
      (confirmed signal); processor re-checks pre-conditions at run time.
- [ ] Unit tests (variant specs, plan mapping, idempotency, thumbnail params, no-music guard) +
      gated integration (`ENCODE_INTEGRATION` real encode → `FinalVideo` rows + probed S3 objects;
      `SKIP_INTEGRATION` mockable-FFmpeg plumbing) pass and skip cleanly.
- [ ] Seed: an `AI_ROUTED` event with an approved storyboard/artifacts + placeholder `FinalVideo`
      rows; a documented real-encode local recipe.
- [ ] Metrics-shaped logs (encode duration, queue depth, per-variant outcome, output size) emitted;
      no bytes/URLs/keys/PII in logs.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green. No TODO comments left.

---

## 13. Open Questions / Assumptions
| # | Item | Recommendation / default | Needs |
|---|---|---|---|
| 1 | **`storyboardJson` shape + clip trim semantics** (Story 16 not yet designed) | Use architecture §9.2 `StoryboardSchema`; trim video to `duration_sec`, hold last frame if shorter | **[CONFIRM]** against Story 16 |
| 2 | **Subtitle artifact location + alignment** (one event `.srt` aligned to the cut list, or per-clip the encoder offsets) | Story 16 emits an event `.srt` aligned to the assembled timeline; encoder burns it as-is | **[CONFIRM]** with Story 16 — real coupling |
| 3 | **Trigger: on admin-approval vs on generation-complete** | On `AiArtifact.adminApproved` (admin reviews/edits the plan first) | **[CONFIRM]** |
| 4 | **Narration: text-only vs synthesized TTS audio** | MVP 1 assumes **no** narration audio (script → subtitles/title cards only); master uses clip audio | **[CONFIRM]** with Story 16 |
| 5 | **Music / audio bed + `musicMood` realization** | **No music** (hard, out of scope); `musicMood` is a brief, may set transition/pacing defaults or be ignored; clip-audio loudness-normalized | **[CONFIRM]** loudness target; confirm no-music |
| 6 | **Caption (storyboard) vs subtitle (burn-in) layering; voice/text card visuals; transition default** | Caption = lower-third name; subtitle = transcript; default transition = short fade or cut | **[CONFIRM]** |
| 7 | **Missing/unresolved media policy** | Skip the entry with a log + adjust timing (don't fail the whole render for one missing clip); fail only if **no** resolvable media | **[CONFIRM]** skip vs fail |
| 8 | **Render-status surfacing** (derive from `FinalVideo` presence vs a status column/`RenderJob` table) + which `EventStatus` = "render complete" | Derive from `FinalVideo` rows + queue state for MVP 1; status flips to `IN_REVIEW`/`DELIVERED` owned by Story 15 | **[CONFIRM]** |
| 9 | **Admin "Re-render" button** (here vs Story 7/15) | Make re-render idempotent here; the button is thin — defer ownership to Story 7/15 | **[CONFIRM]** |
| 10 | **Visual-design specifics** (master pad/blur-fill for non-16:9, Ken-Burns for photos, **Reel crop = blurred-pad (B)**, title-card templates per theme) | Master scale-to-fit + themed blurred-pad; static photo holds (no Ken-Burns MVP 1); **Reel = blurred-pad** | **[CONFIRM]** — headline visual decisions |
| 11 | **Reuse the encoder for editor-upload variant re-encode** (architecture §6.5) | Parameterize the encoder by source later; out of scope here | **[CONFIRM]** Story 14 |
| 12 | **Encoder process name / start command / provider / autoscale rule** | `src/workers/encoder.ts` + `npm run encoder`; Railway/Fly; autoscale on `encoding` queue depth | **[CONFIRM]** |
| 13 | **Render timeout + shutdown grace + wrapper reuse** | 30-min render timeout; shutdown grace ≥ render timeout; reuse Story 9 child-process wrapper with longer defaults | **[CONFIRM]** |
| 14 | **Is the AI render path launch-blocking?** | **No** — `stories.md` ships MVP1 via the **manual path** (Story 15 after Story 14); AI auto-render (16/17) is a scaling improvement | **[CONFIRM]** — affects sequencing/priority |
| 15 | **Exact codec params** (H.264 profile/level, bitrate/CRF, AAC, keyframe/GOP, faststart, transition fidelity) | Sensible web/social defaults; transitions best-effort, not frame-accurate | **[CONFIRM]** |
| 16 | **YOUTUBE distinct from MASTER?** | A separate re-encode tuned for YouTube upload, even if visually identical; keep the variant for `features[]` extensibility | **[CONFIRM]** |
| 17 | **Reel ≤90s trim policy** | First-90s of the assembled timeline, ending on a clean boundary | **[CONFIRM]** |
| 18 | **Thumbnail frame-selection** | Deterministic time (intro+~2s), avoid black/subtitle frames; prefer a Story-16 candidate if present | **[CONFIRM]** |
| 19 | **BullMQ `attempts` for encodes** | 2–3 (encodes are costly); exponential backoff base ~30s | **[CONFIRM]** |
| 20 | **Partial-failure design** (single job skip-existing vs fan-out per variant) | Single idempotent job that skips already-produced variants | **[CONFIRM]** |
| 21 | **Minimum variant set for "deliverable"** (Story 15 gate) | All four for MVP 1 (read from package `features[]`) | **[CONFIRM]** with Story 15 |
| 22 | **Scratch sizing / download-vs-stream large source sets** | Download to bounded scratch, clean in `finally`; size host disk for the largest event | **[CONFIRM]** |
| 23 | **Max render time / SLA impact** | Bound by render timeout; feed encode duration into SLA tracking (`architecture.md` §11.2) | **[CONFIRM]** |
| 24 | **CDN-signing helper ownership** (here vs Story 15) | Config keys here; helper where first consumed (Story 15 / admin preview) | **[CONFIRM]** |
| 25 | **`FinalVideo` unique key** `(eventId, variant)` vs `(eventId, source, variant)` | `(eventId, variant)` — the routing gate is exclusive (one path per event) | **[CONFIRM]** with Story 14 |
| 26 | **`FinalVideo` `updatedAt`** | Do **not** add (architecture §7.1 omits it); keep original `createdAt` on upsert | **[CONFIRM]** |
| 27 | **Which of Story 14/17 owns the `FinalVideo` migration** | Whichever lands first; coordinate (they're parallel) | **[CONFIRM]** |
| 28 | **CDN config required vs optional in dev/test** | Optional in dev/test (no CDN locally), required in prod via superRefine (mirror Story 11) | **[CONFIRM]** |
| 29 | **Raw FFmpeg vs a filter-graph helper lib** | Raw FFmpeg via the child-process wrapper (no extra dep) | **[CONFIRM]** |
| 30 | **Does CI run a real encode?** | `ENCODE_INTEGRATION` real-encode local-only / a dedicated optional CI lane; main CI runs unit + mockable plumbing | **[CONFIRM]** |
| 31 | **Render `AuditLog` rows** | System row on completion + terminal failure; admin-attributed on manual re-render | **[CONFIRM]** |
