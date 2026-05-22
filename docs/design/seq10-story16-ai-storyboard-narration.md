# Sequence 10 / Story 16 — AI Storyboard + Narration Script Generation

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (prompt inputs, Zod output **shapes** as field lists, model assignment per task, the
prompt-caching prefix/suffix split, the queue/job/idempotency model, persistence into
`AiArtifact`, the admin-edit flow, error cases) so a later code-generation step implements
exactly this and nothing more. Where a value is a proposal awaiting confirmation it is flagged
**[CONFIRM]**; genuine ambiguities are listed in §13, not silently chosen. **No code appears in
this document.**

| Field | Value |
|---|---|
| Story number / title | Story 16 — AI storyboard + narration script generation |
| Epic | E — AI Pipeline |
| Sequence number | 10 (this is the 10th design in build order) |
| Depends on | Story 12 (routing analyzer + approval gate — the `AI_ROUTED` status is this story's trigger) |
| Parallel with | Story 13 (manual workflow — the `MANUAL_ROUTED` sibling path) |
| Also assumes on `main` | Story 1 (config `env.ts`/`index.ts`, `db`, `redis` singleton, `logger`, worker bootstrap, CI), Story 3 (`Event` + `OccasionType`), Story 5 (`Submission` text fields), Story 6 (`MediaItem` + `MediaType`), Story 7 (admin auth gate `requireAdmin` + `/admin/events/[id]` detail layout), Story 8 (`AuditLog` + audit-in-transaction pattern), **Story 9 (BullMQ registry, `enqueue` helper, idempotency `jobId` convention, worker bootstrap, graceful shutdown, storage `getObjectStream`/`putObject`)**, **Story 10 (Whisper raw word-timestamp JSON at `…/transcripts/{media_id}.json`; `Submission.transcript`)**, **Story 11 (the reusable AI-service wrapper: `runPrompt`, Zod validation, retry, token logging, model/prompt-version recording, prompt caching, `MockAiClient`; `AiArtifact` model; `Submission.sentiment`/`extractedQuotes`/`tags`)**, Story 12 (`Event.status = AI_ROUTED` + `routingDecision`) |
| Unlocks | Story 17 (AI video assembly + encoding — consumes `AiArtifact.storyboardJson` + `narrationScript`/`introText`/`outroText` + the `.srt` subtitle artifacts) |
| Complexity | L (3–5 days) |

> **Why this story copies, not invents.** Story 11 (`seq08-story11-claude-analysis.md`) built the
> **one** reusable AI-service wrapper the product uses to call Claude: versioned prompt templates
> in `/prompts/`, Zod output validation, retry-on-parse/validation-failure with backoff,
> token/latency/validation logging, model-version + prompt-version recording, the cached-prefix /
> variable-suffix prompt-caching split, and the `MockAiClient` selectable via `AI_MOCK_MODE`.
> Story 16 **reuses this wrapper verbatim** — it adds prompt templates (`storyboard`, `narration`,
> `intro_outro`) and output schemas, a model **tier** parameter (Opus for the storyboard, Sonnet
> for the rest), the `storyboard` (concurrency 1) + `script` (concurrency 2) queues' processors,
> the subtitle-alignment logic, and the admin-edit surface. It does **not** re-build the AI
> infrastructure, the queue infrastructure (Story 9), or the `AiArtifact` model (Story 11).

> **Sources of truth honored:** `docs/requirements.md` §5.3 (storyboard draft = sequence/order
> across all media; narration script using all text/transcriptions/quotes; intro & outro text;
> captions/subtitles `.srt` for video/voice), §5.5 (admin "AI-generated script" with **editable
> sections**, "AI-generated storyboard" sequence with transitions + captions; export package
> includes script + storyboard + subtitle files), §7 (AI integration points). `docs/architecture.md`
> §9.1 (model tiering — Storyboard = Claude **Opus** single-shot per event; Narration + intro/outro
> = **Sonnet**), §9.2 (Prompt Architecture — versioned templates, Zod-validated outputs, the
> `StoryboardSchema` shape), §9.3 (Prompt Caching — shared cached prefix = event metadata +
> approved submission summaries; variable suffix per task), §6.3 (the event-level chain
> storyboard → narration → intro/outro → subtitles, fires after the AI route), §7.1 (`AiArtifact`
> model: `storyboardJson`, `narrationScript`, `introText`, `outroText`, `modelVersions`,
> `promptVersions`, `adminApproved`, `@unique` per event), §7.2 (S3 artifact paths
> `artifacts/storyboard.json`, `script.md`, `subtitles.srt`), §8.1 (`storyboard` concurrency 1
> serialized; `script` concurrency 2), §8.2 (idempotency contract), §11.1 (Claude rate-limit
> backoff), §13 (AI observability). `docs/development-setup.md` §4 (OPUS disabled in dev —
> `OPUS_MODEL=claude-sonnet-4-6`; real Opus opt-in; prompt caching ON; `AI_MOCK_MODE`), §7 (config
> single-source). `docs/branding.md` §3/§10 (admin tone: calm, no exclamation marks; honoree name
> sacred). `docs/stories.md` (Story 16 line). `CLAUDE.md`. `prisma/schema.prisma` (current: `User`
> + `Role`). Sibling designs reused: `seq08-story11-claude-analysis.md` (the prompt wrapper),
> `seq06-story09-workers-quality-scoring.md` (queue + idempotency), `seq09-story12-routing-analyzer-approval.md`
> (`AI_ROUTED` trigger), `seq07-story10-whisper-transcription.md` (Whisper word timestamps for
> subtitle alignment), `seq05-story07-admin-dashboard-readonly.md` (admin UI to extend).

---

## 1. Story Summary

By Story 12, an admin has stood at the approval gate and clicked **Approve AI Routing** — the
event's status is now `AI_ROUTED`, and (per Story 12 §5.6 step 6, flagged as the handoff seam)
**nothing downstream has run yet**. Story 16 is what `AI_ROUTED` triggers: the **event-level**
creative generation pass.

For an `AI_ROUTED` event, Story 16 produces four artifacts and persists them to the single
`AiArtifact` row for the event:

1. **Storyboard** — a single-shot **Claude Opus** call that orders **all approved media across
   all contributors** into a coherent sequence, assigning each clip a duration, a clip note, a
   transition, and an optional caption (`architecture.md` §9.1, §9.2 `StoryboardSchema`). →
   `AiArtifact.storyboardJson` (+ S3 `artifacts/storyboard.json`).
2. **Narration script** — a **Claude Sonnet** call that writes the spoken/on-screen narration
   using all text, transcriptions, and extracted quotes, organized into **editable sections**
   aligned to the storyboard (`requirements.md` §5.3, §5.5). → `AiArtifact.narrationScript`
   (+ S3 `artifacts/script.md`).
3. **Intro & outro text** — a **Claude Sonnet** call (or a section of the narration call —
   §5.5 / §13 Q1) that writes the opening and closing title-card copy from event metadata +
   tone. → `AiArtifact.introText` / `AiArtifact.outroText`.
4. **Subtitles (`.srt`)** — per-clip caption files aligned to the storyboard cuts using the
   **Whisper word timestamps** Story 10 stored (`architecture.md` §6.3, §7.2). This is a
   **non-LLM** alignment step (cut the word-timestamp stream to each storyboard clip's window).
   → S3 `artifacts/subtitles.srt` (and/or per-clip — §5.5 / §13 Q9).

All four are produced by the **event-level chain** `architecture.md` §6.3 draws:
`storyboard → narration → intro/outro → subtitles`. They reuse Story 11's prompt service (Zod
validation, retry, token logging, model/prompt-version recording, prompt caching) with a
**shared cached event prefix** across the Opus and Sonnet calls (§5.7), and they are
**admin-editable** afterward (§4, §5.10): the admin can edit the narration, intro/outro, and the
storyboard ordering/captions/transitions, save, regenerate, and flip `AiArtifact.adminApproved`.

**Out of scope:** the actual **video assembly / encoding** that consumes these artifacts (Story
17), the **routing decision / approval gate** itself (Story 12), and the **manual** editor brief
(Story 13). Story 16 produces the creative plan; Story 17 renders it.

### Success criteria

- [ ] When an event becomes `AI_ROUTED`, the event-level chain fires (storyboard → narration →
      intro/outro → subtitles) exactly once, serialized, and persists all four artifacts to the
      one `AiArtifact` row.
- [ ] The storyboard is generated by **Opus** (`config.ai.opusModel`) on the `storyboard` queue
      (concurrency 1); narration + intro/outro by **Sonnet** (`config.ai.sonnetModel`) on the
      `script` queue (concurrency 2) — reusing Story 11's `runPrompt`.
- [ ] All three LLM calls for one event share a **stable cached prefix** (event metadata +
      approved submission summaries); cache read/creation tokens are recorded; the second and
      third calls hit the cache.
- [ ] Storyboard output validates against `StoryboardSchema`; narration/intro/outro against their
      schemas; invalid output retries then fails the job without persisting partial output.
- [ ] `.srt` subtitles are produced by aligning Whisper word timestamps to storyboard clip
      windows and written to S3.
- [ ] The admin event detail shows the script + storyboard with **editable** sections
      (narration, intro/outro, storyboard ordering + captions + transitions), Save, Regenerate,
      and an `adminApproved` toggle. Edits persist (overwrite by key) and survive regeneration
      per the documented conflict rule (§5.10).
- [ ] In dev, Opus is downgraded to Sonnet (`OPUS_MODEL=claude-sonnet-4-6`); in `AI_MOCK_MODE`
      the whole chain runs offline deterministically.
- [ ] `modelVersions` (`opus`, `sonnet`) + `promptVersions` (`storyboard`, `narration`,
      `intro_outro`) are merged into the `AiArtifact` row (not clobbering Story 11's keys).
- [ ] Unit + integration tests (§9) pass; integration skips cleanly under `SKIP_INTEGRATION`;
      real-API gated behind `RUN_REAL_AI`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; no `process.env`
      outside `src/config/`.

---

## 2. Scope

### In scope (this story)

- **Event-level storyboard generation (Opus)** — a single-shot `runPrompt('storyboard', …,
  { tier: 'opus' })` over the approved submissions + media metadata + quotes/sentiment (Story
  11), validated by `StoryboardSchema` (§5.5.1). On the `storyboard` queue (concurrency 1,
  serialized for cost control).
- **Narration script generation (Sonnet)** — `runPrompt('narration', …, { tier: 'sonnet' })`
  using all text/transcripts/quotes, organized into editable sections aligned to storyboard
  clips, validated by `NarrationSchema` (§5.5.2). On the `script` queue (concurrency 2).
- **Intro & outro text (Sonnet)** — `runPrompt('intro_outro', …, { tier: 'sonnet' })` (or a
  section of the narration call — §13 Q1), validated by `IntroOutroSchema` (§5.5.3). On the
  `script` queue.
- **Subtitles `.srt` (non-LLM alignment)** — align Story 10's Whisper word timestamps to each
  storyboard clip's window, emit valid SubRip `.srt`, write to S3 (§5.5.4, §5.6).
- **The shared cached event prefix** across all three LLM calls (event metadata + approved
  submission summaries) per `architecture.md` §9.3 (§5.7).
- **The event-level chain trigger** off `Event.status = AI_ROUTED` (the Story 12 seam, §5.3) and
  the chain ordering storyboard → narration → intro/outro → subtitles (§5.4).
- **Persistence into the existing `AiArtifact` row** (`storyboardJson`, `narrationScript`,
  `introText`, `outroText`; merged `modelVersions`/`promptVersions`) + S3 artifact files (§6, §7.2).
- **Admin-edit surface** on `/admin/events/[id]` — editable narration / intro / outro /
  storyboard ordering+captions+transitions, Save, Regenerate (per-artifact + all),
  `adminApproved` toggle; persistence overwrite-by-key; the regenerate-vs-edit conflict rule
  (§4, §5.10).
- **Idempotency** — Story 9's `{event_id}::{job_type}` key convention (event-level, no
  submission segment); output-by-key overwrite; serialization (§5.8).
- **Config** — `OPUS_MODEL` (now actually **used**; Sonnet in dev), `SONNET_MODEL`,
  `ANTHROPIC_API_KEY`, `AI_MOCK_MODE` (mostly already wired by Stories 10/11; this story adds
  the storyboard/script queue knobs + prompt-version pins) in **both** config files (§7).
- **Versioned prompt templates** in `/prompts/`: `storyboard`, `narration`, `intro_outro` (§5.2,
  §7.4).
- **Deterministic mock outputs** for the whole chain (`MockAiClient`) so seed + CI run offline (§8).
- **Tests** — unit (Zod validation for each artifact, prompt-caching prefix stability, model
  selection per task, retry on parse fail, subtitle alignment math, admin-edit persistence) +
  integration (`AI_ROUTED → generate[mock] → AiArtifact`), real-API gated (§9).

### Out of scope (deferred — with owners)

| Deferred item | Owner / where | Note |
|---|---|---|
| **Video assembly / FFmpeg encoding** (master, Reel, YouTube, thumbnail, subtitle burn-in) | Story 17 | Story 16 produces the storyboard/script/subtitle **plan**; Story 17 renders it on the `encoding` queue (separate encoder pool, `architecture.md` §4) |
| **Routing decision + approval gate** | Story 12 | Story 16 is **triggered by** `AI_ROUTED`; it does not decide routing |
| **Manual editor brief** (the storyboard/script feed the brief too) | Story 13 | Story 13 reuses the same `AiArtifact` artifacts for its ZIP brief; Story 16 only writes them |
| **Per-submission sentiment / quotes / tags** | Story 11 | Consumed as inputs; not produced here |
| **Whisper transcription + raw word-timestamp JSON** | Story 10 | Consumed for subtitle alignment; not produced here |
| **Export package assembly** (script PDF/DOCX, storyboard PDF, metadata CSV) | Story 14/15 (export) | Story 16 writes `storyboard.json` + `script.md` + `subtitles.srt`; PDF/DOCX rendering is the export story (§13 Q10) |
| **Music selection / licensing** | Out of scope (editor/MVP) | `Event.musicMood` is passed to the prompts as a tone brief only (`requirements.md` §9) |
| **Real-time admin/organizer co-editing of the script** | Out of scope (`architecture.md` §15) | Admin owns the script; single-editor model |
| **Full OpenTelemetry export** | Observability story | Story 16 emits metric-shaped logs now (§11) |

---

## 3. Dependencies & Sequence

### Must already be on `main`

- **Story 1 (Foundation):** typed `config` (`env.ts` + `index.ts`), `src/lib/db.ts`,
  `src/lib/redis.ts`, `logger`, worker bootstrap `src/workers/index.ts`, CI, `SKIP_INTEGRATION`,
  `@/` alias, the ESLint ban on `process.env` outside `src/config/`.
- **Story 3 / 5 / 6:** `Event` (`occasionType`, `theme`, `musicMood`, `honoreeName`,
  `eventDate`, `status`), `Submission` (text fields + `status` + `relationship`),
  `MediaItem` (`type`, `duration`, `width`/`height`, `storagePath`, `qualityFlags`).
- **Story 7 (Admin dashboard read-only):** the admin auth gate (`requireAdmin`, Google OAuth,
  `ADMIN_EMAIL_DOMAINS`, `role=ADMIN`) and the `/admin/events/[id]` detail layout the script +
  storyboard sections slot into.
- **Story 8 (Submission approval):** `Submission.status = APPROVED` (the storyboard/narration use
  **approved** submissions) and the `AuditLog` + audit-in-transaction pattern (reused for the
  admin-edit / regenerate / approve actions).
- **Story 9 (Workers + quality):** the BullMQ **registry + `enqueue` helper + `buildJobKey()`** +
  the worker bootstrap; the storage service with `getObjectStream`/`putObject` (Story 9 §7.3,
  Story 10 §7.3) for reading Whisper JSON + writing artifacts. The `storyboard` (concurrency 1)
  and `script` (concurrency 2) queues are **declared** in Story 9's registry; Story 16 attaches
  their processors.
- **Story 10 (Whisper transcription):** the **raw word-timestamp JSON** at
  `events/{eventId}/submissions/{submissionId}/transcripts/{mediaId}.json` — the source data for
  subtitle alignment (§5.5.4). Also `Submission.transcript` (plain text the narration consumes).
- **Story 11 (Claude analysis — the load-bearing reuse):** the **AI-service wrapper** (`runPrompt`
  generic core, Zod validation, parse-retry, rate-limit backoff, token/version logging, prompt
  caching, client factory + `MockAiClient`); the **`/prompts/` versioned-template + registry**
  pattern; the **`AiArtifact` model** (Story 11 creates it if absent); and the per-submission
  `Submission.sentiment`/`extractedQuotes`/`tags` + `AiArtifact.sentimentSummary` Story 16 reads
  as storyboard/narration inputs.
- **Story 12 (Routing):** `Event.status = AI_ROUTED` (+ `routingDecision = AI`) — **the trigger**.
  Story 12 §5.6 explicitly leaves the "what `AI_ROUTED` enqueues" as the handoff seam this story
  fills (Story 12 §13 Q21).

### Provides to later stories

- `AiArtifact.storyboardJson` (validated `StoryboardSchema`) + `narrationScript` + `introText` +
  `outroText` + S3 `artifacts/storyboard.json` / `script.md` / `subtitles.srt` → **Story 17**
  (video assembly/encoding) and **Story 13** (manual brief reuses the same artifacts) and the
  export story (Story 14/15).
- The model-tier parameter exercised on the wrapper (Opus path) — first real Opus usage in the
  product; confirms the wrapper's `tier: 'opus'` branch.

### Sequencing notes

- Story 16 runs **after** the per-submission pipeline (quality + transcription + analysis) is
  complete for the event and **after** the admin has approved AI routing. The §6.3 DAG places
  the storyboard chain **downstream of** the analyze nodes and the routing gate.
- Build the chain so the only thing Story 17 needs is to **read** `AiArtifact` + the S3 artifacts;
  do not couple assembly into this story.
- Coordinate the **trigger enqueue** with Story 12 (the after-commit point of the Approve-AI
  action, §5.3) and the **admin-edit surface** with Story 7's detail layout (§4).

### Sequence within this story

```
1. Config: confirm OPUS_MODEL is now USED (Sonnet in dev); add storyboard/script queue knobs +
   prompt-version pins → verify: config parses; mock mode boots without a key
2. Prompt templates: /prompts/storyboard, /prompts/narration, /prompts/intro_outro (+ schemas)
   → verify: each renders cached-prefix + variable-suffix; schema co-located
3. Output schemas: StoryboardSchema, NarrationSchema, IntroOutroSchema (Zod) → verify: unit
4. storyboard processor (Opus, concurrency 1) reusing runPrompt → verify: enqueue→generate[mock]→
   AiArtifact.storyboardJson + S3 storyboard.json
5. narration + intro/outro processors (Sonnet, concurrency 2) → verify: AiArtifact fields + S3 script.md
6. subtitle alignment (Whisper words → clip windows → .srt) → verify: unit math + S3 subtitles.srt
7. Chain trigger off AI_ROUTED + ordering storyboard→narration→intro/outro→subtitles → verify: integration
8. Admin-edit surface (editable sections, Save, Regenerate, adminApproved) → verify: edit persists,
   conflict rule honored, audited
9. Seed: an AI_ROUTED event w/ approved analyzed submissions + mock storyboard/script
   → verify: admin detail renders editable artifacts locally
10. Tests + DoD → verify: lint/typecheck/test green
```

---

## 4. Frontend / UI Design

All copy honors `branding.md` §3/§10: **warm, confident, clear**; **no exclamation marks** in
this operational surface; the **honoree name is sacred** — spelled exactly as the organizer
entered it, never auto-capitalized/abbreviated. Lucide outline icons (20px); palette tokens from
`globals.css`. The **signature gradient/gold is NOT used here** (reserved for the final-video
delivery moment, `branding.md` §10). This is an **admin-only, authenticated** surface (Story 7
gate); it is **never honoree-facing**.

### 4.1 Where it lives

Two new sections on the existing `/admin/events/[id]` detail page (Story 7), filling the
**"AI-generated script"** and **"AI-generated storyboard"** rows `requirements.md` §5.5 lists.
No new route. The sections render only when an `AiArtifact` exists for the event and the event is
in (or past) `AI_ROUTED`; for `MANUAL_ROUTED` events the artifacts may still display read-only
(they feed the editor brief), per §4.6.

### 4.2 Generation state machine (what the admin sees while the chain runs)

| State | Condition | UI |
|---|---|---|
| Not started | `AI_ROUTED` set, chain not yet run / no `AiArtifact.storyboardJson` | Muted card: "Generating the storyboard and script. This usually takes a minute or two." A passive progress indicator; no actions |
| Generating | A `storyboard`/`script` job is active for this event | Per-artifact status: Storyboard (running/done), Narration (queued/running/done), Intro & outro, Subtitles. Calm, no spinner-spam |
| Ready | All four artifacts present | The full editable view (§4.3–§4.4) + `adminApproved` toggle |
| Generation failed | A job exhausted retries (§5.9) | Calm error card: "We couldn't finish generating the script. Retry, or switch this event to a human editor." + **Regenerate** + a link to the Story 12 manual override |
| Partial | Storyboard done, narration failed (etc.) | Show what exists read-only; offer **Regenerate** for the failed artifact only |

> **[CONFIRM]** how the admin page learns the chain finished — recommend the same approach Story
> 12 §5.5.1 chose for live preview: the server component reads the persisted `AiArtifact` on each
> load (no push). A manual "Refresh" affordance covers the in-flight window; live push is a later
> concern (§13 Q11).

### 4.3 AI-generated script (editable sections)

`requirements.md` §5.5: "Full narration script with editable sections." The narration is
rendered as an **ordered list of sections** (`NarrationSchema.sections[]`, §5.5.2), each tied to
a storyboard clip (or a global section). Per section:

| Element | Source | Editable? |
|---|---|---|
| Section label | `section.label` (e.g. "Riya's mum — opening wish") | read-only (derived) |
| Linked clip reference | `section.clip_ref` (storyboard `media_item_id` / sequence index) | read-only |
| Narration text | `section.text` | **Yes** — inline rich-text/textarea; edits persist (§5.10) |
| Source provenance | `section.sources[]` (which submission/quote it drew from) | read-only badge |

**Intro & outro** render as two dedicated editable text blocks above/below the section list
(`AiArtifact.introText` / `outroText`). All editable fields share one **Save** action (per-field
or whole-section — §13 Q12) and a per-field "edited by admin" indicator once changed (§5.10).

### 4.4 AI-generated storyboard (editable ordering + captions + transitions)

`requirements.md` §5.5: "Sequence of clips/photos with suggested transitions and captions." The
storyboard renders as an **ordered, reorderable list** of `StoryboardSchema.sequence[]` items:

| Element | Source | Editable? |
|---|---|---|
| Order / position | array index | **Yes** — drag-to-reorder (or up/down) |
| Media thumbnail + identity | `media_item_id` → `MediaItem` (type, contributor) | read-only |
| Media type | `media_type` | read-only |
| Duration (sec) | `duration_sec` | **Yes** — numeric input (bounds §5.5.1) |
| Clip note (editor-readable) | `clip_note` | **Yes** — textarea |
| Transition in | `transition_in` (closed vocabulary §5.5.1) | **Yes** — select from the transition enum |
| Caption | `caption?` | **Yes** — text (optional) |

Editing the storyboard **rewrites `storyboardJson`** (overwrite-by-key, §5.10). A summary line
shows `total_duration_sec` (recomputed live from the edited durations) and `pacing_notes`
(read-only, regenerated only by a fresh generation). Reordering or removing a clip surfaces a
calm warning if a narration section references it (§5.10 conflict note).

### 4.5 Actions

| Action | Behavior |
|---|---|
| **Save** (edits) | Persists the edited narration/intro/outro/storyboard to `AiArtifact` (overwrite-by-key, §5.10); marks affected fields as admin-edited; writes an `AuditLog` `artifact.edited` row; revalidates the page |
| **Regenerate** (per-artifact) | Re-enqueues the relevant job (storyboard / narration / intro-outro / subtitles), warning that **unsaved or admin-edited content for that artifact will be overwritten** (§5.10 conflict rule). Disabled while a job for that artifact is active |
| **Regenerate all** | Re-runs the full chain from the storyboard (since narration/subtitles depend on it). Strong confirm (§5.10) |
| **`adminApproved` toggle** | Flips `AiArtifact.adminApproved`. ON = "the script and storyboard are approved for assembly" — the Story 17 assembly gate reads this (§6.3, §13 Q13). Writes an `AuditLog` `artifact.approved` / `artifact.unapproved` row. **[CONFIRM]** whether toggling on also enqueues Story 17 assembly or whether assembly is a separate explicit action (§13 Q13) |

### 4.6 States by `Event.status`

| `Event.status` | Script/storyboard section renders |
|---|---|
| pre-`AI_ROUTED` (`ACTIVE` … `AWAITING_ROUTING_APPROVAL`) | Nothing (no AI artifacts yet) — or a muted "AI artifacts appear once AI routing is approved." |
| `AI_ROUTED` | The generation state machine (§4.2) → the editable view (§4.3–§4.4) once ready |
| `MANUAL_ROUTED` | The artifacts (if any were generated) render **read-only** as the editor-brief reference (`requirements.md` §5.7) — **[CONFIRM]** whether Story 16 even runs for manual events (recommend: only run on `AI_ROUTED`; manual events get artifacts only if generated before the switch — §13 Q3) |
| `IN_REVIEW` … `DELIVERED` | Editable until `adminApproved`/assembly locks them; then read-only recap (§13 Q14) |

### 4.7 Error copy (admin-facing, calm voice)

| Case | Message |
|---|---|
| Generation still running | "The script is still being generated. Refresh in a moment." |
| Generation failed | "We couldn't finish generating the script. You can retry, or switch this event to a human editor." |
| Save conflict (regenerated under you) | "This was just regenerated. Your edits weren't saved — review the new version." |
| Save failed | "Your changes couldn't be saved. Try again." |
| Forbidden (shouldn't reach UI) | "You don't have access to do that." |
| Regenerate while job active | "A regeneration is already running for this event." |

### 4.8 Accessibility & branding

- Reorder controls are keyboard-operable (not drag-only); each has a discernible name
  ("Move clip 3 up").
- Editable fields are labeled `<label>`s; save state announced via `aria-live="polite"`.
- The honoree name appears verbatim wherever the event is identified.
- Transition/duration controls have text labels (not color/icon only); WCAG AA contrast.
- No gradient/gold; saffron accent (`--brand-deep-saffron`) for primary actions only.

---

## 5. Backend / Worker design

The generation is the heart of the story. §5.1–§5.2 cover reuse + templates; §5.3–§5.4 the
trigger + chain; §5.5 the four output contracts; §5.6 persistence; §5.7 caching; §5.8 idempotency;
§5.9 retry; §5.10 the admin-edit flow; §5.11 error cases.

### 5.1 Reuse of the Story 11 AI-service wrapper

Story 16 calls Story 11's **generic `runPrompt(promptId, version, input, outputSchema, options)`**
(Story 11 §5.2) — it does **not** add a new AI client, factory, retry, logging, caching, or
mock-selection mechanism. New domain methods are thin wrappers:

| Domain method (conceptual) | Wraps | Tier | Output schema |
|---|---|---|---|
| `generateStoryboard(input)` | `runPrompt('storyboard', pinned, input, StoryboardSchema, { tier: 'opus', cache: true })` | **opus** | `StoryboardSchema` |
| `generateNarration(input)` | `runPrompt('narration', pinned, input, NarrationSchema, { tier: 'sonnet', cache: true })` | sonnet | `NarrationSchema` |
| `generateIntroOutro(input)` | `runPrompt('intro_outro', pinned, input, IntroOutroSchema, { tier: 'sonnet', cache: true })` | sonnet | `IntroOutroSchema` |

The `tier` option selects `config.ai.opusModel` vs `config.ai.sonnetModel` inside the wrapper
(Story 11 §5.1 designed this parameter precisely so Story 16 reuses the same code path). The
wrapper returns the validated `data` + `meta` (`model`, `promptId`, `promptVersion`,
`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `latencyMs`,
`attempts`); the **job** persists `data` and records `meta` (§5.6, §11). The wrapper does not
touch the DB or S3 — persistence is the job's responsibility (keeps the wrapper reusable).

> **First real Opus call in the product.** Story 11 reserved `config.ai.opusModel` but never used
> it. Story 16 is where `tier: 'opus'` is exercised. In dev `OPUS_MODEL=claude-sonnet-4-6`
> (development-setup §4), so the storyboard runs on Sonnet locally; real Opus is opt-in
> (`OPUS_MODEL=claude-opus-4-7`). The wrapper records the **actual** model string in
> `meta.model`, so `modelVersions.opus` reflects what really ran (§6.1).

### 5.2 Prompt templates + versioning (reuse the /prompts registry)

Per `architecture.md` §9.2 and Story 11 §5.3. Three new versioned templates in `/prompts/`:

| Prompt id | Version (initial) | Tier | Cached prefix (stable) | Variable suffix (per task) |
|---|---|---|---|---|
| `storyboard` | `v1` | opus | the **shared event prefix** (§5.7): event metadata + approved submission summaries + media inventory | the storyboard task instruction + the `StoryboardSchema` JSON contract + transition vocabulary + duration heuristics |
| `narration` | `v1` | sonnet | the **same shared event prefix** (§5.7) — identical bytes → cache hit | the narration task instruction + the **approved storyboard** (so narration tracks the order) + `NarrationSchema` contract |
| `intro_outro` | `v1` | sonnet | the **same shared event prefix** | the intro/outro task instruction + `IntroOutroSchema` contract + tone (theme/musicMood) |

The version registry (Story 11 §5.3) gains `{ storyboard: 'v1', narration: 'v1', intro_outro: 'v1' }`.
Each template ships **with** its co-located Zod output schema (same version) so instructions and
validator never drift. Bumping a prompt = add `/prompts/storyboard/v2` + flip the registry (a
reviewed code change) so output quality correlates with `promptVersions` (`architecture.md` §7.1).

**Template anatomy (all three):**
- **System / instruction (stable, cacheable):** role ("You are planning a tribute video for a
  milestone occasion"), the exact output JSON contract (the field list of §5.5), the closed
  vocabularies (transition enum, etc.), explicit "output JSON only" + "do not invent media that
  isn't in the inventory / do not fabricate quotes" guardrails, and the **prompt-injection guard**
  (§10 — contributor text is data, not instructions).
- **Shared event prefix (cacheable, §5.7):** event metadata (occasion type, theme, music mood,
  event date, honoree name) + the approved-submission summaries (per-submission: contributor
  relationship, sentiment, ranked quotes, media inventory with ids/types/durations) — **the same
  bytes for all three calls of one event**.
- **Variable suffix (not cached):** the per-task instruction (and, for narration, the approved
  storyboard JSON).

### 5.3 Trigger — the `AI_ROUTED` seam

Per Story 12 §5.6 step 6, the **Approve-AI server action**, after committing
`Event.status = AI_ROUTED`, is the seam where Story 16 enqueues the chain. Two wirings:

- **Recommended:** the Approve-AI action, **after commit**, `enqueue(storyboard,
  'storyboard.generate', { eventId })`. The storyboard job is the head of the chain (§5.4); it
  enqueues the next step on success. Rationale: keeps the trigger at the exact decision point,
  matches Story 12's documented handoff (§13 Q21 there), and the storyboard queue's concurrency 1
  serializes Opus spend.
- **Alternative:** a status-watching sweep enqueues for any `AI_ROUTED` event with no
  `AiArtifact.storyboardJson` (a backfill safety net for missed enqueues / Redis-down at decision
  time). **Recommendation:** ship the after-commit enqueue **plus** a minimal backfill query
  (`Event WHERE status = AI_ROUTED AND aiArtifact.storyboardJson IS NULL`) re-enqueueable by a
  cron/admin action; defer the cron itself to Story 18 if needed (§13 Q4).

Enqueue happens **after** the DB commit, never inside the transaction (Story 9 rule). If enqueue
fails (Redis down), log + continue — the event is still `AI_ROUTED`; the backfill recovers it.

### 5.4 The event-level chain (ordering)

Per `architecture.md` §6.3: `storyboard → narration → intro/outro → subtitles`. Realized as a
**linear chain of jobs**, each enqueuing the next on success, so each step sees the prior step's
persisted output:

```
AI_ROUTED (Story 12 commit)
      │ enqueue
      ▼
[storyboard]  storyboard.generate   (queue: storyboard, concurrency 1, Opus)
      │ on success: persist storyboardJson + S3 storyboard.json; enqueue ▼
[script]      narration.generate    (queue: script, concurrency 2, Sonnet)
      │ on success: persist narrationScript + S3 script.md; enqueue ▼
[script]      intro_outro.generate  (queue: script, concurrency 2, Sonnet)
      │ on success: persist introText/outroText; enqueue ▼
[script]      subtitles.align       (queue: script, concurrency 2, NON-LLM)
      │ on success: write S3 subtitles.srt
      ▼
(ready for admin review / Story 17 assembly once adminApproved)
```

> **Why a linear chain, not a fan-out.** Narration needs the **approved storyboard order** (its
> sections align to clips), and subtitles need the **clip windows** the storyboard defines.
> Intro/outro is independent of the storyboard but cheap to keep in the line. The chain also keeps
> the Opus call strictly first and alone on its serialized queue (cost control). **[CONFIRM]**
> whether intro/outro can run in parallel with narration (both Sonnet, both depend only on the
> shared prefix + event metadata) — recommend keeping the simple linear chain in MVP 1 (§13 Q5).

> **Queue choice for the non-LLM subtitle step.** `subtitles.align` does **no** LLM call (it
> aligns Whisper timestamps to clip windows). Run it on the `script` queue for chain simplicity,
> or its own lightweight step. **[CONFIRM]** — recommend `script` queue (no new queue needed;
> it's IO-light) (§13 Q6).

Each chain step **re-reads the authoritative `AiArtifact` / `Submission` / `MediaItem` rows** at
run time (payload is ids only) so retries see current state.

### 5.5 Output contracts (Zod-validated field lists)

Each LLM call returns one JSON object validated by its schema. **Described as field lists, not
code.** The schemas are the contract Story 17 consumes.

#### 5.5.1 Storyboard (`StoryboardSchema`) — Opus

Mirrors `architecture.md` §9.2 exactly, plus event-total fields.

**Top level:**

| Field | Type / constraint | Notes |
|---|---|---|
| `sequence` | array of clip objects (≥1; ≤ a cap, e.g. one-per-approved-media + a few — §13 Q7) | the ordered plan |
| `total_duration_sec` | number > 0 | sum of clip durations (validated ≈ Σ `duration_sec` within tolerance — §13 Q8); cross-check in-code |
| `pacing_notes` | string | editor-readable rationale (read-only in UI) |

**Per `sequence[]` clip object:**

| Field | Type / constraint | Notes |
|---|---|---|
| `submission_id` | string (cuid) — **must reference an approved submission of this event** | provenance; Zod refine against the approved-submission id set (§5.5.5) |
| `media_item_id` | string (cuid) — **must reference a `MediaItem` of that submission** (or be a synthetic id for a text/title card — §13 Q7) | the asset placed at this position |
| `media_type` | enum `video` \| `voice` \| `photo` \| `text` (`architecture.md` §9.2) | matches the referenced media (or `text` for a text card) |
| `duration_sec` | number, within `[min, max]` bounds (e.g. 1–30; per-type defaults — §5.5.6) | how long this clip shows |
| `clip_note` | string | editor-readable note |
| `transition_in` | string, **closed transition vocabulary** (e.g. `cut`, `crossfade`, `fade_in`, `slide`, `dip_to_black` — §13 Q15) | the in-transition |
| `caption` | string, optional | on-screen caption for this clip |

Zod constraints: `media_item_id` values are **unique** within `sequence` (no clip placed twice —
**[CONFIRM]**, §13 Q7); `submission_id`/`media_item_id` must exist in the event's approved set
(refine, §5.5.5); `transition_in` ∈ the closed vocabulary (reject unknown → retry); each
`duration_sec` within bounds. Out-of-contract output is rejected → retry → ultimately a failed
job (no partial write).

#### 5.5.2 Narration script (`NarrationSchema`) — Sonnet

`requirements.md` §5.5 "editable sections"; aligned to the storyboard.

**Top level:**

| Field | Type / constraint | Notes |
|---|---|---|
| `sections` | array of section objects (≥1) | the editable units the UI renders (§4.3) |
| `full_text` | string (optional/derived) | a concatenation for export `script.md` — may be derived in-code from `sections` instead (§13 Q16) |
| `tone_notes` | string (optional) | the tone the script aimed for (theme/musicMood) |

**Per `sections[]` object:**

| Field | Type / constraint | Notes |
|---|---|---|
| `label` | string | section heading (e.g. "Opening — Riya's mum") |
| `clip_ref` | string/number, optional — references a storyboard clip (`media_item_id` or sequence index) | links the section to the clip it narrates; null for global sections (intro bridge, etc.) |
| `text` | string, non-empty | the narration copy (the **editable** field) |
| `sources` | array of strings, optional | provenance (submission ids / quote refs the section drew from); anti-hallucination + admin display |

Zod constraints: each `clip_ref` (when present) must reference a clip in the just-persisted
storyboard (refine against `storyboardJson.sequence`); `text` non-empty; `sources` reference real
submissions/quotes. **[CONFIRM]** whether every clip must have a section vs sections being a
looser overlay (§13 Q16).

#### 5.5.3 Intro / outro (`IntroOutroSchema`) — Sonnet

`requirements.md` §5.3 "opening and closing title card text."

| Field | Type / constraint | Notes |
|---|---|---|
| `intro_text` | string, non-empty, short (≤ ~N chars — §13 Q17) | opening title card → `AiArtifact.introText` |
| `outro_text` | string, non-empty, short | closing title card → `AiArtifact.outroText` |

> If intro/outro is folded into the narration call as a section (§13 Q1), this schema is the two
> fields extracted from `NarrationSchema`; otherwise it is its own call/schema. Default
> (recommended): a **separate small Sonnet call** so intro/outro can be regenerated independently
> and the narration prompt stays focused (§13 Q1).

#### 5.5.4 Subtitles (`.srt`) — non-LLM alignment

**Not an LLM output** — a deterministic alignment step. Inputs: the persisted
`storyboardJson.sequence` (each clip's `media_item_id` + `duration_sec` + cumulative start
offset) + the per-media Whisper word-timestamp JSON Story 10 wrote
(`…/transcripts/{media_id}.json`, with `words[]` of `{ word, start, end }`).

Algorithm (design-level):

1. Walk `sequence` in order, maintaining a running `timeline_offset` (cumulative
   `duration_sec`). Each clip occupies `[timeline_offset, timeline_offset + duration_sec)` on the
   final-video timeline.
2. For VIDEO/VOICE clips with a transcript: read that media's word timestamps; the words falling
   within the clip's **source window** (the portion of the source clip used — §13 Q9: full clip vs
   a trimmed window) map onto the timeline window by `timeline_time = timeline_offset +
   (word_time − clip_source_start)`.
3. Group words into subtitle cues (by sentence/pause/max-chars-per-cue — §13 Q9) and emit valid
   **SubRip `.srt`** entries (index, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, text) on the final-video
   timeline.
4. PHOTO/text clips and clips whose media has no transcript (or `transcription_failed`, Story 10)
   contribute **no** subtitle cues (skipped silently).
5. Write the assembled `.srt` to S3 `artifacts/subtitles.srt` (§7.2). **[CONFIRM]** single
   combined `.srt` for the whole video (recommended — that's what `architecture.md` §7.2 names)
   vs per-clip `.srt` (§13 Q9).

> The clip **source window** (which seconds of the source clip the storyboard uses) is the open
> question (§13 Q9): the `StoryboardSchema` clip has a `duration_sec` but **not** an explicit
> source in/out point. MVP 1 default: assume the clip uses the source from `0` for `duration_sec`
> seconds (or the full clip if shorter), so `clip_source_start = 0`. If trimming/in-out points are
> needed, add `source_start_sec` to the clip schema (additive) — flagged §13 Q9. Subtitle accuracy
> depends on this decision being consistent with Story 17's assembly trim.

#### 5.5.5 Cross-validation against the approved set (Zod refine)

Both the storyboard and narration outputs are **refined** against the event's authoritative data:
`submission_id`/`media_item_id` in the storyboard must belong to **approved** submissions/media of
this event; narration `clip_ref`/`sources` must reference real clips/submissions. A model that
invents an id fails validation → retry → fail (no corrupt write). This is both an
anti-hallucination guard and an anti-injection backstop (§10).

#### 5.5.6 Duration heuristics (input guidance, not a hard schema rule)

The storyboard prompt is **given** per-type default durations (e.g. photo 3–5s, video clip
trimmed to its strong moment, voice the message length, text card 2–4s) and a target total
(derived from package/`musicMood`/clip count — §13 Q8) as **guidance in the variable suffix**.
The schema enforces only the per-clip `[min,max]` bounds and the `total_duration_sec` cross-check;
the exact heuristic values live in a versioned in-code constants module (recorded alongside
`promptVersions.storyboard`), not env, so a tuning change is a reviewed code change.

### 5.6 Persistence (where each output lands)

Each chain step persists to the **single `AiArtifact` row** for the event (Story 11 created the
model; this story populates the remaining columns) **and** writes the human/Story-17-readable S3
artifact. All writes are **overwrite-by-key** (idempotent, retry-safe).

| Step | DB write (`AiArtifact`) | S3 write (`events/{eventId}/artifacts/…`) | Version recording (merge) |
|---|---|---|---|
| storyboard | `storyboardJson` = validated `StoryboardSchema` | `storyboard.json` (the validated JSON) | `modelVersions.opus` = actual model; `promptVersions.storyboard` = pinned |
| narration | `narrationScript` (the `full_text` / sections-as-markdown) | `script.md` | `modelVersions.sonnet`; `promptVersions.narration` |
| intro/outro | `introText`, `outroText` | (folded into `script.md` or none — §13 Q10) | `promptVersions.intro_outro` |
| subtitles | (none in DB — S3 only) | `subtitles.srt` | (none — non-LLM) |

> **`AiArtifact` is `@unique` per event and shared with Story 11.** Story 16 must **upsert + merge
> Json** (`modelVersions`, `promptVersions`) so it never clobbers Story 11's `sentimentSummary` /
> `modelVersions.sonnet` / `promptVersions.analysis`. Use read-merge-write or a Json-merge upsert.
> Story 16's chain is serialized (storyboard concurrency 1) and linear, so cross-step clobber
> within one event is not a concern, but the merge protects Story 11's keys.

`AiArtifact.generatedAt` is updated to the (re)generation time. `adminApproved` is **not** set by
generation — it defaults `false` and only the admin toggle (§4.5) flips it.

### 5.7 Prompt caching — the shared event prefix

Per `architecture.md` §9.3 ("event-level context … shared across storyboard, narration,
intro/outro … stable cached prefix + variable suffix → cache hits on the second and third calls,
~80% input cost reduction") and Story 11 §5.4 (the mechanism).

- **Cached prefix (one `cache_control` breakpoint):** the **shared event prefix** (§5.2) —
  system instruction + the event metadata + the approved-submission summaries (relationship,
  sentiment, ranked quotes, media inventory). This is built **once per event** and is **byte-
  identical** across the storyboard (Opus), narration (Sonnet), and intro/outro (Sonnet) calls.
- **Variable suffix (not cached):** the per-task instruction + per-task output contract (and, for
  narration, the approved storyboard JSON).
- **Cache-hit reality:** the storyboard (first call) **creates** the cache entry; narration and
  intro/outro (subsequent calls within the cache window) **read** it. The chain runs the three
  calls back-to-back (§5.4), so they fall inside the cache TTL.
- **Cross-model caching caveat.** The storyboard uses **Opus**; narration/intro use **Sonnet**.
  Anthropic prompt-cache entries are **scoped per model** — a cache created by an Opus call is
  **not** read by a Sonnet call. So the realistic hit is: narration's prefix-create is read by
  intro/outro (both Sonnet); the storyboard's Opus prefix-create is its own. **[CONFIRM]** this
  per-model scoping with the pinned SDK; the prefix is still structured identically so caching
  works **within** each model tier (Sonnet's two calls share; Opus's one call seeds for any future
  Opus regen). Build the prefix identically regardless so we capture every available hit (§13 Q18).
- **Token accounting:** the wrapper records `cacheReadTokens` + `cacheCreationTokens` per call
  (Story 11 §5.12) so cache efficacy is observable (§11).

### 5.8 Idempotency, serialization & cost control

Reuse Story 9's `buildJobKey()` + `enqueue` helper. These are **event-level** jobs (no submission
segment):

| Job (`job_type`) | Queue | Idempotency `jobId` |
|---|---|---|
| `storyboard.generate` | `storyboard` | `{eventId}::storyboard.generate` |
| `narration.generate` | `script` | `{eventId}::narration.generate` |
| `intro_outro.generate` | `script` | `{eventId}::intro_outro.generate` |
| `subtitles.align` | `script` | `{eventId}::subtitles.align` |

- **In-flight dedup:** BullMQ refuses a duplicate active/waiting job with the same `jobId` — a
  double-trigger (Approve-AI clicked twice, or backfill + trigger both fire) cannot create two
  storyboard jobs for one event.
- **Output-by-key overwrite:** each step writes the same `AiArtifact` columns + the same S3 keys —
  re-running produces the same result (deterministic given the same approved inputs + mock; for
  real models, regeneration is intentional and overwrites).
- **Serialization for Opus cost (`architecture.md` §8.1):** the `storyboard` queue is
  **concurrency 1** — at most one Opus storyboard generates at a time across the whole worker
  process, capping the cost-spike from many events hitting `AI_ROUTED` near a busy delivery day.
  The `script` queue is concurrency 2 (cheaper Sonnet). With multiple worker replicas, effective
  concurrency = per-process × replicas; **[CONFIRM]** whether MVP 1 needs a single global Opus
  limiter across replicas (recommend: keep replica count modest in MVP 1; revisit a distributed
  limiter only if Opus cost spikes — §13 Q19).
- Payloads are **ids only** (`{ eventId }`); the processor re-reads authoritative rows at run.

### 5.9 Retry / backoff policy

Two domains, identical posture to Story 11 (the wrapper owns parse-retry; BullMQ owns job
attempts):

**(A) Output parse / Zod-validation retry (inside the wrapper, per call, Story 11 §5.10):**

| Setting | Value | Rationale |
|---|---|---|
| Triggered by | non-JSON output, or parses but fails Zod (bad transition, invented id, missing field, out-of-bounds duration) | the model occasionally slips format/vocabulary |
| `maxRetries` | **2** (3 attempts) **[CONFIRM]** | a corrective re-ask usually fixes it |
| On exhaustion | wrapper throws `AiOutputValidationError` → the **job** fails; the `AiArtifact` column stays as-was (never persist partial/unvalidated output) | distinguish "couldn't generate" from a real plan |

**(B) Job-level attempts (BullMQ, around the processor):**

| Setting | Value | Rationale |
|---|---|---|
| `attempts` | **3** | codebase posture (Story 9/10/11) |
| `backoff` | exponential, base ~10s (Opus/Sonnet are rate-limited APIs — longer than Story 9's 5s) | `architecture.md` §11.1 |
| Rate-limit (429/overload) | retryable; exponential backoff capped at 5 min (`Retry-After` honored) per `architecture.md` §11.1; non-retryable auth/400 fails fast | reuse Story 11 §5.11 |
| Idempotency | `jobId` dedup + output-by-key overwrite makes re-runs safe | Story 9 contract |

**Chain-failure semantics:** if the **storyboard** job fails after retries, the chain stops (no
narration/subtitles to build) → the event shows "generation failed" (§4.2); the admin can
**Regenerate** or switch to manual (Story 12 override). If a **downstream** step fails (narration,
intro, subtitles), the storyboard is preserved; the failed artifact shows "partial" and is
individually regenerable (§4.2). A failed step does **not** roll back already-persisted upstream
artifacts.

### 5.10 Admin-edit flow (persist by overwrite; edit-vs-regenerate conflict)

The admin can edit the narration sections, intro/outro, and the storyboard (ordering, durations,
clip notes, transitions, captions), then **Save** (§4.5). Design:

- **Persistence = overwrite by key.** A Save writes the edited values back to the same
  `AiArtifact` columns (`narrationScript`, `introText`, `outroText`, `storyboardJson`) — the same
  output-by-key rule generation uses, so the row is the single source of truth whether a value was
  AI-generated or admin-edited (§5.6). The S3 mirror (`script.md` / `storyboard.json`) is rewritten
  on Save so the export/assembly inputs match the DB.
- **Provenance flag.** Mark which fields were admin-edited so the UI shows an "edited by admin"
  indicator and so regeneration can warn (below). **[CONFIRM]** mechanism: a lightweight
  `AiArtifact.editedFields` Json (set of field/section keys) **or** rely on an `AuditLog`
  `artifact.edited` trail (recommend the audit trail as canonical + an optional `editedFields`
  marker for cheap UI checks — §13 Q20).
- **The edit-vs-regenerate conflict (the key rule):** **regeneration overwrites admin edits for
  that artifact.** Generation and admin-edit write the **same** columns, so a Regenerate replaces
  whatever was there (AI or admin). The UI therefore **warns explicitly** before Regenerate when
  the target artifact has admin edits ("Regenerating will replace your edits to the narration.
  Continue?"). **No automatic merge** in MVP 1 (a 3-way merge of model + admin text is out of
  scope). **[CONFIRM]** this overwrite-on-regenerate-with-warning policy (recommended) vs. blocking
  regenerate once edited vs. snapshotting the edit (§13 Q21).
- **Concurrency / stale-edit guard.** A Save carries the `AiArtifact.generatedAt` (or an
  `updatedAt`) the admin loaded; if it changed (a regeneration landed under the admin), the Save
  is rejected with the "this was just regenerated" message (§4.7) rather than silently clobbering
  the new version. **[CONFIRM]** optimistic-version field (§13 Q22).
- **Storyboard-edit ripple to narration/subtitles.** If the admin reorders/removes clips, the
  narration `clip_ref`s and the subtitle timeline may no longer match. MVP 1 default: the admin's
  storyboard edit is saved as-is; a calm warning notes "narration sections may reference moved
  clips — regenerate the script or subtitles to realign." Story 16 does **not** auto-regenerate on
  storyboard edit (avoids surprise Opus/Sonnet cost). **[CONFIRM]** (§13 Q23).
- **Audit.** Each Save writes an `AuditLog` `artifact.edited` row (actor = admin, metadata =
  which fields, timestamp); the `adminApproved` toggle writes `artifact.approved`/`unapproved`
  (Story 8 audit-in-transaction pattern).

### 5.11 Error cases

**Generation (worker side):**

| Case | Handling |
|---|---|
| Storyboard validation fails after retries | Job fails (BullMQ `attempts`), chain stops, event shows "generation failed", `storyboardJson` stays null; admin can Regenerate / switch to manual |
| Downstream (narration/intro/subtitle) fails after retries | Upstream artifacts preserved; that artifact shows "partial"; individually regenerable |
| Claude rate-limit sustained | Exponential backoff to 5 min (`architecture.md` §11.1); jobs hold on the (serialized) queue; emit the metric (§11); paging is the observability story |
| No approved submissions / no usable media | The storyboard job **no-ops with a clear "nothing to storyboard" outcome** and does not call the model; event flagged for admin attention (an `AI_ROUTED` event with zero approved media is an edge case a human should see) — **[CONFIRM]** behavior (§13 Q24) |
| Whisper transcript JSON missing for a clip (subtitle step) | That clip contributes no cues; the `.srt` is built from clips that have transcripts; not a failure |
| Event deleted between enqueue and run (right-to-delete cascade) | Job no-ops success (nothing to generate) |

**Admin actions (server-action side, Story 8 pattern):**

| Case | Detection | Error code | Admin sees |
|---|---|---|---|
| Event not found / stale | load step | `EVENT_NOT_FOUND` | "could not be found…" |
| Not admin | auth step | `FORBIDDEN` | "don't have access…" |
| Save under a regeneration (stale) | version check (§5.10) | `ARTIFACT_STALE` | "this was just regenerated…" |
| Regenerate while a job is active | job-active check | `GENERATION_IN_PROGRESS` | "a regeneration is already running…" |
| Edit before artifacts exist | no `AiArtifact` / not `AI_ROUTED` | `ARTIFACT_NOT_READY` | "AI artifacts aren't ready yet." |
| Unexpected (DB/txn) | any | `INTERNAL` | "Something went wrong…" (txn rolled back) |

---

## 6. Database design

Story 16 **populates** the remaining `AiArtifact` columns from `architecture.md` §7.1 (Story 11
created the model). It introduces **no new model** unless an optional admin-edit-provenance
marker is chosen (§5.10). All writes are additive/overwrite to the existing row.

### 6.1 `AiArtifact` — fields written by Story 16

| Model.field | Type (arch §7.1) | Written by Story 16 | Value |
|---|---|---|---|
| `id` | String @id | (created by Story 11) | — |
| `eventId` | String **@unique** | (created by Story 11) | the one row per event |
| `narrationScript` | `String? @db.Text` | **yes** | the narration `full_text` / sections-as-markdown (§5.5.2); admin-editable (§5.10) |
| `storyboardJson` | `Json?` | **yes** | the validated `StoryboardSchema` object (§5.5.1); admin-editable (§5.10) |
| `introText` | `String?` | **yes** | opening title-card text (§5.5.3); admin-editable |
| `outroText` | `String?` | **yes** | closing title-card text; admin-editable |
| `extractedQuotes` | `Json?` | no (Story 11 / event rollup) | not owned here |
| `sentimentSummary` | `String?` | no (Story 11) | read as input only |
| `modelVersions` | `Json` | **yes (merge)** | set `.opus` = actual storyboard model, `.sonnet` = actual narration/intro model (merge, don't clobber Story 11's `.sonnet`/`.whisper`) |
| `promptVersions` | `Json` | **yes (merge)** | set `.storyboard`, `.narration`, `.intro_outro` (merge with Story 11's `.analysis`) |
| `adminApproved` | `Boolean @default(false)` | **yes (admin toggle only)** | flipped by the admin (§4.5), never by generation |
| `generatedAt` | `DateTime @default(now())` | **yes** | updated on (re)generation; doubles as the stale-edit version source unless a dedicated `updatedAt` is added (§5.10 / §13 Q22) |

### 6.2 Optional new field (admin-edit provenance) — §5.10

| Field (optional) | Type | Purpose |
|---|---|---|
| `AiArtifact.editedFields` | `Json?` | a set of field/section keys the admin edited, for the "edited by admin" UI marker + the regenerate warning. **[CONFIRM]** add it vs derive from `AuditLog` (§13 Q20) |

> **Recommendation:** prefer the `AuditLog` `artifact.edited` trail as canonical (no schema change)
> and add `editedFields` only if the per-load audit query proves too chatty. If added, it is
> additive + nullable → safe `prisma migrate deploy`.

### 6.3 `adminApproved` semantics + the Story 17 gate

`adminApproved = true` means "the script and storyboard are approved for video assembly." Story 17
(assembly) reads this as its gate — it does **not** assemble an `AI_ROUTED` event until
`adminApproved` is true (so the admin reviews/edits the AI plan first). **[CONFIRM]** whether
toggling `adminApproved` on **enqueues** Story 17 assembly directly (the seam, mirroring Story
12's `AI_ROUTED → storyboard` handoff) or whether assembly is a separate explicit "Generate video"
admin action (recommend the explicit action for cost control + clarity — §13 Q13). Either way,
Story 16 only **writes** the flag; the assembly enqueue is Story 17's concern (the seam is noted).

### 6.4 Migration notes

- **Expected: no new model migration in Story 16** — `AiArtifact` (with all columns above) exists
  from Story 11 / `architecture.md` §7.1. Run `prisma generate` only.
- If `AiArtifact` is **missing** (Story 11 divergence) → add the full §7.1 `AiArtifact` model
  (additive, nullable). Reconcile with Story 11's migration ownership (Story 11 §6.4 Q4).
- If the optional `editedFields` (§6.2) or a dedicated `updatedAt`/optimistic-version column
  (§5.10) is confirmed → an additive nullable migration `add_aiartifact_edit_fields`. Additive +
  nullable → safe `prisma migrate deploy` against `swara_prd`, no backfill.
- **No new dedup/`JobRun` table** — Story 9 §6.2's decision holds (BullMQ `jobId` + output-by-key
  overwrite + the serialized storyboard queue are sufficient; the only admin side effects are
  audited via `AuditLog`).

---

## 7. External services / integrations / config

### 7.1 Anthropic — Opus (storyboard) + Sonnet (narration/intro/outro)

- **No new SDK** — reuse Story 11's `@anthropic-ai/sdk` wrapper. Story 16 imports the **wrapper**
  (`runPrompt`), never the SDK directly (Story 11 §7.1).
- **Models:** `config.ai.opusModel` (default `claude-opus-4-7`; **`claude-sonnet-4-6` in dev** per
  development-setup §4) for the storyboard; `config.ai.sonnetModel` (`claude-sonnet-4-6`) for
  narration/intro/outro. Selected via the wrapper's `tier` option (§5.1).
- **Auth/cost:** `config.ai.anthropicApiKey` (never `process.env` outside `src/config/`). The
  storyboard's Opus call is the single most expensive AI call per event (`architecture.md` §5
  "Opus's deeper reasoning is worth the extra dollar once") — the serialized `storyboard` queue
  (§5.8) and prompt caching (§5.7) are the cost controls.

### 7.2 Prompt caching

- Enabled per call via the shared-event-prefix breakpoint (§5.7); ON in dev (development-setup §4).
- Per-model cache scoping caveat in §5.7 (Opus cache ≠ Sonnet cache); build the prefix identically
  regardless. **[CONFIRM]** the SDK's prompt-caching surface / min-token threshold (Story 11 §7.2,
  §13 Q18).

### 7.3 OPUS_MODEL dev override

- `OPUS_MODEL=claude-sonnet-4-6` in `.env.development.local` (development-setup §4) → the storyboard
  runs on **Sonnet** in dev; real Opus is opt-in (`OPUS_MODEL=claude-opus-4-7`) when testing
  storyboard quality. In prod, the launch checklist sets `OPUS_MODEL=claude-opus-4-7`
  (development-setup §10). The wrapper records the **actual** model in `meta.model` →
  `modelVersions.opus`, so the recorded version is honest even in dev.

### 7.4 AI_MOCK_MODE + mocks

- `config.ai.mockMode` selects the `MockAiClient` (Story 11 §5.13). For Story 16 the mock must
  return **deterministic, schema-valid** storyboard / narration / intro-outro outputs keyed off
  the (approved) input set, so the whole chain runs offline in CI + seed:
  - **Mock storyboard:** orders the event's approved media deterministically (e.g. by relationship
    then `uploadedAt`), assigns default per-type durations, a fixed transition (`crossfade`), and a
    caption derived from the top quote — always satisfying `StoryboardSchema` (incl. id refines).
  - **Mock narration:** one section per storyboard clip, `text` drawn from the clip's top quote /
    text, `sources` set correctly → satisfies `NarrationSchema`.
  - **Mock intro/outro:** templated from `honoreeName` + `occasionType` → satisfies `IntroOutroSchema`.
  - **Subtitles** are non-LLM, so they run identically in mock mode (using the seeded Whisper
    mock JSON from Story 10).
  - **Failure injection:** a hook to make the mock return invalid output once (Story 11 §5.13) so
    the retry/validation path is unit-testable.
- `.env.test` sets `AI_MOCK_MODE=true` → CI runs the chain offline + deterministically.

### 7.5 `/prompts/` templates location

- `/prompts/storyboard/v1`, `/prompts/narration/v1`, `/prompts/intro_outro/v1`, each with its
  co-located Zod schema (Story 11 §5.3 pattern). The version registry gains the three ids (§5.2).

### 7.6 S3 artifact paths (`architecture.md` §7.2)

Story 16 writes via the storage service's `putObject` (Story 10 §7.3) to:

| Artifact | S3 key |
|---|---|
| Storyboard JSON | `events/{eventId}/artifacts/storyboard.json` |
| Narration script (markdown) | `events/{eventId}/artifacts/script.md` |
| Subtitles | `events/{eventId}/artifacts/subtitles.srt` |
| (Subtitle source) | reads `events/{eventId}/submissions/{submissionId}/transcripts/{mediaId}.json` (Story 10) |

The worker needs **read** (transcripts) + **write** (artifacts) on the event prefix; private ACL
(`architecture.md` §7.2). Script PDF/DOCX (`script.pdf`) is the export story's concern, not
Story 16 (§13 Q10). Local dev: MinIO.

### 7.7 Config — wire through BOTH config files

Most AI config (`anthropicApiKey`, `sonnetModel`, `opusModel`, `mockMode`) is **already added by
Stories 10/11** (development-setup §7's `ai` block). Story 16 confirms `opusModel` is now actually
**used** and adds the storyboard/script queue knobs + prompt-version pins.

**Add to `src/config/env.ts`** (raw reads only):

| Raw key | Source env var | Purpose |
|---|---|---|
| `WORKER_CONCURRENCY_STORYBOARD` | `process.env.WORKER_CONCURRENCY_STORYBOARD` (optional) | Override `storyboard` Worker concurrency (default **1** — serialized for Opus cost, `architecture.md` §8.1) **[CONFIRM expose]** |
| `WORKER_CONCURRENCY_SCRIPT` | `process.env.WORKER_CONCURRENCY_SCRIPT` (optional) | Override `script` Worker concurrency (default **2**) |
| (reuse) `OPUS_MODEL`, `SONNET_MODEL`, `ANTHROPIC_API_KEY`, `AI_MOCK_MODE` | — | already present from Stories 10/11 |

**Add to `src/config/index.ts`** — extend the `worker` block:

| Config field | Type | Mapping / default |
|---|---|---|
| `worker.concurrency.storyboard` | `z.coerce.number().int().positive()` | `WORKER_CONCURRENCY_STORYBOARD` ?? **1** |
| `worker.concurrency.script` | `z.coerce.number().int().positive()` | `WORKER_CONCURRENCY_SCRIPT` ?? **2** |
| (reuse) `ai.opusModel` / `ai.sonnetModel` / `ai.anthropicApiKey` / `ai.mockMode` | — | from Story 11; `anthropicApiKey` required only when `mockMode === false` (Story 11 §7.5) |

Prompt-version pins live in the `/prompts` registry (in-code, §5.2), not env. Confirm `.env.example`
already documents `OPUS_MODEL`/`SONNET_MODEL`/`ANTHROPIC_API_KEY`/`AI_MOCK_MODE` (it does,
development-setup §7); add the two queue-concurrency vars under the Workers block. **[CONFIRM]**
exact defaults.

### 7.8 New npm dependencies

- **None expected** — `@anthropic-ai/sdk` (Story 11), `bullmq` (Story 9), `zod`, the storage
  service (Story 6/9/10) are all present. An `.srt` is plain text assembled in-code (no library
  needed). **[CONFIRM]** whether a tiny SubRip/timecode helper is worth a dependency vs in-code
  (recommend in-code — `.srt` formatting is trivial).

---

## 8. Seed data

Extend the seed path so an `AI_ROUTED` event with generated artifacts exists locally + in CI
(deterministically, via `MockAiClient`, `AI_MOCK_MODE=true`):

- **An `AI_ROUTED` event** (status `AI_ROUTED`, `routingDecision = AI`) whose submissions are
  **approved** (Story 8) and **analyzed** (Story 11 seed: `sentiment`, `extractedQuotes`, `tags`)
  with **transcripts + Whisper mock JSON** (Story 10 seed) and **quality-scored media** (Story 9
  seed), so the storyboard/narration/subtitle inputs are all present.
- **Run the chain in mock mode** so the seeded `AiArtifact` has a deterministic `storyboardJson`
  (mock ordering), `narrationScript` (one section per clip), `introText`/`outroText`, and a
  `subtitles.srt` in MinIO — giving Story 7's admin detail realistic editable data.
- **Variety:** include at least one clip with a caption, one VOICE clip (so subtitles align from
  its transcript), one PHOTO (no subtitle cues), and a multi-section narration so the editable UI
  renders meaningfully.
- **Seed approach:** run through the queue once (demonstrates the `AI_ROUTED → chain` plumbing) +
  a direct-call fast path for speed (mirrors Story 11 §8 / §13). **[CONFIRM]**.
- **Dev recipe:** `docker compose up -d` (Redis + MinIO) → `AI_MOCK_MODE=true npm run seed` →
  `npm run workers` → the storyboard/script processors generate the chain offline. Real Opus needs
  `AI_MOCK_MODE=false` + `OPUS_MODEL=claude-opus-4-7` + `ANTHROPIC_API_KEY` (document the cost).

---

## 9. Testing

Follows the Story 1/9/10/11 pattern (Vitest, `tests/unit` + `tests/integration`). Integration
needing real Redis/MinIO is guarded by **`SKIP_INTEGRATION`**; real-Anthropic is **gated** behind
`RUN_REAL_AI` (never default CI).

### 9.1 Unit (no infra; mock client + fixtures)

| Test | Asserts |
|---|---|
| **Zod — storyboard valid** | a well-formed `StoryboardSchema` output (valid transitions, in-bounds durations, ids in the approved set, `total_duration_sec` ≈ Σ) **passes** |
| **Zod — storyboard invalid (each mode)** | unknown `transition_in`, out-of-bounds `duration_sec`, invented `submission_id`/`media_item_id`, duplicate `media_item_id`, total mismatch → each **fails** |
| **Zod — narration valid/invalid** | valid sections (each `clip_ref` resolves, `text` non-empty) pass; a `clip_ref` to a non-existent clip / empty `text` fails |
| **Zod — intro/outro valid/invalid** | non-empty + within length cap pass; empty/over-cap fail |
| **Prompt-caching prefix stability** | the rendered storyboard, narration, and intro/outro requests for **one event** carry a **byte-identical cached prefix** segment (the shared event prefix), and **different** variable suffixes; the prefix differs across **different events** |
| **Model selection per task** | `generateStoryboard` calls the wrapper with `tier: 'opus'` (→ `config.ai.opusModel`); narration + intro/outro with `tier: 'sonnet'` (→ `config.ai.sonnetModel`); `meta.model` recorded per call |
| **Retry on parse fail** | injected invalid output → wrapper retries up to `promptParseRetries` then throws; the job fails; the `AiArtifact` column is **not** partially written |
| **Retry then success** | bad output once, valid on retry → result returned; `meta.attempts === 2` |
| **Subtitle alignment math** | given a storyboard `sequence` (offsets) + per-media Whisper word JSON, the emitted `.srt` cues land at the correct **timeline** times (`offset + (word − clip_start)`), valid SubRip timecodes, sorted, PHOTO/no-transcript clips contribute nothing |
| **Mock determinism** | the mock storyboard/narration/intro for the same approved set is byte-identical across runs and always schema-valid |
| **Version recording (merge)** | persistence merges `modelVersions.opus`/`.sonnet` + `promptVersions.storyboard`/`.narration`/`.intro_outro` **without clobbering** Story 11's `.analysis`/`.sonnet`/`.whisper` |
| **Idempotency key** | `buildJobKey()` → `{eventId}::storyboard.generate` (etc.); stable; distinct per job type |
| **Admin-edit persistence** | a Save overwrites the `AiArtifact` column (and S3 mirror); `editedFields`/audit records the edit; a re-load reflects the edit |
| **Edit-vs-regenerate conflict** | Regenerate overwrites an admin-edited artifact (with the warning surfaced); a Save against a stale `generatedAt` is rejected (`ARTIFACT_STALE`) |
| **No-approved-media** | the storyboard job no-ops without calling the model (§5.11 / §13 Q24) |

> Keep the alignment + the persistence/merge as **pure functions** (`buildSrt(sequence,
> wordJsonByMedia) → srtString`; `mergeVersions(existing, patch)`) fed fixtures, so they unit-test
> without S3/DB/API.

### 9.2 Integration (`SKIP_INTEGRATION` guards real Redis + MinIO; `AI_MOCK_MODE=true`)

| Test | Flow |
|---|---|
| **AI_ROUTED → generate[mock] → AiArtifact (happy path)** | Seed an `AI_ROUTED` event w/ approved analyzed submissions + Whisper mock JSON → enqueue `storyboard.generate` (or simulate the Story 12 trigger) → run the workers (mock) → assert the full chain ran: `AiArtifact.storyboardJson`/`narrationScript`/`introText`/`outroText` populated, `modelVersions`/`promptVersions` merged, and S3 `artifacts/storyboard.json`/`script.md`/`subtitles.srt` exist |
| **Chain ordering** | assert narration ran **after** storyboard persisted (its `clip_ref`s match the stored storyboard) and subtitles after both |
| **Idempotent re-enqueue** | enqueue `storyboard.generate` twice → one chain runs / final artifacts identical; `AiArtifact` not duplicated |
| **Storyboard serialization** | two `AI_ROUTED` events enqueued → assert at most one `storyboard` job active at a time (concurrency 1) |
| **Downstream failure isolated** | force the narration mock to fail → assert `storyboardJson` persists, narration shows failed/partial, and is individually regenerable; chain doesn't roll back the storyboard |
| **Admin edit + regenerate** | edit the narration via the action → Save → assert persisted; Regenerate narration → assert overwrite + the warning path; stale Save rejected |
| **Deleted-event no-op** | enqueue, delete the event (cascade) before run → job no-ops success |

### 9.3 Real-API (gated, never default CI)

| Test | Flow |
|---|---|
| **Real Opus + Sonnet smoke** | `AI_MOCK_MODE=false` + `OPUS_MODEL=claude-opus-4-7` + real key → run the chain on one fixture event → assert each output **validates** (schemas pass), cache read/creation tokens recorded, `modelVersions.opus === 'claude-opus-4-7'`. Shape only, not exact content |
| Gating | runs only when `RUN_REAL_AI=true` (+ `SKIP_INTEGRATION` honored); documented as a manual/nightly check (development-setup §11) |

CI: unit always (mock); integration where Redis/MinIO available else `SKIP_INTEGRATION=true`;
real-AI never in default CI.

---

## 10. Security

- **No honoree exposure / no honoree communication.** Generation sends event + contributor content
  to Anthropic; it must **never** include `Event.honoreeEmail` or any honoree contact, and triggers
  **no** contributor/honoree communication (`architecture.md` §10.1). The honoree **name** appears
  in the prompt (the video is *about* them, and intro/outro use it) — that is inherent and
  acceptable; honoree **email/contact** is never added. The artifacts are admin-only (Story 7
  gate), never honoree-facing.
- **PII in prompts.** Contributor free text + transcripts + quotes (names, personal stories) are
  **sent to Anthropic by design** (the storyboard/narration require the content). Mitigations:
  do **not** log prompt content or model output text at info level (log ids + token counts +
  validation pass/fail only — §11, mirroring Story 11 §10); rely on Anthropic data-handling terms;
  recommend **no** content redaction (it degrades the creative output) but **never** logging it.
- **Prompt-injection on contributor text.** Contributor text/transcripts/quotes are **untrusted
  input embedded in the prompt** — a contributor could write "ignore your instructions…".
  Mitigations (reuse Story 11 §10):
  - The cached prefix's **system instruction** states contributor content is **data to plan
    from, not instructions to follow**, and the model must emit **only** the JSON contract.
  - Contributor content sits in the **shared prefix / variable suffix** as clearly delimited,
    labeled **data** (escaped/wrapped), never in the instruction region.
  - **Zod + cross-validation is the backstop** (§5.5.5): the output must match the closed schema
    and reference only **real approved ids** — an injected instruction can't produce a valid
    storyboard that invents media or breaks the transition vocabulary; out-of-contract output is
    rejected → retry → failed job (no corrupt write), not a poisoned artifact.
  - **[CONFIRM]** the exact delimiter/escaping convention (shared with Story 11 §13 Q5).
- **Secrets.** `ANTHROPIC_API_KEY` lives only in worker/host env via `config.ai` (`architecture.md`
  §16); never in queue payloads (ids only — §5.8) or logs.
- **S3 artifacts are private ACL** (`architecture.md` §7.2); admin downloads (if any) use
  presigned GET (Story 7/8); the artifacts are not CDN/public.

---

## 11. Observability / audit

Per `architecture.md` §13 ("AI calls: model, prompt version, token counts, latency, output
validation pass/fail"). Reuse Story 11's metric-shaped logging; wire OpenTelemetry in the
observability story.

**Metrics (per call / per job):**

| Metric | Dimensions | Why |
|---|---|---|
| Input / output tokens | model, promptId@version | cost — **Opus storyboard is the single most expensive call per event** (`architecture.md` §5); track it closely |
| Cache read / creation tokens | model, promptId@version | prompt-cache hit rate across the chain (§5.7 efficacy) |
| Call latency (ms) | model, promptId@version | spot slow Opus calls / rate-limit symptoms |
| **Output validation pass/fail** | promptId@version, failure_reason | `architecture.md` §13; tune the prompt when fail rate rises |
| Retry / attempt count | scope (wrapper parse vs job) | detect flaky output / prompt drift |
| Rate-limit / 429 occurrences | model | feeds the "sustained Claude 5xx/429" alert (`architecture.md` §13) |
| `storyboard` / `script` queue depth | queue | the serialized storyboard queue can back up near busy delivery days; autoscaling (`architecture.md` §12) |
| Chain outcome | step (storyboard/narration/intro/subtitles), result (success/partial/failed/skip) | pipeline health |
| Subtitle cue count + clips-with/without-transcript | event | data-quality signal for the alignment step |

**Recorded for correlation (`AiArtifact`):** `modelVersions` (`opus`/`sonnet` — the **actual**
models, so dev-Sonnet-as-Opus is visible) and `promptVersions` (`storyboard`/`narration`/
`intro_outro`) — so output quality can later be correlated with prompt/model changes
(`architecture.md` §7.1).

**Structured logs** (Story 1 `logger`): job start (`eventId`, `queue`, `jobId`, step), result
(model, promptVersion, tokens, cache tokens, latency, attempts, validation pass/fail, cue count),
retries, failures (error class, attempt n). **Never** log prompt content, contributor text,
transcripts, quotes, or model output text (PII — §10).

**Trace correlation:** include `event_id` as a span/log attribute so an event traces
form-submit → … → analyze → routing → **storyboard → narration → intro/outro → subtitles** →
(Story 17) assembly.

**Audit (`AuditLog`, Story 8 pattern):** generation itself is system-internal (no audit row
required for the happy path — mirrors Story 11 §11). **Admin actions are audited:** `artifact.edited`
(Save, with edited fields), `artifact.approved` / `artifact.unapproved` (the `adminApproved`
toggle), and `artifact.regenerated` (a Regenerate action, with which artifact). **[CONFIRM]**
the exact action names + whether Regenerate is audited (recommend yes — it can overwrite admin
edits and spends Opus/Sonnet, §13 Q25).

---

## 12. Definition of done

- [ ] Story 16 reuses Story 11's `runPrompt` wrapper (Zod validation, retry, token/version logging,
      prompt caching, client factory + `MockAiClient`); it adds **no** new AI client/infra.
- [ ] **Versioned prompts** `storyboard@v1`, `narration@v1`, `intro_outro@v1` live in `/prompts/`
      with co-located Zod schemas; the version registry pins them; pinned versions are recorded in
      `promptVersions`.
- [ ] **`StoryboardSchema`** (sequence[] of `{submission_id, media_item_id, media_type,
      duration_sec, clip_note, transition_in, caption?}` + `total_duration_sec` + `pacing_notes`),
      **`NarrationSchema`** (editable sections), **`IntroOutroSchema`** enforce closed vocabularies,
      bounds, and **id cross-validation against the approved set**; invalid output rejected.
- [ ] **Model assignment:** storyboard → Opus (`config.ai.opusModel`, Sonnet in dev) on the
      `storyboard` queue (concurrency 1); narration + intro/outro → Sonnet (`config.ai.sonnetModel`)
      on the `script` queue (concurrency 2).
- [ ] **Shared cached event prefix** built once per event; identical bytes across the chain's
      calls; `cacheRead`/`cacheCreation` tokens recorded; per-model scoping caveat documented.
- [ ] **Event-level chain** fires on `Event.status = AI_ROUTED` (the Story 12 seam), runs
      storyboard → narration → intro/outro → subtitles, serialized; backfill query noted.
- [ ] **Subtitles** `.srt` produced by aligning Whisper word timestamps (Story 10) to storyboard
      clip windows; written to S3 `artifacts/subtitles.srt`.
- [ ] **Persistence:** `AiArtifact.storyboardJson`/`narrationScript`/`introText`/`outroText`
      written; `modelVersions`/`promptVersions` **merged** (not clobbering Story 11); S3
      `storyboard.json`/`script.md`/`subtitles.srt` written; overwrite-by-key idempotent.
- [ ] **Admin-edit surface** on `/admin/events/[id]`: editable narration / intro / outro /
      storyboard ordering+captions+transitions, Save, Regenerate (per-artifact + all),
      `adminApproved` toggle; edits persist; the regenerate-vs-edit conflict rule + stale-edit
      guard honored; actions audited.
- [ ] **Idempotency** via `{eventId}::{job_type}` keys; payloads ids only; storyboard serialized
      (concurrency 1) for Opus cost.
- [ ] **Retry:** wrapper parse-retry (2) + job attempts (3, exp backoff); rate-limit backoff cap
      5 min; chain-failure semantics (storyboard fail stops chain; downstream fail isolated).
- [ ] **Config:** `OPUS_MODEL` now **used** (Sonnet in dev); `storyboard`/`script` concurrency
      knobs in **both** config files; `.env.example` updated; no `process.env` outside `src/config/`.
- [ ] **Mock client** returns deterministic, schema-valid storyboard/narration/intro for the chain;
      failure-injection hook for the retry test; whole chain runs offline in `AI_MOCK_MODE`.
- [ ] **Seed** produces an `AI_ROUTED` event with approved/analyzed submissions + a mock-generated
      storyboard/script/subtitles so the admin detail renders editable artifacts; offline recipe
      documented.
- [ ] **Tests:** unit (Zod per artifact, caching prefix stability, model selection, retry, subtitle
      alignment math, admin-edit persistence + conflict, version-merge) + integration
      (AI_ROUTED→generate[mock]→AiArtifact, ordering, serialization, downstream-fail isolation,
      idempotent re-enqueue, deleted-event no-op); real-AI gated by `RUN_REAL_AI`; `SKIP_INTEGRATION`
      honored.
- [ ] **Metrics-shaped logs** (tokens incl. Opus, cache tokens, latency, validation pass/fail,
      attempts, queue depth, chain outcome, cue count) emitted; **no** prompt/content/output text
      in logs.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; no TODOs in committed code.

---

## 13. Open questions / assumptions

| # | Item | Recommendation / default | Needs |
|---|---|---|---|
| Q1 | **Intro/outro: separate Sonnet call vs a section of the narration call** | Separate small `intro_outro` call (independent regen; narration prompt stays focused) | **[CONFIRM]** |
| Q2 | **Subtitle alignment approach** (the brief calls this out) — combined `.srt` vs per-clip; cue grouping (sentence/pause/max-chars); source in/out window | One combined `subtitles.srt` on the final-video timeline (`architecture.md` §7.2); group by sentence/pause with a max-chars cap; assume `clip_source_start = 0` for `duration_sec` (no trim) in MVP 1 | **[CONFIRM]** (ties to Q9) |
| Q3 | **Does Story 16 run for `MANUAL_ROUTED` events?** | No — only `AI_ROUTED`. Manual events get artifacts only if generated before a switch; the manual brief (Story 13) reuses whatever exists | **[CONFIRM]** |
| Q4 | **Trigger wiring** (after-commit enqueue from Story 12's Approve-AI vs status-watch sweep) + backfill | After-commit enqueue (the Story 12 seam) **+** a minimal `AI_ROUTED & storyboardJson IS NULL` backfill (cron deferred to Story 18) | **[CONFIRM]** |
| Q5 | **Chain shape** — strict linear vs intro/outro parallel with narration | Linear in MVP 1 (simplest; narration needs the storyboard anyway) | **[CONFIRM]** |
| Q6 | **Queue for the non-LLM `subtitles.align` step** | `script` queue (no new queue; IO-light) | **[CONFIRM]** |
| Q7 | **Storyboard sequence bounds + text/title cards** — cap on clips; whether `text` cards get synthetic `media_item_id`; unique-media constraint | Cap ≈ approved-media count + a few title cards; `text` cards use a synthetic/null id pattern; media unique within sequence | **[CONFIRM]** |
| Q8 | **Storyboard duration heuristics** (the brief calls this out) — per-type defaults + target total | Per-type defaults (photo 3–5s, video trimmed, voice = message length, text 2–4s); target total from clip count/`musicMood`; heuristics versioned in-code; schema enforces per-clip bounds + total cross-check | **[CONFIRM]** values |
| Q9 | **Clip source in/out point** — `StoryboardSchema` has `duration_sec` but no source start | Assume source from 0 for `duration_sec` (or full clip) in MVP 1; add `source_start_sec` (additive) if trimming is needed — must match Story 17 trim + Q2 subtitle math | **[CONFIRM]** |
| Q10 | **Script export format** (`script.md` here; `script.pdf`/DOCX in `architecture.md` §7.2 export) | Story 16 writes `script.md` + `storyboard.json` + `subtitles.srt`; PDF/DOCX rendering is the export story (Story 14/15) | **[CONFIRM]** ownership |
| Q11 | **How the admin UI learns the chain finished** | Server-component reads persisted `AiArtifact` per load + a Refresh affordance; live push deferred | **[CONFIRM]** |
| Q12 | **Save granularity** (per-field vs whole-section vs whole-artifact) | Per-artifact Save (narration as one unit, storyboard as one unit) for MVP 1 simplicity | **[CONFIRM]** |
| Q13 | **`adminApproved` ON → enqueue Story 17 assembly automatically?** | No — assembly is a separate explicit admin action (cost control + clarity); `adminApproved` is the gate Story 17 reads | **[CONFIRM]** |
| Q14 | **When do artifacts lock (become read-only)?** | Editable until `adminApproved` (or assembly starts); read-only recap after | **[CONFIRM]** |
| Q15 | **Transition vocabulary (closed enum)** | `cut`, `crossfade`, `fade_in`, `dip_to_black`, `slide` (must match Story 17's FFmpeg transition support) | **[CONFIRM]** with Story 17 |
| Q16 | **Narration section ↔ clip mapping** (every clip has a section vs looser overlay; `full_text` derived vs returned) | Looser overlay (sections may reference clips or be global); derive `full_text`/`script.md` in-code from sections | **[CONFIRM]** |
| Q17 | **Intro/outro length cap** | Short title-card length (e.g. ≤ ~140 chars each) | **[CONFIRM]** |
| Q18 | **Prompt-cache per-model scoping + SDK surface** | Opus cache ≠ Sonnet cache; build the prefix identically to capture intra-tier hits; pin an SDK version that supports caching; no-op gracefully below the min-token threshold | **[CONFIRM]** |
| Q19 | **Global Opus limiter across worker replicas** | Not in MVP 1 — concurrency 1 per process + modest replica count; distributed limiter only if cost spikes | **[CONFIRM]** |
| Q20 | **Admin-edit provenance** (`AiArtifact.editedFields` column vs `AuditLog` trail) | `AuditLog` `artifact.edited` canonical; add `editedFields` only if per-load audit query is too chatty | **[CONFIRM]** |
| Q21 | **Edit-vs-regenerate conflict policy** (the brief calls this out) | Regenerate **overwrites** admin edits with an explicit warning; no auto-merge; block regenerate only while a job is active | **[CONFIRM]** |
| Q22 | **Stale-edit guard** (optimistic version) | Carry `generatedAt`/`updatedAt` on Save; reject if it changed under the admin (`ARTIFACT_STALE`) | **[CONFIRM]** add a dedicated `updatedAt` |
| Q23 | **Storyboard edit ripple to narration/subtitles** | Save the storyboard edit as-is + a calm "regenerate script/subtitles to realign" warning; no auto-regen (avoids surprise cost) | **[CONFIRM]** |
| Q24 | **`AI_ROUTED` event with no approved media** | Storyboard job no-ops without calling the model; flag for admin attention | **[CONFIRM]** |
| Q25 | **Audit Regenerate actions** | Yes — Regenerate is audited (`artifact.regenerated`); it can overwrite admin edits and spends Opus/Sonnet | **[CONFIRM]** |
| Q26 | **`AiArtifact` model/migration ownership** (Story 11 vs here) | Story 11 owns it; Story 16 only populates the remaining columns (no model migration unless divergence / optional edit-provenance column) | **[CONFIRM with Story 11]** |
