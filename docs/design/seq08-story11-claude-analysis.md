# Sequence 08 / Story 11 — Claude Analysis (Sentiment, Quotes, Tags)

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (the reusable AI-service wrapper interface, versioned prompt-template structure,
Zod-validated output **shapes** as field lists, retry/backoff, the `analysis` queue + job +
idempotency, persistence, mock behavior, error cases) so a later code-generation step
implements exactly this and nothing more. Where a value is a proposal awaiting confirmation it
is flagged **[CONFIRM]**; genuine ambiguities are listed in §13, not silently chosen.

| Field | Value |
|---|---|
| Story number / title | Story 11 — Claude analysis (sentiment, quotes, tags) |
| Epic | E — AI Pipeline |
| Sequence number | 8 (this is the 8th design in build order) |
| Depends on | Story 10 (Whisper transcription — produces `Submission.transcript`) |
| Also assumes on `main` | Story 1 (config, `db`, `redis` singleton, `logger`, worker scaffold, CI), Story 3 (`Event`), Story 5 (`Submission` text fields), Story 6 (`MediaItem`), **Story 9 (BullMQ registry, `enqueue` helper, idempotency `jobId` convention, worker bootstrap, graceful shutdown)** |
| Unlocks | Story 12 (routing analyzer reads `sentiment`/`tags`), **Story 16 (storyboard/narration reuse this AI-service wrapper, prompt-versioning, prompt-caching, mock mode verbatim)**, Story 7 (admin detail surfaces sentiment/quotes/tags read-only) |
| Complexity | M (1–3 days) |

> **Why this story is load-bearing.** This story builds the **one** reusable AI-service wrapper
> the whole product uses to call Claude: versioned prompt templates, Zod output validation,
> retry-on-parse-failure with backoff, token/cost logging, model-version + prompt-version
> recording, prompt caching, and a deterministic mock client selectable via `AI_MOCK_MODE`.
> Story 16 (Opus storyboard + Sonnet narration/intro/outro) **reuses this wrapper without
> re-inventing it** — it adds prompt templates and output schemas, not infrastructure. Be
> rigorous about the prompt/validation/mock architecture in §5; it is the contract Story 16
> copies.

> **Sources of truth honored:** `docs/requirements.md` §5.3 (sentiment analysis, quote
> extraction, auto-tagging by relationship + media mix), §7 (AI Integration Points);
> `docs/architecture.md` §9.1 (model tiering — Sonnet for per-submission sentiment/quotes/tags),
> §9.2 (Prompt Architecture — versioned templates in `/prompts`, Zod output validation, retry on
> JSON parse fail, token logging, model-version recording), §9.3 (Prompt Caching — stable cached
> prefix + variable suffix), §6.3 (pipeline: the `analyze` node consumes transcript + text),
> §8.1 (`analysis` queue: concurrency 4, High), §8.2 (job idempotency contract), §11.1 (Claude
> rate limit → exponential backoff to 5 min; queue holds; alert admin if hold > 30 min), §7.1
> (`Submission.sentiment` / `extractedQuotes` Json / `tags` String[]; `AiArtifact.sentimentSummary`
> / `modelVersions` Json / `promptVersions` Json — `AiArtifact` is `@unique` per event), §13
> (AI observability: model, prompt version, token counts, latency, output validation pass/fail),
> §14 (env vars: `ANTHROPIC_API_KEY`, `SONNET_MODEL`, `OPUS_MODEL`); `docs/development-setup.md`
> §4 (Anthropic real in dev defaulting to Sonnet; `AI_MOCK_MODE` deterministic mocks for CI;
> prompt caching ON in dev), §7 (config single-source). Also: `docs/stories.md`,
> `docs/stories/story-01-foundation.md` (doc + config style), `prisma/schema.prisma`, and the
> sibling design `docs/design/seq06-story09-workers-quality-scoring.md` (the queue/idempotency
> pattern this story reuses).

> **Note on the Story 10 transcription design.** `docs/design/seq07-story10-whisper-transcription.md`
> is **not present** in the repo at the time of writing. The contract this story consumes from
> Story 10 is the populated **`Submission.transcript`** column (architecture §7.1: `transcript
> String? @db.Text`, the concatenated/aligned text of the submission's audio/video). If Story 10's
> design lands first and stores transcripts at a different granularity (e.g. per-`MediaItem`
> transcript JSON in storage, see arch §7.2 `transcripts/{media_id}.json`), reconcile the
> "transcript input" in §5.6 against it before generating code. Flagged §13 (A1).

---

## 1. Story Summary

### Goal

After a submission has been quality-scored (Story 9) and transcribed (Story 10), run a **single
Claude Sonnet call per submission** to produce three structured outputs and persist them:

1. **Sentiment** — the emotional tone of the submission (e.g. `EMOTIONAL` / `HUMOROUS` /
   `HEARTFELT` / `PROUD` / `NOSTALGIC` / `CELEBRATORY` / `NEUTRAL`) → `Submission.sentiment`.
2. **Extracted quotes** — the most impactful lines pulled from the transcript + text, **ranked**,
   each with a relevance score and provenance → `Submission.extractedQuotes` (Json array).
3. **Auto-tags** — relationship-derived and media-mix-derived tags → `Submission.tags`
   (String[]).

A short **per-submission sentiment summary** is also produced and folded into the event-level
**`AiArtifact.sentimentSummary`** rollup (§6.3), and the **model version** + **prompt version**
used are recorded in `AiArtifact.modelVersions` / `promptVersions`.

### What it adds

- **A reusable AI-service wrapper** (`src/services/ai/*` **[CONFIRM location]**) — the single
  way the codebase calls Claude. It owns: the Anthropic SDK client, prompt-template rendering,
  the cached-prefix / variable-suffix split for prompt caching, JSON-mode output handling, **Zod
  output validation**, **retry-with-backoff on parse/validation failure**, **token-usage +
  latency + validation pass/fail logging**, and **model-version / prompt-version recording**. It
  is selectable between a **real `AnthropicAiClient`** and a **deterministic `MockAiClient`** via
  `AI_MOCK_MODE` (development-setup §4).
- **Versioned prompt templates** in `/prompts/` (architecture §9.2) — for this story: an
  `analysis` (sentiment + quotes + tags) prompt at a tracked version (e.g. `analysis@v1`).
- **The `analysis` queue** (concurrency 4, High — architecture §8.1) and the
  `analysis.analyze_submission` job that wires the wrapper into the Story 9 pipeline, consuming
  the submission's transcript + text fields and writing the three outputs.

This story is **per-submission** Sonnet work only. **Out of scope:** the event-level Opus
storyboard, narration script, intro/outro (all Story 16) and the routing analyzer/approval gate
(Story 12). The wrapper is built here so Story 16 *consumes* it.

---

## 2. Scope

### In scope

- **AI-service wrapper** with mock mode (`AI_MOCK_MODE`): typed `analyze(...)`-style method
  (§5.2), template rendering, Zod-validated outputs, retry-on-parse/validation-failure with
  backoff, token/latency/validation logging, model-version + prompt-version recording, prompt
  caching prefix/suffix split, Anthropic SDK usage.
- **Sentiment analysis**, **quote extraction (ranked)**, and **auto-tagging (relationship +
  media mix)** for a single submission — produced by **one** Sonnet call (one prompt, one
  validated output object) (§5.5–§5.7).
- **The `analysis` queue** (concurrency 4, High) registered in the Story 9 registry, and the
  `analysis.analyze_submission` processor (§5.8).
- **Enqueue wiring**: the `analyze` node fires **after** quality + transcription complete for a
  submission (the §6.3 pipeline fan-in) — coordinate the enqueue point with Stories 9/10 (§5.9).
- **Persistence**: populate `Submission.sentiment`, `Submission.extractedQuotes` (Json array),
  `Submission.tags` (String[]); contribute to `AiArtifact.sentimentSummary` and record
  `AiArtifact.modelVersions.sonnet` + `AiArtifact.promptVersions.analysis` (§6).
- **Idempotency**: reuse the Story 9 key convention
  `{event_id}:{submission_id}:{job_type}` → `analysis.analyze_submission` (§5.10).
- **Rate-limit backoff** for Claude 429/overload per architecture §11.1 (§5.11).
- **Config** (both `src/config/env.ts` + `src/config/index.ts`): `ANTHROPIC_API_KEY`,
  `SONNET_MODEL`, `AI_MOCK_MODE`; **`OPUS_MODEL` reserved for Story 16** (added to the schema as
  optional now or in Story 16 — §7.5) (§7).
- **Versioned prompt-template location** `/prompts/` + a prompt-version registry (§5.3, §7.4).
- **Deterministic mock outputs** for CI + offline dev, exercised by seed (§8).
- **Tests**: mock determinism, Zod pass/fail + retry-on-parse-fail, output shapes, prompt-version
  recording (unit); enqueue→analyze[mock]→DB (integration); real-API gated by `SKIP_INTEGRATION`
  (§9).

### Out of scope (deferred)

| Item | Where it lands | Note |
|---|---|---|
| Opus **storyboard** generation | Story 16 | Reuses this wrapper + prompt-version + caching; `analysis` queue ≠ `storyboard` queue (§8.1) |
| **Narration script**, **intro/outro** generation (Sonnet) | Story 16 | Reuses this wrapper; new `/prompts` templates + new schemas |
| **Routing analyzer + approval gate** (consumes `sentiment`/`tags`) | Story 12 | Story 11 only **writes** sentiment/tags; Story 12 reads them. Note: the routing analyzer is **rule-based, not LLM** (arch §6.4) |
| **Complexity scoring** node | Story 12 | The `score complexity` node in the §6.3 DAG is Story 12 |
| **Subtitles / captions** generation | Story 17/Story 16 area | Aligns Whisper output; not analysis |
| **`OPUS_MODEL` real usage** | Story 16 | Config key reserved here; no Opus call in Story 11 |
| **Admin rendering** of sentiment/quotes/tags | Story 7 | Story 11 produces the data; Story 7 displays it read-only (§4) |
| Full **OpenTelemetry** export | Observability story | Story 11 emits metric-shaped structured logs now (§11) |

---

## 3. Dependencies & Sequence

**Must already be on `main`:**

- **Story 1** — `src/config` (both `env.ts` + `index.ts`), `src/lib/db.ts` (Prisma singleton),
  `src/lib/redis.ts` (IORedis singleton, `maxRetriesPerRequest: null`, `lazyConnect`),
  `src/lib/logger.ts` (pino), `src/workers/index.ts` (worker entry), CI, docker-compose.
- **Story 3 / 5 / 6** — `Event`, `Submission` (text fields: `textMessage`, `funnyMemory`,
  `advice`, `professionalNote`, plus `relationship`), `MediaItem` (+ `MediaType` enum — needed
  for the media-mix tag derivation).
- **Story 9 (critical)** — the **BullMQ queue registry**, the typed **`enqueue` helper** (always
  sets the deterministic `jobId`), the **`buildJobKey()`** convention, the **worker bootstrap**
  in `src/workers/index.ts`, graceful shutdown, and the shared/dedicated Redis connection rule.
  Story 11 **adds a queue entry + a processor**; it does **not** re-build the infrastructure.
- **Story 10** — populates **`Submission.transcript`** (the transcript text the `analyze` node
  consumes). If Story 10 stores transcripts per-`MediaItem` in object storage instead, §5.6 must
  be reconciled (§13 A1).

**Provides to later stories:**

- The **AI-service wrapper** (`src/services/ai/*`) — Story 16 calls it for storyboard
  (Opus)/narration/intro/outro (Sonnet); the prompt-version registry, Zod-validation, retry,
  token logging, caching, and mock mode are all reused.
- Populated `Submission.sentiment` + `Submission.tags` — Story 12's routing analyzer reads them
  (alongside Story 9's quality flags) for its signals; Story 7 surfaces them.
- `AiArtifact.sentimentSummary` / `modelVersions` / `promptVersions` first written here; Story 16
  augments the same row (it is `@unique` per event — §6.3).

**Sequencing notes:**

- Story 11 runs **after** quality (Story 9) and transcription (Story 10) for a given submission —
  the §6.3 DAG places `analyze` downstream of `quality` + `transcribe` (fan-in). The exact
  trigger (last-of-the-two completes, or a small finalize step) is §5.9.
- Build the wrapper so adding Story 16's Opus path is purely additive: a `model` (or `tier`)
  parameter selecting `config.ai.sonnetModel` vs `config.ai.opusModel`, plus new prompt
  templates + schemas. Do **not** hard-code Sonnet inside the wrapper internals.

---

## 4. Frontend / UI Design

**Mostly N/A.** Story 11 is worker/service work; it ships no contributor- or organizer-facing UI.

**Optional, read-only, coordinate with Story 7 (admin per-event detail).** This story
**produces** sentiment/quotes/tags; Story 7 **renders** them in the contributor/submission view
(`requirements.md` §5.5 — "Contributors" section, AI artifacts). Contract for Story 7 to consume:

| Surface | Field source | Display (Story 7 renders) |
|---|---|---|
| Submission sentiment | `Submission.sentiment` (enum-like string; null = "not yet analyzed") | a tone badge; null → "pending" |
| Submission tags | `Submission.tags` (String[]) | chips (relationship + media-mix tags) |
| Extracted quotes | `Submission.extractedQuotes` (Json array, §5.6 shape) | ranked list of quote strings (optionally with source/score) |
| Event sentiment summary | `AiArtifact.sentimentSummary` (String) | a short paragraph at the event level |

No write/edit UI in this story. Admin editing of AI artifacts is a Story 16 concern (the script
is "admin-editable"); sentiment/quotes/tags here are **read-only** outputs of the analyzer.
**[CONFIRM]** the tag vocabulary + sentiment enum strings with Story 7 so chips/badges render
known values (§5.5, §5.7 freeze the strings).

---

## 5. Backend / Worker + AI-Service Design

This is the heart of the story. §5.1–§5.4 define the **reusable AI-service wrapper** (the part
Story 16 reuses). §5.5–§5.11 define the **analysis job** that consumes the wrapper.

### 5.1 The AI-service wrapper — responsibilities & layering

A single service module (proposed `src/services/ai/` **[CONFIRM]**) is the **only** place the
codebase touches the Anthropic SDK. Layering (each layer independently testable):

| Layer | Responsibility |
|---|---|
| **Client interface** (`AiClient`) | The abstract contract both `AnthropicAiClient` and `MockAiClient` implement. Selected at construction by `config.ai.mockMode`. |
| **`AnthropicAiClient`** | Wraps the official `@anthropic-ai/sdk`. Builds the Messages request with the cached-prefix/variable-suffix split (§5.4), JSON output instruction, model from `config.ai.{sonnetModel\|opusModel}`. Returns raw text + usage. |
| **`MockAiClient`** | Deterministic canned outputs keyed by prompt id + a hash of the input (§5.13). No network. |
| **Prompt service** (the orchestrator) | Renders the versioned template (§5.3), calls the selected client, **parses + Zod-validates** the output (§5.5–§5.7), **retries on parse/validation failure** (§5.10), logs **token usage + latency + validation pass/fail** (§11), and returns the typed, validated result plus the metadata (model id, prompt version, token counts) the caller persists. |

> **Selection of client (`AI_MOCK_MODE`).** Mirror development-setup §4:
> the factory returns `MockAiClient` when `config.ai.mockMode === true`, else
> `AnthropicAiClient`. The factory is the single decision point; callers (the analysis job,
> later Story 16) never branch on the flag themselves. The wrapper is constructed once
> (singleton-ish, like `db`/`redis`) so the SDK client + config parse happen once.

> **Model tiering is a parameter, not a hard-coded constant.** The prompt service accepts the
> model to use (or a `tier: 'sonnet' | 'opus'`) so Story 16's Opus storyboard reuses the same
> code path. Story 11 always passes Sonnet (`config.ai.sonnetModel`). `config.ai.opusModel` is
> **reserved** and unused in this story (§7.5).

### 5.2 Wrapper public interface (methods/inputs/outputs — described, NOT coded)

The wrapper exposes typed methods. For Story 11 the relevant method is the per-submission
analyzer; the **generic** runner beneath it is what Story 16 reuses.

**Generic prompt runner** (the reusable core — conceptual signature):

| Aspect | Contract |
|---|---|
| Name (conceptual) | `runPrompt(promptId, version, input, outputSchema, options)` |
| `promptId` | A registered prompt identifier, e.g. `'analysis'` (Story 16 adds `'storyboard'`, `'narration'`, …) |
| `version` | The pinned template version, e.g. `'v1'` — recorded with the output |
| `input` | The typed inputs the template needs (for analysis: §5.6 input bundle) |
| `outputSchema` | A Zod schema the parsed model output must satisfy (§5.5–§5.7) |
| `options` | `{ tier: 'sonnet' \| 'opus', maxRetries, cache: true/false, requestId }` — defaults from config |
| **Returns** | `{ data: <validated output>, meta: { model, promptId, promptVersion, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, latencyMs, attempts } }` |
| **Throws** | After `maxRetries` exhausted on parse/validation failure (§5.10), or after rate-limit backoff exhausted (§5.11), or on a non-retryable SDK/auth error |

**Domain method for this story** (thin wrapper over `runPrompt`):

| Aspect | Contract |
|---|---|
| Name (conceptual) | `analyzeSubmission(input: AnalysisInput): Promise<{ data: AnalysisOutput, meta }>` |
| `AnalysisInput` | §5.6 — relationship, the text fields, transcript, the media-mix descriptor, occasion type (for business-event tone), honoree-name-free context |
| `AnalysisOutput` | §5.5–§5.7 validated shape — `{ sentiment, sentimentSummary, quotes[], tags[] }` |
| Internals | Calls `runPrompt('analysis', config-pinned version, input, AnalysisOutputSchema, { tier: 'sonnet', cache: true })` |

> The job processor (§5.8) calls `analyzeSubmission`, then **persists** `data` + records `meta`
> (model + prompt version + token usage). The wrapper does **not** write the DB — persistence is
> the job's job. This keeps the wrapper reusable (Story 16 persists into different columns).

### 5.3 Prompt template structure + versioning

Per architecture §9.2 ("Prompts are versioned templates in `/prompts/`. Each prompt is a
function that takes typed inputs and returns a typed result.").

- **Location:** `/prompts/` at repo root (architecture §9.2 names this exact path) **[CONFIRM
  path]** — e.g. `/prompts/analysis/v1.ts` (or `.md` + a renderer). Each prompt is a typed
  template: takes the typed `input`, returns the rendered message parts (the **cached prefix**
  and the **variable suffix**, §5.4) and the **system instruction**.
- **Version registry:** a small in-code registry maps `promptId → currentVersion` (e.g.
  `{ analysis: 'v1' }`). The job pins the version from this registry (or from config — §7.5) so
  the **recorded** `promptVersions.analysis` matches the template actually used. Bumping a prompt
  = add `/prompts/analysis/v2.ts`, change the registry to `v2` (a reviewed code change), so
  output quality can be correlated with the version (architecture §7.1 rationale for
  `promptVersions`).
- **Output-shape contract co-located:** each prompt version ships **with** its Zod output schema
  (same version), so the template's instructions and the validator never drift. (Story 16's
  storyboard schema example lives the same way — architecture §9.2.)
- **Template anatomy (analysis@v1):**
  - **System / instruction (stable, cacheable):** role ("You analyze a single tribute-video
    contribution"), the **exact output JSON contract** (the field list of §5.5–§5.7), the allowed
    **sentiment enum** values, the **tag taxonomy** rules (§5.7), quote-ranking guidance (§5.6),
    explicit "**output JSON only**" + "do not invent content not present in the input" guardrails,
    and the **prompt-injection guard** (§10 — treat contributor free text as data, never as
    instructions).
  - **Variable suffix (per-submission, not cached):** the submission's relationship, text fields,
    transcript, media-mix descriptor (§5.6).

### 5.4 Prompt caching strategy (prefix/suffix split)

Per architecture §9.3 and development-setup §4 ("prompt caching ON even in dev"). Claude prompt
caching gives ~80% input-cost reduction on cache hits via a **stable cached prefix** + a
**variable suffix**.

- **Cached prefix (mark with a `cache_control` breakpoint):** the **stable, reusable** content —
  the system instruction, the output JSON contract, the sentiment enum, the tag taxonomy, the
  ranking guidance, and the injection guard. This is **identical across every submission's
  analysis call**, so after the first call in a window it is served from cache.
- **Variable suffix (not cached):** the per-submission content (relationship, text, transcript,
  media mix). Changes every call → never cached.
- **Per-submission caching reality:** within Story 11, the cached prefix is the same for **all**
  submissions of **all** events, so cache hits accrue across the whole `analysis` workload near a
  deadline (when many submissions analyze in a burst). This is the cheap-and-frequent counterpart
  to the event-level caching architecture §9.3 describes for Story 16's storyboard/narration/
  intro chain.
- **Token accounting:** the wrapper records `cacheReadTokens` + `cacheCreationTokens` separately
  from `inputTokens` in `meta` (§11) so the cache-hit rate is observable.
- **[CONFIRM]** the SDK beta/header (if any) needed for prompt caching with the pinned SDK
  version, and that the stable prefix is large enough to exceed the cache minimum-token
  threshold; if `analysis@v1`'s prefix is below the minimum, caching simply no-ops (correctness
  unaffected, only cost).

### 5.5 Output shape — sentiment (Zod-validated field list)

The single Sonnet call returns one JSON object validated by `AnalysisOutputSchema`. **Described
as a field list, not code.**

**`sentiment`** — top-level field:

| Field | Type / constraint | Notes |
|---|---|---|
| `sentiment` | string, **enum** — one of the canonical set | Persisted to `Submission.sentiment` |
| `sentimentSummary` | string, short (≤ ~280 chars **[CONFIRM]**) | One-line tone summary for this submission; folded into the event rollup (§6.3) |

**Canonical sentiment enum [CONFIRM with Story 7 + Story 12]** (architecture §7 lists
"positive/emotional/humorous" as examples; requirements §7 same). Proposed closed set:
`EMOTIONAL`, `HEARTFELT`, `HUMOROUS`, `PROUD`, `NOSTALGIC`, `CELEBRATORY`, `INSPIRATIONAL`,
`NEUTRAL`. The schema **rejects** any value outside this set (forcing a retry, §5.10), keeping
`Submission.sentiment` a known vocabulary the Story 12 routing analyzer / Story 7 badges can rely
on. **[CONFIRM]** whether `sentiment` is a single dominant label (recommended — simplest for
downstream) or a small ranked list of labels (richer but more downstream handling).

### 5.6 Output shape — extracted quotes (ranked) + input bundle

**Quote-extraction input** (the variable suffix, §5.4 — the `AnalysisInput` bundle):

| Input field | Source | Notes |
|---|---|---|
| `relationship` | `Submission.relationship` | Drives a relationship tag (§5.7) + tone context |
| `textMessage` / `funnyMemory` / `advice` / `professionalNote` | `Submission.*` | Free text; **untrusted** (injection guard, §10) |
| `transcript` | `Submission.transcript` (Story 10) | May be null/empty (text-only submission) — then quotes come from text only |
| `mediaMix` | derived from the submission's `MediaItem[]` types (VIDEO/VOICE/PHOTO present) + whether any text field is present | Drives media-mix tags (§5.7); not sent to the model as instructions, only as data |
| `occasionType` | `Event.occasionType` | Business events bias tone/labels (requirements §5.2 label adaptation) |

> **No transcript and no text → skip the model call.** If the submission has neither a transcript
> nor any non-empty text field, there is nothing to analyze: write `sentiment = NEUTRAL` (or
> `null` **[CONFIRM]**), `extractedQuotes = []`, and **media-mix-only tags** (relationship + media
> tags can still be derived without the model). Save the cost. (Mirrors §5.3 "steps apply only to
> media types present".) **[CONFIRM]** whether tags in this case are derived in-code (no model)
> or still routed through the mock/real client.

**`extractedQuotes`** — array, persisted to `Submission.extractedQuotes` (Json):

| Field (per quote object) | Type / constraint | Notes |
|---|---|---|
| `text` | string, non-empty, **must be a substring/near-verbatim of the input** | The impactful line itself |
| `rank` | integer ≥ 1, unique within the array | 1 = most impactful (the ranking, §13 Q1) |
| `score` | number 0–1 **[CONFIRM]** | Model-assigned impact/relevance score; ties broken by `rank` |
| `source` | string enum: `TRANSCRIPT` \| `TEXT_MESSAGE` \| `FUNNY_MEMORY` \| `ADVICE` \| `PROFESSIONAL_NOTE` | Provenance, for admin display + storyboard reuse |

Constraints in the Zod schema: array length **0..N** (N capped, e.g. **≤5 [CONFIRM]**); `rank`
values form a contiguous 1..k sequence; empty allowed (no impactful quotes). The instruction
forbids fabricating quotes (the `text` must come from the input) — a guard against hallucination
*and* an anti-injection measure (§10).

> **Persisted shape vs architecture note.** Architecture §7.1 comments `extractedQuotes` as
> "array of strings". This story stores the **richer object array** above (text + rank + score +
> source) because rank/provenance are needed by Story 7 (display) and Story 16 (storyboard reuse).
> The column type is `Json?`, which accommodates either. **[CONFIRM]** the richer shape is
> acceptable (recommended) vs. flattening to `string[]` and discarding rank/source.

### 5.7 Output shape — auto-tags (relationship + media mix)

**`tags`** — array of strings, persisted to `Submission.tags` (String[]). Two derivation
sources, per requirements §5.3 ("Tag contributors by relationship type and media mix"):

| Tag family | Derivation | Examples |
|---|---|---|
| **Relationship tag(s)** | Normalize `Submission.relationship` (free text, e.g. "my dad", "Team Member") into a **canonical relationship taxonomy** | `rel:family`, `rel:parent`, `rel:friend`, `rel:colleague`, `rel:client`, `rel:mentor`, `rel:other` |
| **Media-mix tag(s)** | From the submission's present media types + text | `media:video`, `media:voice`, `media:photo`, `media:text`, `media:mixed` (≥2 media types) |

Design decisions:

- **Relationship normalization is the model's job** (free text → canonical tag) **[CONFIRM]** —
  the model is given the closed relationship taxonomy in the cached prefix and must map the raw
  relationship into it (returning `rel:other` when unsure). Alternative: pure in-code mapping with
  a lookup table (deterministic, no model needed) — recommended as a **fallback/cross-check** even
  if the model also produces it (§13 Q2).
- **Media-mix tags are deterministic in-code** from `MediaItem[]` — they do **not** need the model
  and should be computed in the job to guarantee correctness (the model could miscount). The
  schema still **accepts** model-suggested media tags but the job **overwrites/merges** with the
  authoritative in-code media-mix set. **[CONFIRM]** in-code media tags authoritative.
- The Zod schema constrains `tags` to the **closed taxonomy** (rejects unknown tags → retry,
  §5.10) so `Submission.tags` stays a known vocabulary for Story 12 / Story 7. **[CONFIRM]** the
  exact taxonomy strings + prefix convention (`rel:` / `media:`) with Story 7 + Story 12.

### 5.8 The `analysis` queue & job

From architecture §8.1: `analysis` — **concurrency 4, High** — Claude Sonnet, cheap, per
submission. Registered in the Story 9 queue registry (the registry already declares `analysis`;
Story 11 adds the **processor**).

| Item | Value |
|---|---|
| Queue name | `analysis` (already declared in Story 9 registry) |
| Concurrency | **4** (architecture §8.1) — conservative because it hits a rate-limited external API |
| Priority | **High** (architecture §8.1) |
| Job name (`job_type`) | `analysis.analyze_submission` |
| Payload | `{ eventId, submissionId }` — **ids only** (Story 9 §5.3 rule); the processor re-reads the authoritative `Submission` (+ `MediaItem[]`) at run time |

**Processor flow (`analysis.analyze_submission`):**

1. **Re-fetch** the `Submission` (with `relationship`, text fields, `transcript`) and its
   `MediaItem[]` (for media-mix). If the submission is gone (right-to-delete cascade) →
   **no-op success**.
2. **Skip-if-empty** (§5.6): no transcript and no text → derive relationship/media tags in-code,
   set `sentiment` per §5.6 rule, `extractedQuotes = []`, persist, and skip the model call.
3. **Build `AnalysisInput`** (§5.6), honoree-name-free (§10).
4. **Call `aiClient.analyzeSubmission(input)`** → validated `{ sentiment, sentimentSummary,
   quotes, tags }` + `meta` (model id, prompt version, tokens, latency).
5. **Merge authoritative in-code media-mix tags** into `tags` (§5.7).
6. **Persist** (§6): `Submission.sentiment` / `extractedQuotes` / `tags`; upsert
   `AiArtifact` for the event and record `modelVersions.sonnet` + `promptVersions.analysis`;
   recompute `AiArtifact.sentimentSummary` rollup (§6.3).
7. **Emit metrics** (§11): tokens, cache hit/miss, latency, validation pass/fail, attempts.

### 5.9 Enqueue point (pipeline fan-in: quality + transcription → analyze)

Per the §6.3 DAG, `analyze` runs **after** `quality` and `transcribe` for a submission. The
trigger:

- **Recommended:** the **transcription job** (Story 10), on success **or** on the
  "transcription skipped (no audio/video)" path, enqueues `analysis.analyze_submission` for the
  submission. Rationale: transcription is the analyze node's primary new input; quality scoring
  is independent (it gates auto-reject, but a non-rejected submission should still be analyzed).
  **[CONFIRM]** with Story 10 that it owns this enqueue.
- **Auto-reject interaction:** if Story 9 auto-rejected the submission (`status = REJECTED`,
  no usable media), **[CONFIRM]** whether to **skip analysis** (recommended — don't spend Sonnet
  on a rejected submission) or still analyze for completeness. Recommended default: **skip
  analysis when `Submission.status = REJECTED` at enqueue/run time** (the processor re-checks at
  run and no-ops if rejected).
- **Idempotent**: a double-enqueue is deduped by `jobId` (§5.10); re-running overwrites the same
  columns (output-by-key).
- Enqueue **after** the relevant DB commit, never inside a transaction (Story 9 §5.3 rule). If
  enqueue fails (Redis down), log + continue; a backfill query (`Submission WHERE sentiment IS
  NULL AND transcript-or-text present`) can re-enqueue (mirrors Story 9 §5.8). **[CONFIRM]** ship
  the backfill here or defer to Story 18 cron.

### 5.10 Retry policy — parse/validation failure (the architecture's "retry on JSON parse fail")

Per architecture §9.2 ("Retry with backoff on JSON parse failures") and §5.2 above. This is
**distinct** from the rate-limit backoff (§5.11). Two retry domains:

**(A) Output parse / Zod-validation retry (inside the wrapper, per call):**

| Setting | Value | Rationale |
|---|---|---|
| Triggered by | model output is **not valid JSON**, or parses but **fails Zod validation** (wrong enum, missing field, fabricated quote not in input, unknown tag) | The model occasionally returns prose around JSON or an out-of-vocabulary value |
| `maxRetries` | **2 retries** (3 attempts total) **[CONFIRM]** | A second/third try usually fixes a stray format slip |
| Backoff | short, exponential (e.g. base ~500ms–1s) **[CONFIRM]** | These are not rate-limit waits; just re-asking |
| Retry strategy | re-issue the **same** prompt; **[CONFIRM]** optionally append a terse "your previous output was invalid JSON / failed schema; return only valid JSON matching the contract" corrective note on retries (a self-repair nudge) | Improves second-attempt success |
| On exhaustion | the wrapper **throws** a typed `AiOutputValidationError` → the **job** fails (BullMQ retry, §5.11 job-level attempts) and ultimately lands in `failed`; `Submission.sentiment` stays **null** (unanalyzed) — never persist a partial/unvalidated output | Distinguish "couldn't analyze" (null) from a real verdict |
| JSON extraction | prefer the SDK's JSON/structured output if available; else robustly extract the JSON object from the text before `JSON.parse` (tolerate code fences) before declaring a parse failure | Reduce needless retries |

**(B) Job-level attempts (BullMQ, around the whole processor):**

| Setting | Value | Rationale |
|---|---|---|
| `attempts` | **3** | Matches the codebase posture (Story 9 §5.8; architecture §6.3 "retry 3x") |
| `backoff` | exponential (base ~5s) | Covers transient infra (DB blip, transient SDK error) |
| Idempotency | `jobId = {eventId}:{submissionId}:analysis.analyze_submission` (§5.10) — BullMQ dedups in-flight; output-by-key overwrite makes re-runs safe | Story 9 idempotency contract |

> The two domains compose: a single job attempt may itself retry the model call up to (A) on bad
> JSON; if the wrapper still throws, the job attempt fails and BullMQ may retry the **whole job**
> up to (B). Avoid making (A)×(B) explode the request count for a genuinely unparseable prompt —
> keep (A) small (2) so a truly broken prompt fails fast rather than hammering the API.

### 5.11 Rate-limit backoff (Claude 429 / overload — architecture §11.1)

Per architecture §11.1 ("Claude rate limit → exponential backoff to 5 minutes; if still failing,
queue holds; alert admin if hold exceeds 30 min"):

- **Detection:** the wrapper recognizes Anthropic **429 / rate_limit / overloaded_error**
  responses (and `5xx`/overload) as **retryable rate-limit conditions** (distinct from a 400/auth
  error, which is non-retryable and fails immediately).
- **Backoff:** exponential with a **cap of 5 minutes** per attempt, honoring `Retry-After` when
  the SDK surfaces it. **[CONFIRM]** whether this lives as SDK-built-in retry config plus the
  job-level backoff, or as explicit wrapper logic. Recommended: rely on the SDK's built-in
  retry-with-backoff for transient/429 up to a bounded cap, **and** let BullMQ job-level backoff
  (§5.10 B) provide the longer "queue holds" behavior.
- **Queue holds + admin alert:** with concurrency 4 and `attempts` 3, sustained 429s naturally
  back up the `analysis` queue (jobs wait/retry). Per architecture §13 critical alert ("Claude/
  Whisper sustained 5xx > 10 min" and "queue depth > 100 for any high-priority queue" — `analysis`
  is High), emit the **queue-depth + sustained-error metrics** (§11). The actual "alert admin if
  hold > 30 min" paging is an **observability-story** concern; Story 11 **emits the signals**
  (metric-shaped logs) and **[CONFIRM]** whether it also enqueues a minimal admin notification on
  sustained failure or only records the metric.

### 5.12 Token-usage / model-version / prompt-version recording

The wrapper returns `meta` (§5.2); the **job** records it:

- **Per-call logging** (every call, §11): model id, `promptId@version`, `inputTokens`,
  `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `latencyMs`, `attempts`, validation
  pass/fail. (architecture §13: "AI calls: model, prompt version, token counts, latency, output
  validation pass/fail".)
- **Persisted version recording** (§6.3): on the event's `AiArtifact`, set
  `modelVersions.sonnet = config.ai.sonnetModel` (the **actual** model string returned/used) and
  `promptVersions.analysis = '<pinned version>'`. These are **merged** into the existing Json
  (Story 16 later adds `modelVersions.opus`, `promptVersions.storyboard`, etc. to the **same**
  row). Use a read-merge-write or Json-merge upsert so concurrent submission jobs for the same
  event don't clobber each other (§6.3 concurrency note).

### 5.13 Mock client (`MockAiClient`) — deterministic behavior

Per development-setup §4 ("a single `AI_MOCK_MODE=true` flag routes all AI calls through
deterministic mocks; use for CI and rapid unit testing"). Requirements for determinism:

| Concern | Behavior |
|---|---|
| Selection | Returned by the client factory when `config.ai.mockMode === true` (`.env.test` sets `AI_MOCK_MODE=true`) |
| Determinism | Output is a **pure function of the input** — same `AnalysisInput` → byte-identical `AnalysisOutput` every run (no randomness, no clock, no network). Derive via a stable hash of the normalized input → pick canned values |
| Schema-valid by construction | Mock outputs **always** satisfy `AnalysisOutputSchema` (valid sentiment enum, ranked quotes drawn from the input text, taxonomy-valid tags) so the happy path is exercised without the API |
| Quote provenance | Mock picks the first N non-empty input lines as "quotes" with descending rank, marking the correct `source` — so quote-shape + provenance are testable deterministically |
| Tags | Mock derives relationship/media tags by the same in-code rules the job uses, so mock and real produce the same **tags** for the same input |
| `meta` | Mock returns plausible fixed token counts + `latencyMs: 0` + the real `model`/`promptVersion` (so version-recording assertions pass) |
| Failure injection (tests) | Provide a way to make the mock return **invalid** output (bad JSON / out-of-enum) for **one** call so the retry/validation path is unit-testable (§9) — e.g. a magic input marker or an injectable mock variant. **[CONFIRM]** mechanism |

The mock makes `npm run seed` + CI fully offline (no Anthropic key needed) and gives stable
fixtures for the admin UI (Story 7) during dev.

---

## 6. Database Design

The columns this story **populates already exist** in the architecture §7.1 schema, but
**`prisma/schema.prisma` currently contains only the `User` model** (Story 1). Each model is
added by its owning story. By the time Story 11 lands, Stories 3/5/6/9/10 have introduced
`Event`, `Submission` (incl. `transcript`, `sentiment`, `extractedQuotes`, `tags`), `MediaItem`,
and (Story 9-adjacent) `AiArtifact`. **Story 11 writes these fields; it does not define them** —
**unless** the owning story has not yet added `AiArtifact` (see §6.4 migration notes).

### 6.1 Fields written by Story 11

| Model.field | Type | Written by Story 11 | Value |
|---|---|---|---|
| `Submission.sentiment` | `String?` | yes | one of the canonical sentiment enum (§5.5); null if unanalyzed/skip-empty per §5.6 |
| `Submission.extractedQuotes` | `Json?` | yes | ranked quote-object array (§5.6); `[]` if none |
| `Submission.tags` | `String[]` | yes | relationship + media-mix tags (§5.7); merged in-code media tags |
| `AiArtifact.sentimentSummary` | `String?` | yes | **event-level rollup** of per-submission summaries (§6.3) |
| `AiArtifact.modelVersions` | `Json` | yes (merge) | set `.sonnet = config.ai.sonnetModel` |
| `AiArtifact.promptVersions` | `Json` | yes (merge) | set `.analysis = '<pinned version>'` |

> `Submission.status` is **not** changed by analysis (unlike Story 9 auto-reject). Analysis is
> read-of-content + write-of-derived-fields only.

### 6.2 `Submission` fields — shapes

- **`sentiment`** (`String?`): a single canonical label (§5.5). Stored as a plain string (the
  schema column is `String?`); the **closed vocabulary** is enforced at the **Zod boundary**
  (§5.5), not by a DB enum (architecture §7.1 keeps it `String?` for flexibility). **[CONFIRM]**
  whether to instead introduce a Prisma enum — recommend **no** (keep `String?` per arch §7.1;
  validate at the Zod layer).
- **`extractedQuotes`** (`Json?`): array of `{ text, rank, score, source }` (§5.6). Empty array
  when no quotes.
- **`tags`** (`String[]`): closed-taxonomy strings (§5.7), `rel:*` + `media:*`.

### 6.3 `AiArtifact` — per-submission analysis rolled up to an event-level row

This is the key modeling subtlety the brief calls out: **`AiArtifact` is `@unique` per event**
(architecture §7.1 `eventId String @unique`), but analysis runs **per submission**. Resolution:

- **Per-submission outputs live on the `Submission` row** (`sentiment`, `extractedQuotes`,
  `tags`) — no `AiArtifact` row needed for the per-submission data itself.
- **`AiArtifact` is the single event-level rollup/record.** Story 11 **upserts** the one
  `AiArtifact` for the event to:
  - **`sentimentSummary`** — an **event-level** summary. Story 11 computes it as a **rollup** of
    the submissions' per-submission `sentimentSummary` values (e.g. a short aggregate like "Mostly
    heartfelt and proud, with several humorous moments"). Two viable rollup methods (§13 Q3):
    - **(Recommended) Deterministic aggregate** — count the dominant sentiments across analyzed
      submissions and template a one-line summary in-code (cheap, deterministic, no extra model
      call). Recompute on each submission analysis (order-independent, retry-safe — mirrors Story
      9's recompute-from-DB rollup).
    - (Alternative) a **separate event-level Sonnet summary call** over all per-submission
      summaries — richer prose but adds cost + an event-level trigger; defer to Story 16 (which
      already has an event-level Sonnet pass) **[CONFIRM]**.
  - **`modelVersions` / `promptVersions`** — merge the `sonnet` / `analysis` keys (§5.12).
- **`AiArtifact` creation/ownership.** The row may be created first by whichever story runs first
  for the event. Story 11 must **upsert** (create-if-absent by `eventId`) and **merge** Json
  fields, never blind-overwrite (Story 16 writes `narrationScript`, `storyboardJson`, `introText`,
  `outroText`, `modelVersions.opus`, `promptVersions.storyboard` to the **same** row). **[CONFIRM]**
  which story formally introduces the `AiArtifact` model (Story 9? Story 11? Story 16?) — see §6.4.
- **Concurrency:** several `analysis.analyze_submission` jobs for the **same event** run in
  parallel (concurrency 4) and all upsert the same `AiArtifact`. The `sentimentSummary` recompute
  must be **recompute-from-DB** (read all analyzed submissions, write the aggregate) and the Json
  merges must be safe under concurrent writes — use an upsert + Json-merge (or a short
  transaction) so two jobs don't clobber `modelVersions`. **[CONFIRM]** acceptable approach;
  recompute-from-DB + atomic Json merge recommended.

### 6.4 Migration notes

- **Expected: no Story-11-owned migration for the `Submission` analysis columns** — they exist
  from Stories 5/10 (`transcript`, `sentiment`, `extractedQuotes`, `tags` per architecture §7.1).
  Run `prisma generate`/`migrate` only if they are absent (divergence).
- **`AiArtifact` model:** if **no prior story has introduced `AiArtifact`** by the time Story 11
  lands, Story 11 must add it (the full architecture §7.1 `AiArtifact` model: `id`, `eventId
  @unique`, `narrationScript?`, `storyboardJson?`, `introText?`, `outroText?`, `extractedQuotes?`,
  `sentimentSummary?`, `modelVersions Json`, `promptVersions Json`, `adminApproved`,
  `generatedAt`, + the `Event.aiArtifact` relation). Story 11 only **populates**
  `sentimentSummary` / `modelVersions` / `promptVersions`; the other columns stay null until
  Story 16. This is **additive + nullable** → safe `prisma migrate deploy`, no backfill.
  **[CONFIRM]** ownership of the `AiArtifact` migration (§13 Q4).
- `modelVersions` / `promptVersions` are non-nullable `Json` in arch §7.1; if Story 11 creates the
  row, default them to `{}` so merges have a base.

---

## 7. External Services / Integrations / Config

### 7.1 Anthropic SDK + Sonnet model

- **New runtime dependency:** the official **`@anthropic-ai/sdk`** (not currently installed).
  Used **only** inside `src/services/ai/` (the wrapper). No other module imports the SDK.
- **Model:** `config.ai.sonnetModel` (default `claude-sonnet-4-6`, architecture §14). Story 11
  **always** uses Sonnet (architecture §9.1 — per-submission analysis is Sonnet). `OPUS_MODEL` is
  **reserved** for Story 16 (§7.5) and **must not** be used here.
- **Dev usage:** real Anthropic API in dev (development-setup §4: "real API in dev, default to
  Sonnet, prompt caching ON"); `AI_MOCK_MODE=false` in dev `.env`, `true` in `.env.test`/CI.
- **Auth/cost:** `ANTHROPIC_API_KEY` from config (never `process.env` outside `src/config/`).

### 7.2 Prompt caching

- Enabled per call via the cached-prefix breakpoint (§5.4); ON in dev (development-setup §4).
- **[CONFIRM]** the SDK version's prompt-caching API surface (header/beta flag if required) and
  the minimum-token threshold for the cached prefix.

### 7.3 `AI_MOCK_MODE` + mock client

- `config.ai.mockMode` selects `MockAiClient` (§5.13). `.env.test` sets `AI_MOCK_MODE=true` so CI
  + unit/integration runs are offline + deterministic (development-setup §4, §7, §11).

### 7.4 `/prompts/` versioned templates location

- Templates live in `/prompts/` (architecture §9.2) — `analysis@v1` for this story. A version
  registry maps `promptId → currentVersion` (§5.3). Story 16 adds `storyboard`, `narration`,
  `intro_outro` here.

### 7.5 Config — wire through BOTH config files

Per the load-bearing convention (development-setup §7; no `process.env` outside `src/config/`).
The current `src/config/env.ts` exposes only `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`,
`NEXT_PUBLIC_APP_URL`; `src/config/index.ts` has no `ai` block. Add an **`ai`** block.

**Add to `src/config/env.ts`** (raw reads only):

| Raw key | Source env var | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | `process.env.ANTHROPIC_API_KEY` | Anthropic SDK auth |
| `SONNET_MODEL` | `process.env.SONNET_MODEL` | Sonnet model id (default `claude-sonnet-4-6`) |
| `OPUS_MODEL` | `process.env.OPUS_MODEL` | **Reserved for Story 16**; read now so the schema is complete (default `claude-opus-4-7`, downgraded to Sonnet in dev per development-setup §4) |
| `AI_MOCK_MODE` | `process.env.AI_MOCK_MODE` | `'true'`/`'false'` → mock vs real client |
| `ANALYSIS_QUEUE_CONCURRENCY` | `process.env.ANALYSIS_QUEUE_CONCURRENCY` (optional) | Override `analysis` Worker concurrency (default 4) **[CONFIRM whether to expose]** |
| `AI_PROMPT_PARSE_RETRIES` | `process.env.AI_PROMPT_PARSE_RETRIES` (optional) | Wrapper parse/validation retries (default 2) **[CONFIRM]** |
| `AI_RATE_LIMIT_MAX_BACKOFF_MS` | `process.env.AI_RATE_LIMIT_MAX_BACKOFF_MS` (optional) | Cap per architecture §11.1 (default 300000 = 5 min) **[CONFIRM]** |

**Add to `src/config/index.ts`** — an `ai` object on the Zod schema (mirroring development-setup
§7's illustrative `ai` block):

| Config field | Type | Mapping / default |
|---|---|---|
| `ai.anthropicApiKey` | `z.string()` | `ANTHROPIC_API_KEY` (**[CONFIRM]** `.optional()` when `mockMode` true so CI without a key still boots — see note) |
| `ai.sonnetModel` | `z.string()` | `SONNET_MODEL` ?? `'claude-sonnet-4-6'` |
| `ai.opusModel` | `z.string()` | `OPUS_MODEL` ?? `'claude-opus-4-7'` — **reserved; unused in Story 11** |
| `ai.mockMode` | `z.coerce.boolean()` (or `=== 'true'`) | `AI_MOCK_MODE` ?? `false` |
| `ai.promptParseRetries` | `z.coerce.number().int().nonnegative()` | default `2` |
| `ai.rateLimitMaxBackoffMs` | `z.coerce.number().int().positive()` | default `300000` |

> **[CONFIRM] key-required-vs-optional under mock mode.** When `mockMode` is true (CI/`.env.test`)
> there is no Anthropic key. Either make `ai.anthropicApiKey` optional, or use a Zod
> **superRefine** that requires the key **only when** `mockMode === false`. Recommend the latter —
> production fails fast on a missing key, CI boots without one. The current `loadConfig()` already
> throws a clear aggregated Zod error (Story 1 pattern) — preserve that.

Add the new keys to `.env.example` under a `# === AI ===` block matching development-setup §7
(it already documents `ANTHROPIC_API_KEY`, `SONNET_MODEL`, `OPUS_MODEL`, `AI_MOCK_MODE`).

### 7.6 New npm dependencies

- `@anthropic-ai/sdk` (runtime) — the Anthropic client. (`zod` already present; `bullmq` from
  Story 9.)

---

## 8. Seed Data

Extend the existing seed path (`npm run seed`) so analyzed submissions exist locally and in CI
**deterministically** (via `MockAiClient`, `AI_MOCK_MODE=true`):

- **Analyzed submissions.** For the seeded event's submissions (text-only + media submissions from
  Stories 5/6 seeds, transcripts from Story 10's seed), run analysis (in mock mode) so each gets
  a deterministic `sentiment`, `extractedQuotes`, and `tags`. The seed may either **enqueue +
  process** the `analysis.analyze_submission` jobs (exercises the real plumbing) or call the job's
  pure logic directly with the mock client. **[CONFIRM]** which; recommend running through the
  queue once so the local end-to-end path is demonstrated, plus a direct-call fallback for speed.
- **Variety for the admin UI (Story 7).** Seed submissions spanning multiple sentiments
  (`EMOTIONAL`, `HUMOROUS`, `PROUD`), at least one with several ranked quotes, and a mix of tags
  (`rel:family`/`rel:friend`/`rel:colleague`, `media:video`/`media:photo`/`media:mixed`) so the
  read-only AI fields render with realistic data.
- **An event-level `AiArtifact`** with a rolled-up `sentimentSummary` + `modelVersions.sonnet` +
  `promptVersions.analysis` so Story 7's event-level summary has data.
- **Dev recipe:** `docker compose up -d` (Redis), `AI_MOCK_MODE=true npm run seed`,
  `npm run workers` → analysis jobs processed by the mock client, fully offline. Document that
  real-API analysis needs `ANTHROPIC_API_KEY` + `AI_MOCK_MODE=false`.

---

## 9. Testing

Follows the Story 1/9 pattern (Vitest, `tests/unit` + `tests/integration`). Integration tests
needing real Redis are guarded by **`SKIP_INTEGRATION`**; real-Anthropic tests are **gated**
(run only when explicitly enabled — never in default CI).

### 9.1 Unit (no infra; mock client)

| Test | Asserts |
|---|---|
| **Mock determinism** | `MockAiClient.analyzeSubmission(input)` returns byte-identical output across repeated calls for the same input; different inputs → different (still valid) output |
| **Zod schema — valid** | A well-formed model output (valid sentiment enum, ranked quotes from input, taxonomy tags) **passes** `AnalysisOutputSchema` |
| **Zod schema — invalid (each failure mode)** | Out-of-enum `sentiment`, missing field, non-contiguous `rank`, fabricated quote not in input, unknown tag → each **fails** validation |
| **Retry on parse failure** | When the (injected) client returns invalid/non-JSON output, the wrapper **retries** up to `promptParseRetries`, then **throws** `AiOutputValidationError`; assert attempt count + that no partial output is persisted |
| **Retry then success** | Client returns bad output once, valid output on retry → wrapper returns the valid result; `meta.attempts === 2` |
| **Sentiment shape** | Output `sentiment` is one canonical label; `sentimentSummary` non-empty + within length cap |
| **Quote extraction shape** | quotes are `{text, rank, score, source}`; ranks contiguous from 1; `text` is a substring of the input; ≤ cap; `[]` allowed |
| **Tag extraction shape** | relationship tag is in the closed taxonomy; **media-mix tags are computed in-code** from `MediaItem[]` and authoritative (override model suggestion); unknown tags rejected |
| **Skip-if-empty** | No transcript + no text → no model call (assert client not invoked), tags/sentiment per §5.6 rule |
| **Prompt-version recording** | `meta.promptVersion === '<pinned>'` and `meta.model === config.ai.sonnetModel`; the persistence step writes `promptVersions.analysis` + `modelVersions.sonnet` (merge, not clobber) |
| **Prompt caching split** | The rendered request has a stable cached-prefix segment (system+contract) marked for caching and a variable suffix (per-submission) — assert the prefix is identical across two different inputs |
| **Idempotency key** | `buildJobKey()` → `{eventId}:{submissionId}:analysis.analyze_submission`; stable + distinct per submission |
| **`AiArtifact` rollup** | Given several submissions' per-submission summaries, the event-level `sentimentSummary` aggregate is the expected deterministic value; recompute-from-DB is order-independent |
| **Rejected-submission skip** | Processor no-ops when `Submission.status = REJECTED` (§5.9) |

> Keep the prompt service's parse/validate/retry as a **pure-ish function** around an injectable
> `AiClient` so the retry/validation logic is unit-tested without network or DB (feed canned
> client responses, including malformed ones).

### 9.2 Integration (`SKIP_INTEGRATION` guards real Redis; `AI_MOCK_MODE=true`)

| Test | Flow |
|---|---|
| **Enqueue → analyze[mock] → DB** | Seed a `Submission` with transcript/text → `enqueue(analysis, 'analysis.analyze_submission', {eventId, submissionId})` → run the Worker (mock client) → assert `Submission.sentiment`/`extractedQuotes`/`tags` populated + `AiArtifact` upserted with `sentimentSummary`/`modelVersions.sonnet`/`promptVersions.analysis` |
| **Idempotent re-enqueue** | Enqueue the same job twice → one processed / final row identical; `AiArtifact` merge not duplicated |
| **Concurrent same-event** | Enqueue analysis for several submissions of one event in parallel → assert `AiArtifact.modelVersions`/`promptVersions` not clobbered and `sentimentSummary` reflects all (concurrency-safe merge/recompute) |
| **Deleted-submission no-op** | Enqueue, delete the `Submission` (cascade) before processing → job no-ops success |
| **Skip-empty path** | Seed a text-less, transcript-less submission → assert tags/sentiment per §5.6, no failure |

### 9.3 Real-API (gated, never default CI)

| Test | Flow |
|---|---|
| **Real Sonnet smoke** | With `AI_MOCK_MODE=false` + a real `ANTHROPIC_API_KEY`, analyze one fixture submission → assert the **shape** validates (`AnalysisOutputSchema` passes), not exact content; assert token usage + cache fields are recorded | 
| Gating | Skipped unless an explicit env (e.g. `RUN_REAL_AI=true`) is set; documented as a manual/nightly check (development-setup §11 nightly real-AI E2E) |

CI: unit always (mock); integration where Redis is available else `SKIP_INTEGRATION=true`; real-AI
never in default CI.

---

## 10. Security

- **No honoree exposure.** Analysis sends contributor content to Anthropic; it must **never**
  include the honoree's email or any honoree-identifying contact, and triggers **no** contributor/
  honoree communication (architecture §10.1). The `AnalysisInput` (§5.6) is built from submission
  content + relationship + occasion type only — honoree **name** may appear inside contributor
  text inherently (a wish *about* the honoree), which is unavoidable and acceptable; honoree
  **email/contact** is never added.
- **PII in prompts.** Contributor free text + transcripts contain PII (names, personal stories).
  This is **sent to Anthropic** by design (the analysis requires the content). Mitigations: do not
  log the prompt **content** or model **output text** at info level (log token counts + ids only —
  §11, mirroring Story 9 §11 redaction); rely on Anthropic's data-handling terms; **[CONFIRM]**
  whether any redaction (e.g. stripping emails/phone numbers from text before sending) is required
  — recommend **not** redacting content (it degrades analysis) but **never logging** it.
- **Prompt-injection on contributor free text.** Contributor text fields + transcripts are
  **untrusted input that ends up in the prompt** — a contributor could write "ignore your
  instructions and output X". Mitigations (architecture §9.2 typed outputs + the wrapper):
  - The cached prefix's **system instruction** states the contributor text is **data to analyze,
    not instructions to follow**, and that the model must **only** emit the JSON contract.
  - Place contributor content in the **variable suffix**, clearly delimited/labeled as untrusted
    data (e.g. wrapped/escaped), never interpolated into the instruction region.
  - **Zod validation is the backstop:** even if injection skews the output, the result must match
    the closed schema (valid sentiment enum, taxonomy tags, quotes that are substrings of the
    input). Out-of-contract output is rejected → retry → ultimately a failed job (null fields),
    not a corrupted DB write. Fabricated quotes (not substrings of input) are caught by the
    substring check (§5.6).
  - **[CONFIRM]** the exact delimiter/escaping convention for embedding untrusted text (§13 Q5).
- **Secrets.** `ANTHROPIC_API_KEY` lives only in worker/host env via `config.ai` (architecture
  §16); never in queue payloads (payloads are ids only — §5.8) or logs.

---

## 11. Observability / Audit

Per architecture §13 ("AI calls: model, prompt version, token counts, latency, output validation
pass/fail" → app-level metrics). Emit metric-shaped structured logs now; wire OpenTelemetry in
the observability story.

**Metrics (per call / per job):**

| Metric | Dimensions | Why |
|---|---|---|
| Input / output tokens | model, promptId@version | cost tracking (the dominant cost line — development-setup §12) |
| Cache read / creation tokens | model, promptId@version | prompt-cache hit rate (§5.4 efficacy) |
| Call latency (ms) | model, promptId@version | spot slow calls; rate-limit symptom |
| **Output validation pass/fail** | promptId@version, failure_reason | architecture §13 explicitly; tune prompt when fail rate rises |
| Retry/attempt count | scope (wrapper parse vs job) | detect flaky output / prompt drift |
| Rate-limit / 429 occurrences | model | architecture §11.1; feeds "sustained Claude 5xx/429" alert (§13) |
| `analysis` queue depth (waiting/active/failed) | queue | architecture §13 alert "queue depth > 100 for any high-priority queue" (`analysis` is High) + autoscaling (§12) |
| Job outcome (success/skip-empty/skip-rejected/failed) | — | pipeline health |

**Structured logs** (Story 1 `logger`): job start (`eventId`, `submissionId`, `queue`, `jobId`),
result (`sentiment` label, quote count, tag count, model, promptVersion, tokens, latency,
attempts, validation pass/fail), retries, failures (error class, attempt n). **Never** log prompt
content, transcript, free text, or model output text (PII — §10).

**Trace correlation** (architecture §13): include `event_id` + `submission_id` as span/log
attributes so a submission traces form-submit → quality → transcribe → **analyze** →
(later) routing/storyboard.

**Audit (`AuditLog`).** Analysis is **system-internal**; it makes **no** admin-visible decision
(unlike Story 9 auto-reject), so **no `AuditLog` row is required** for the happy path. **[CONFIRM]**
whether a sustained-rate-limit hold (architecture §11.1 "alert admin if hold > 30 min") emits an
admin notification/audit here or is purely an observability-story alert (recommend: emit the
metric here; paging in the observability story — §5.11).

---

## 12. Definition of Done

- [ ] `@anthropic-ai/sdk` added to `package.json`; the SDK is imported **only** inside
      `src/services/ai/`.
- [ ] **AI-service wrapper** exists: `AiClient` interface, `AnthropicAiClient`, `MockAiClient`,
      and a prompt service with `runPrompt` (generic) + `analyzeSubmission` (domain). Client
      selected by `config.ai.mockMode`.
- [ ] **Versioned prompt** `analysis@v1` lives in `/prompts/`; a version registry pins the
      current version; the pinned version is the value recorded in `promptVersions.analysis`.
- [ ] **Prompt caching** split implemented: stable cached prefix (system + JSON contract + enum +
      taxonomy + injection guard) marked for caching; variable per-submission suffix not cached;
      `cacheRead`/`cacheCreation` tokens recorded.
- [ ] **Zod output schema** `AnalysisOutputSchema` enforces sentiment enum, ranked quote-object
      array (text substring of input, contiguous ranks, source enum, ≤ cap), and closed tag
      taxonomy; invalid output **rejected**.
- [ ] **Retry-on-parse/validation-failure** with backoff inside the wrapper
      (`promptParseRetries`, default 2); exhaustion throws and the job fails without persisting
      partial output.
- [ ] **Rate-limit backoff** (429/overload) per architecture §11.1 (exponential, cap 5 min);
      non-retryable auth/400 fails fast; sustained-failure signals emitted as metrics.
- [ ] **`analysis` queue** processor (`analysis.analyze_submission`) registered (concurrency 4,
      High), reusing Story 9's registry + `enqueue` + `buildJobKey`; payload is ids only.
- [ ] **Enqueue wiring**: `analyze` fires after transcription completes/skips (coordinated with
      Story 10), skips when `Submission.status = REJECTED`, after-commit only; backfill query
      noted.
- [ ] **Persistence**: `Submission.sentiment`/`extractedQuotes`/`tags` written; `AiArtifact`
      upserted with rolled-up `sentimentSummary` + merged `modelVersions.sonnet` +
      `promptVersions.analysis`; concurrency-safe (recompute-from-DB + atomic Json merge).
- [ ] **Media-mix tags computed in-code** (authoritative) and merged with model-derived
      relationship tags.
- [ ] **Mock client** is deterministic (pure function of input), always schema-valid, with a
      test hook to inject invalid output for the retry test.
- [ ] **Config**: `ai` block (`anthropicApiKey`, `sonnetModel`, `opusModel` reserved, `mockMode`,
      retry/backoff knobs) in **both** `src/config/env.ts` and `src/config/index.ts`;
      `.env.example` updated; key required only when `mockMode === false`; no `process.env`
      outside `src/config/`.
- [ ] **`AiArtifact` model present** (added here if no prior story added it); migration additive +
      nullable.
- [ ] **Seed** produces analyzed submissions (mock mode) spanning sentiments/quotes/tags + an
      event-level `AiArtifact`; offline `AI_MOCK_MODE=true` recipe documented.
- [ ] **Tests**: unit (mock determinism, Zod pass/fail + retry, sentiment/quote/tag shapes,
      prompt-version recording, caching split, idempotency key, rollup, skip paths) + integration
      (enqueue→analyze[mock]→DB, idempotent re-enqueue, concurrent same-event, deleted-submission
      no-op) pass; real-AI smoke gated by `RUN_REAL_AI`; `SKIP_INTEGRATION` honored.
- [ ] **Metrics-shaped logs** (tokens, cache, latency, validation pass/fail, attempts, queue
      depth, outcome) emitted; **no** prompt/transcript/free-text/output content in logs.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green.
- [ ] No TODO comments left in committed code.

---

## 13. Open Questions / Assumptions

| # | Item | Recommendation / default | Needs |
|---|---|---|---|
| A1 | **Story 10 transcript contract** (column `Submission.transcript` vs per-`MediaItem` JSON in storage) — design doc not present | Consume `Submission.transcript` (arch §7.1); reconcile if Story 10 stored per-media transcripts | **[CONFIRM with Story 10]** |
| Q1 | **Quote ranking method** | Model assigns `rank` (1=best) + `score` (0–1); ties broken by rank; cap ≤5 quotes; `text` must be a substring of input (anti-hallucination/injection) | **[CONFIRM]** rank source (model vs in-code re-rank), cap, score scale |
| Q2 | **Relationship tag taxonomy + who normalizes** (model vs in-code lookup) | Closed `rel:*` taxonomy in the cached prefix; model normalizes free-text relationship → tag; in-code lookup as cross-check/fallback | **[CONFIRM]** taxonomy strings + normalizer ownership (with Story 7/12) |
| Q3 | **`sentimentSummary` rollup method** (deterministic in-code aggregate vs separate event-level Sonnet call) | Deterministic in-code aggregate, recompute-from-DB (cheap, retry-safe); richer Sonnet summary deferred to Story 16's event-level pass | **[CONFIRM]** |
| Q4 | **Who owns the `AiArtifact` model/migration** (Story 9 / 11 / 16) | Story 11 adds it if absent (additive, nullable); whoever lands first creates it, all others upsert + Json-merge | **[CONFIRM]** |
| Q5 | **Prompt-injection mitigation** for untrusted contributor text | System instruction marks text as data-not-instructions; untrusted content in delimited/escaped variable suffix; Zod closed-schema + quote-substring check as backstop | **[CONFIRM]** delimiter/escaping convention |
| Q6 | **Sentiment cardinality** (single dominant label vs ranked label list) | Single dominant label (simplest downstream for Story 12/7) | **[CONFIRM]** |
| Q7 | **`extractedQuotes` shape** (rich `{text,rank,score,source}` array vs `string[]` per arch §7.1 comment) | Rich object array (rank/source needed by Story 7 + Story 16); column is `Json?` so it fits | **[CONFIRM]** |
| Q8 | **Sentiment storage** (`String?` + Zod-enforced vocab vs a Prisma enum) | Keep `String?` (arch §7.1), enforce closed vocab at the Zod boundary | **[CONFIRM]** |
| Q9 | **Skip-empty handling** (no transcript + no text) | Skip the model call; in-code relationship/media tags; `sentiment = NEUTRAL` (or null) | **[CONFIRM]** sentiment value when empty |
| Q10 | **Analyze auto-rejected submissions?** | No — skip when `Submission.status = REJECTED` (don't spend Sonnet) | **[CONFIRM]** |
| Q11 | **Enqueue ownership** (transcription job vs a finalize step triggers `analyze`) | Story 10's transcription job (success or skip path) enqueues analyze; re-check quality/reject at run | **[CONFIRM with Story 10]** |
| Q12 | **Media-mix tags authoritative in-code** (override model) | Yes — compute from `MediaItem[]`; merge over any model-suggested media tags | **[CONFIRM]** |
| Q13 | **Wrapper parse-retry count** (A) and **rate-limit backoff cap** (B) | (A) 2 retries; (B) exponential, cap 5 min (`Retry-After` honored); rely on SDK built-in retry + job-level backoff for the longer hold | **[CONFIRM]** |
| Q14 | **Anthropic key required under mock mode** | Zod superRefine: required only when `mockMode === false` | **[CONFIRM]** |
| Q15 | **Prompt-caching SDK surface** (header/beta flag, min-token threshold) | Pin SDK version that supports caching; no-op gracefully if prefix below threshold | **[CONFIRM]** |
| Q16 | **Sustained rate-limit → admin alert** here vs observability story | Emit metric here; paging in observability story (optional minimal notification) | **[CONFIRM]** |
| Q17 | **AI service module location / layout** (`src/services/ai/`) | `src/services/ai/` with `client.ts` (interface + factory), `anthropic.ts`, `mock.ts`, `prompt-service.ts`; `/prompts/` for templates | **[CONFIRM layout]** |
| Q18 | **Seed runs analysis via queue vs direct call** | Through the queue once (demonstrates plumbing) + direct-call fast path; mock mode | **[CONFIRM]** |
| Q19 | **PII redaction before sending to Anthropic** | Do not redact content (degrades analysis); never log content | **[CONFIRM]** |
| Q20 | **Expose `ANALYSIS_QUEUE_CONCURRENCY` / retry knobs in env** | Yes for concurrency + retries/backoff (operationally tunable); defaults 4 / 2 / 300000ms | **[CONFIRM]** |
