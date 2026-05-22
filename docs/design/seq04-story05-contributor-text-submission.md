# Sequence 04 / Story 5 — Contributor Text-Only Submission

**Design document — implementation-level specification. NO CODE.**
This document is the contract for later code generation. Every field, route, validation
rule, and error case below is binding. Where something is genuinely undecided it is flagged
in §13 (Open Questions / Assumptions), not silently chosen.

| Meta | Value |
|---|---|
| Story number / title | Story 5 — Contributor text-only submission |
| Sequence number | 04 |
| Epic | C — Submission Collection |
| Depends on | Story 3 (Event creation: `Event` model, slug, `EventStatus`) |
| Parallel with | Story 4 (Stripe payment) |
| Unlocks | Story 6 (Media uploads), Story 7 (Admin dashboard), Story 20 (Right to delete) |
| Complexity | M (1–3 days) |

---

## 1. Story Summary

Build the **public contributor submission form** — the first place a person who is *not*
the organizer or admin touches the product. A contributor opens an unguessable event link,
sees an occasion-aware form, writes their wishes/memories/advice as free text, ticks a
mandatory consent box, and submits. The system records the submission as `PENDING` with a
consent timestamp and the submitter's IP, enforces the submission deadline (hard close),
and enforces **one submission per email per event**.

This story is **text only**. No file uploads of any kind. The `Submission` row is designed
so that Story 6 can attach a `MediaItem[]` relation with zero changes to the columns added
here. Per architecture §7.1, the `Submission` model's final shape already contains
`mediaItems MediaItem[]`; this story adds every field **except** the `MediaItem` relation
and table — those land in Story 6.

The form is **public — no authentication**. Access control for this surface is "knowing the
slug," combined with deadline + status gating, rate limiting, and one-per-email. The honoree
is never exposed beyond their name as the subject of the tribute, and never contacted.

---

## 2. Scope

### In scope
- Public route to **load** the contributor form: `/contribute/[slug]`.
- Public **submit** action accepting: full name, relationship to honoree, text message,
  funny memory, advice/blessing, professional note (business occasions only), email,
  mandatory consent.
- Occasion-aware (business vs personal) **adaptive field labels**.
- Validation: **at least one non-empty text field**, **mandatory consent**, well-formed
  email, length bounds.
- **Deadline enforcement** — form hard-closes at `submissionDeadline`; closed state UI.
- **Event-status gating** — form only renders/accepts when the event is collecting.
- **One submission per email per event** via DB unique constraint, handled gracefully.
- Record `consentAt`, `submittedAt`, `ipAddress`; set `status = PENDING`.
- **Thank-you / confirmation** page after a successful submit.
- Responsive layout, brand styling, and accessibility.
- `Submission` table + `SubmissionStatus` enum added to the Prisma schema (no `MediaItem`).
- Per-IP rate limiting on the submit action.
- Seed data: sample submissions across statuses for a seeded event.

### Out of scope (deferred)
| Item | Lands in |
|---|---|
| **Media uploads** (video / voice / photo), presigned URLs, `MediaItem` table | Story 6 |
| AI pipeline (transcription, sentiment, quotes, quality, tags) on the submission | Stories 9–11 |
| `overallQualityScore`, `transcript`, `sentiment`, `extractedQuotes`, `tags` columns | Story 6 / 9–11 (see §6 note) |
| Admin review / approve / reject UI for these submissions | Stories 7–8 |
| **Self-service deletion link** in the confirmation email (`deletionToken`) | Story 20 |
| Contributor **confirmation email** send (Resend) | Story 20 / 18 (see §7) |
| 48h/24h reminder emails to non-submitters | Story 18 |
| CAPTCHA for very large events (>100 contributors) | Future (flagged §10) |
| WhatsApp share of the contributor link | Story 3 (organizer side) |

---

## 3. Dependencies & Sequence

### Must already be on `main`
- **Story 1 (Foundation):** typed `config` module (`src/config/env.ts` + `src/config/index.ts`),
  Prisma client singleton (`src/lib/db.ts`), logger, Redis client (`src/lib/redis.ts`), CI.
- **Story 3 (Event creation):** the `Event` model with `slug @unique`, `occasionType`
  (`OccasionType` enum), `submissionDeadline DateTime`, `status` (`EventStatus` enum),
  `honoreeName`, and the `submissions Submission[]` back-relation placeholder.

> **Dependency flag.** As of this writing the live `prisma/schema.prisma` contains **only**
> the `User` model — Story 3's `Event` model is not yet physically present. This design assumes
> Story 3 lands the `Event` model exactly as specified in architecture §7.1 (notably `slug`,
> `occasionType`, `submissionDeadline`, `status: EventStatus`). If Story 3's field names differ,
> reconcile §6 against the merged Story 3 schema before generating code. The doc
> `docs/design/seq03-story03-event-creation.md` was **not present** when this was written, so
> slug/status semantics are taken from architecture §7.1.

### Sequence relative to siblings
- Parallel with **Story 4 (Stripe)**. Story 5 does **not** require payment. See §13 Q1 for the
  open question of whether the form should require `EventStatus = ACTIVE` (which only Story 4
  sets via webhook) or also accept a pre-payment collecting state. This doc's default: gate on
  a defined "collecting" status set — see §5.1.

### What this unlocks
- **Story 6** attaches `MediaItem[]` and relaxes the "≥1 text field" rule to "≥1 media item OR
  ≥1 text field" (the full requirements §5.2 rule).
- **Story 7/8** read these `Submission` rows for the admin dashboard and approval flow.
- **Story 20** adds `deletionToken` + the self-service deletion link.

---

## 4. Frontend / UI Design

### 4.1 Route

| Concern | Decision |
|---|---|
| Public form path | **`/contribute/[slug]`** (confirmed; matches Story 5 row in `stories.md`) |
| Rendering | Server Component page that loads the event by slug (server-side), then renders the form (client component) or the closed-state panel |
| Submit mechanism | **Next.js Server Action** (App Router), co-located with the form. No REST route. See §5 |
| Auth | **None** — public. No session, no NextAuth check |
| Indexing | `noindex, nofollow` meta + `Referrer-Policy: no-referrer` (surprise integrity — see §10) |

The slug is the only access token. An invalid or unknown slug renders a generic
"This link isn’t valid" state (see §4.5) — it must **not** reveal whether the slug ever existed
(no enumeration signal) and must **not** show the honoree name.

### 4.2 Load-form behavior (page render)

On GET of `/contribute/[slug]`, the server resolves the event and renders **one of four states**:

| State | Condition | Renders |
|---|---|---|
| **Open form** | Event exists AND status ∈ collecting set AND `now < submissionDeadline` | The full contributor form (§4.3) |
| **Deadline closed** | Event exists AND `now ≥ submissionDeadline` | Closed panel (§4.5) |
| **Not collecting** | Event exists but status ∉ collecting set (e.g. DRAFT, IN_REVIEW, DELIVERED) | Generic "not accepting submissions" panel (§4.5) |
| **Not found** | No event for slug | Generic "link not valid" panel (§4.5) |

"Collecting set" is defined in §5.1. The honoree name is shown **only** in the Open and
Deadline-closed states (the contributor legitimately needs to know whose tribute this is). It is
**not** shown in Not-collecting or Not-found states.

### 4.3 Form fields

All text fields are free text. Field-level rules in §5.4. "Adaptive label" column gives the
label shown when the occasion is a **business** occasion (see §4.4 for which occasions count).

| # | Field (internal name) | Type | Required | Personal label | Business (adaptive) label | Max length |
|---|---|---|---|---|---|---|
| 1 | `contributorName` | single-line text | **Yes** | "Your name" | "Your name" | 120 |
| 2 | `relationship` | single-line text | **Yes** | "Your relationship to {honoreeName}" | "Your role / connection" | 120 |
| 3 | `email` | email | **Yes** (see §13 Q3) | "Your email" | "Your email" | 254 |
| 4 | `textMessage` | multi-line text | conditional¹ | "Your message" | "Your message" | 5000 |
| 5 | `funnyMemory` | multi-line text | conditional¹ | "A funny memory" | "A highlight / achievement" | 5000 |
| 6 | `advice` | multi-line text | conditional¹ | "Advice or a blessing" | "Advice or words for the road ahead" | 5000 |
| 7 | `professionalNote` | multi-line text | conditional¹, **business only** | *(hidden)* | "A professional note" | 5000 |
| 8 | `consentGiven` | checkbox | **Yes (mandatory)** | "I consent to my submission being used in the tribute video." | same | n/a |

¹ **Conditional** = none of the four content fields is individually required, but **at least one
of fields 4–7 must be non-empty** (the at-least-one-field rule, §5.4). For personal occasions,
field 7 (`professionalNote`) is not rendered and is ignored on submit.

Notes:
- `honoreeName` is interpolated into the relationship label (personal occasions) exactly as the
  organizer stored it — never re-capitalized or abbreviated (branding §10 "honoree's name is
  sacred").
- Email is collected to enforce one-per-email and (later, Story 18/20) to send the confirmation
  /deletion link. See §13 Q3 on whether email is mandatory in MVP vs device-fingerprint.
- The consent label text is fixed copy (requirements §5.2); do not paraphrase.

### 4.4 Adaptive-label logic

| Input | Rule |
|---|---|
| Which occasions are "business"? | `occasionType ∈ { BUSINESS_EVENT }` for the MVP default. Requirements §5.2 *also* names `ANNIVERSARY` as a business-style occasion for the **professional note** specifically. See §13 Q2. |
| Where computed | Server-side at page render, from `event.occasionType`. The boolean `isBusiness` is passed to the form so labels render correctly without a client round-trip. |
| `professionalNote` visibility | Rendered **only** when `isBusiness` is true. Hidden + omitted otherwise. |
| Label set | Personal labels by default; business labels when `isBusiness`. Single source of truth: a label map keyed by `isBusiness`. Unit-tested (§9). |

**Decision for this doc:** treat `BUSINESS_EVENT` as the business occasion for *all* adaptive
labels, AND additionally show `professionalNote` for `ANNIVERSARY` (per the explicit requirements
list). This split is flagged in §13 Q2 for confirmation; if simplification is preferred, gate
everything on `BUSINESS_EVENT` only.

### 4.5 Non-form states (copy)

Brand voice: warm, calm, clear, **no exclamation marks** in transactional copy (branding §10).
Occasion-aware where the honoree name is known.

| State | Heading | Body | CTA |
|---|---|---|---|
| Deadline closed | "Submissions for {honoreeName}’s {occasion} have closed." | "Thank you for wanting to take part. The collection window ended on {deadline, long form}." | none |
| Not collecting | "This tribute isn’t collecting submissions right now." | "If you have the link from the organizer, check back soon." | none |
| Not found | "This link isn’t valid." | "Double-check the link from your invitation, or ask the organizer to resend it." | none |

`{occasion}` renders as a friendly noun ("graduation", "wedding", "anniversary", "birthday",
"retirement", "business event") mapped from `occasionType`. Deadline is shown in long
celebratory form per branding §10 ("Saturday, May 17, 2026, 6:00 PM").

### 4.6 Thank-you / confirmation page

Shown after a successful submit. Two acceptable implementations (pick one in build, see §13 Q4):
(a) redirect to `/contribute/[slug]/thank-you`, or (b) render an inline success state replacing
the form. **Default: dedicated route `/contribute/[slug]/thank-you`** so a refresh is safe and
the form cannot be re-posted on reload.

| Element | Content |
|---|---|
| Heading | "Your message for {honoreeName}’s {occasion} is in." |
| Body | "Thank you for taking the time — these are the moments that make a tribute feel like home." (branding §11 example) |
| Edit/delete note | "You can submit only once per event." Self-service edit/delete link is **Story 20** — until then no edit/delete affordance is shown. |
| No honoree contact | The page never offers to "notify the honoree" and never shows other contributors' content. |

The thank-you route must not be reachable as a way to confirm a submission exists for a given
email (no lookup) — it is a static celebratory page only.

### 4.7 Responsive & branding
- Single-column, mobile-first; comfortable max width (~640px) on desktop.
- Fonts: Fraunces (display/headings), Inter (body) — already wired in `src/app/layout.tsx`.
- Palette: brand tokens (`--brand-ivory` background, `--brand-ink` text, `--brand-deep-saffron`
  primary CTA), per branding §4. Submit button uses the primary accent.
- Signature gradient is **not** used here (reserved for hero / delivery moments, branding §4).
- Co-brand "by Swara Media" footer lockup (branding §6).

### 4.8 Accessibility
- Every field has a programmatically associated `<label>`; the consent checkbox label is
  clickable.
- Validation errors are associated to inputs via `aria-describedby` and announced via an
  `aria-live="polite"` region; first invalid field receives focus on failed submit.
- Color is never the only error signal (icon + text alongside the error color).
- All interactive targets meet WCAG AA contrast (branding §4 guarantees ivory+ink and
  saffron+ink pairs pass).
- Keyboard-only completion of the entire form, including submit, is possible.
- Required fields marked with `aria-required` and a visible required indicator.

---

## 5. Backend / API Design

Two server-side entry points: **load** (page render) and **submit** (Server Action). Both are
public. No REST API routes are introduced.

### 5.1 Load-form (server-side, on page render)

| Step | Behavior |
|---|---|
| 1 | Look up event by `slug` (unique). If none → render **Not found** state. |
| 2 | Check `status ∈ collecting set`. If not → render **Not collecting** state. |
| 3 | Check `now < submissionDeadline`. If not → render **Deadline closed** state. |
| 4 | Otherwise render the open form; pass `honoreeName`, `occasionType`, `isBusiness`, `slug`. |

**Collecting set (default):** `{ ACTIVE }`. Rationale: Story 4 activates an event
(`DRAFT → ACTIVE`) on Stripe webhook; only activated (paid) events should collect submissions.
Because Story 5 is parallel with Story 4 and may merge first, see §13 Q1 — if testing before
Story 4 exists, the seed/dev path may need a manually-set `ACTIVE` status or a temporary
allowance of an additional status. Do **not** widen the collecting set in production beyond what
surprise/payment integrity allows.

Comparisons use server time (UTC). `submissionDeadline` is stored as an absolute instant; the
deadline is a hard close at that instant (requirements §8, architecture §6.2).

### 5.2 Submit (Server Action)

| Concern | Decision |
|---|---|
| Mechanism | Next.js **Server Action** invoked from the form (`method=POST` semantics under the hood) |
| Auth | None (public) |
| Input | The eight form fields (§4.3) plus the `slug` (from route/hidden field) |
| Output (success) | Redirect to thank-you page (§4.6) |
| Output (failure) | Re-render form with field-level errors + a top-level summary; preserve entered values |
| Idempotency | Enforced by the `@@unique([eventId, email])` constraint — a duplicate submit is rejected, not duplicated |

**Server-side submit algorithm (authoritative order):**

1. **Resolve event** by slug. If not found → return generic "link not valid" error (do not 500).
2. **Re-check status** ∈ collecting set. If not → return "no longer accepting submissions" error.
3. **Re-check deadline**: `now < submissionDeadline`. If not → return "deadline passed" error.
   *(Deadline and status are re-checked server-side even though the page gated them at render —
   the page could have been open in a tab past the deadline.)*
4. **Validate payload** (§5.4). On any failure → return field errors; nothing is written.
5. **Enforce consent**: `consentGiven === true`, else consent error (redundant with validation;
   called out because it is mandatory and load-bearing for compliance).
6. **Enforce at-least-one-field**: at least one of `textMessage`, `funnyMemory`, `advice`,
   `professionalNote` (business only) is non-empty after trim. Else "empty submission" error.
7. **Rate-limit check** by IP (§5.5). If exceeded → return rate-limit error (status 429-equivalent).
8. **Resolve `ipAddress`** from request headers (first hop of `x-forwarded-for`, fallback to the
   connection IP). Stored for abuse detection only (architecture §7.1, §10.5).
9. **Insert** the `Submission` with:
   - `eventId` = resolved event id
   - all trimmed text fields (empty strings stored as `null`; `professionalNote` always `null`
     for personal occasions)
   - `consentGiven = true`, `consentAt = now`
   - `status = PENDING`
   - `submittedAt = now` (DB default acceptable)
   - `ipAddress`
10. **Handle unique violation**: if the insert fails on `@@unique([eventId, email])`
    (Prisma `P2002`), catch it and return the **duplicate-email** error gracefully (see §5.6) —
    do **not** surface a 500.
11. On success → redirect to thank-you page.

> **Note on enqueueing pipeline jobs.** Architecture §6.2 shows "enqueue pipeline jobs" after
> insert. In Story 5 there are no media and no worker jobs yet (BullMQ arrives in Story 9). This
> story enqueues **nothing**. The insert is the terminal action besides the redirect.

### 5.3 Payloads

**Submit input (conceptual — field names match §4.3):**

```
slug:             string   (route param / hidden)
contributorName:  string
relationship:     string
email:            string
textMessage:      string?  (may be empty)
funnyMemory:      string?
advice:           string?
professionalNote: string?  (present only for business occasions)
consentGiven:     boolean  (must be true)
```

**Validation is performed with a Zod schema** (project convention; Zod already a dependency).
The schema is shared/importable by the unit tests.

**Success result:** HTTP redirect (303-equivalent via Server Action) to
`/contribute/[slug]/thank-you`. No JSON body returned to the browser.

**Error result:** the action returns a structured result the form renders:
```
{ ok: false, formError?: string, fieldErrors?: { [field]: string } }
```

### 5.4 Validation rules

| Field | Rule | Error message (contributor-facing, calm voice) |
|---|---|---|
| `contributorName` | required, trimmed length 1–120 | "Please add your name." |
| `relationship` | required, trimmed length 1–120 | "Let us know how you know {honoreeName}." (business: "Let us know your role or connection.") |
| `email` | required, valid email format, ≤254 | "Please enter a valid email." |
| `textMessage` | optional, ≤5000 | "Keep this under 5000 characters." |
| `funnyMemory` | optional, ≤5000 | (same) |
| `advice` | optional, ≤5000 | (same) |
| `professionalNote` | optional, ≤5000; ignored if not business | (same) |
| **at-least-one-field** | ≥1 of the four content fields non-empty after trim | "Add at least one message before submitting." |
| `consentGiven` | must equal `true` | "Consent is required to include your submission." |

- Whitespace-only inputs are treated as empty (trimmed) for both storage and the
  at-least-one-field check.
- Length caps are enforced server-side regardless of client enforcement.
- Email is lowercased + trimmed before the uniqueness check and storage so
  `Ann@x.com` and `ann@x.com` collide (one-per-email is case-insensitive). See §13 Q5.

### 5.5 Rate limiting

| Concern | Decision |
|---|---|
| Surface limited | The **submit** action (not page loads) |
| Key | Client IP (resolved per §5.2 step 8) |
| Store | Redis (already provisioned, `src/lib/redis.ts`); fixed-window or sliding-window counter |
| Default limit | **5 submit attempts per IP per 10 minutes** (tunable via config; see §7) |
| On exceed | Reject with a rate-limit error; do not write; log for abuse review (§11) |
| Failure mode | If Redis is unavailable, **fail open** for availability (log a warning) — the unique constraint and consent still protect data integrity. Flagged §13 Q6 |

This is per architecture §10.3/§10.5 ("rate-limited per IP; one submission per email per event").
CAPTCHA for >100-contributor events (architecture §10.5) is **out of scope** for this story.

### 5.6 Error cases (consolidated)

| # | Case | Detection | Contributor sees | HTTP-equivalent | Side effects |
|---|---|---|---|---|---|
| E1 | Unknown slug | load + submit step 1 | "This link isn’t valid." | 404 | none |
| E2 | Event not collecting | step 2 | "This tribute isn’t collecting submissions right now." | 409 | none |
| E3 | Deadline passed | step 3 | "Submissions have closed." | 410 | none |
| E4 | Validation failure | step 4 | field-level errors + summary | 422 | none |
| E5 | Consent not given | steps 4/5 | "Consent is required…" | 422 | none |
| E6 | Empty submission (no content field) | step 6 | "Add at least one message before submitting." | 422 | none |
| E7 | Rate limit exceeded | step 7 | "You’ve tried a few times — please wait a moment and try again." | 429 | log |
| E8 | Duplicate email for event | step 10 (P2002) | "It looks like you’ve already submitted for this event." | 409 | none (no second row) |
| E9 | Unexpected server error | any | "Something went wrong on our end. Please try again." | 500 | log |

For Server Actions the "HTTP-equivalent" column is conceptual (Server Actions don’t set status
codes directly); integration tests assert on the returned result shape and DB state. If a thin
JSON route is added later for the same logic, these statuses apply literally.

---

## 6. Database Design

This story adds the **`Submission`** model and the **`SubmissionStatus`** enum to
`prisma/schema.prisma`. It does **NOT** add `MediaItem` (Story 6) and does **NOT** add the
AI-derived columns (`overallQualityScore`, `transcript`, `sentiment`, `extractedQuotes`,
`tags`) — those arrive with their owning stories. The fields below are the subset of
architecture §7.1's `Submission` needed now, designed so the deferred fields slot in cleanly.

### 6.1 `Submission` fields added this story

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | String (cuid) | no | `cuid()` | PK |
| `eventId` | String | no | — | FK → `Event.id` |
| `event` | relation `Event` | — | — | `@relation(fields: [eventId], references: [id], onDelete: Cascade)` |
| `contributorName` | String | no | — | trimmed 1–120 |
| `relationship` | String | no | — | trimmed 1–120 (label adapts; stored value is whatever the contributor typed) |
| `email` | String? | **yes** | — | nullable in schema to match architecture §7.1; **app requires it** in MVP (see §13 Q3). Stored lowercased/trimmed |
| `textMessage` | String? | yes | — | free text, ≤5000 |
| `funnyMemory` | String? | yes | — | free text, ≤5000 |
| `advice` | String? | yes | — | free text, ≤5000 |
| `professionalNote` | String? | yes | — | free text, ≤5000; null for personal occasions |
| `consentGiven` | Boolean | no | — | always `true` for any persisted row (insert only on consent) |
| `consentAt` | DateTime | no | — | set to submit instant; never null when consent given (architecture §7.1) |
| `status` | `SubmissionStatus` | no | `PENDING` | lifecycle owned by admin from Story 8 |
| `adminNote` | String? | yes | — | present in architecture §7.1; reserved for Story 8. **Decision:** include now (cheap, avoids a later migration) — see §13 Q7 |
| `submittedAt` | DateTime | no | `now()` | creation timestamp |
| `ipAddress` | String? | yes | — | abuse detection only; never shown to contributors |

**Deferred fields (NOT added now), with their owning story, listed so the migration author
knows they are intentional omissions:**

| Field | Owning story |
|---|---|
| `mediaItems MediaItem[]` (+ `MediaItem` table) | Story 6 |
| `overallQualityScore Float?` | Story 9 |
| `transcript String? @db.Text` | Story 10 |
| `sentiment String?`, `extractedQuotes Json?`, `tags String[]` | Story 11 |
| `deletionToken String? @unique`, `deletedAt`, `hardDeleteAt` | Story 20 |

### 6.2 Enum

```
SubmissionStatus: PENDING | APPROVED | REJECTED | FLAGGED
```
- Default `PENDING`. Story 5 only ever writes `PENDING`. The other values are reachable from
  Story 8 (admin approve/reject) and Story 9+ (auto-flag). Defining the full enum now matches
  architecture §7.1 and avoids an enum-altering migration later.

### 6.3 Constraints & indexes

| Constraint / index | Definition | Purpose |
|---|---|---|
| `@@unique([eventId, email])` | composite unique | **One submission per email per event** (§5.6 E8). Enforced at DB level — race-safe under concurrent submits |
| `@@index([eventId, status])` | composite index | Admin dashboard queries (Story 7/8): list submissions by event filtered by status |
| FK `eventId → Event.id` | `onDelete: Cascade` | Deleting an event removes its submissions (right-to-delete + retention, architecture §11.4) |

**Null-email caveat:** Postgres treats `NULL` as distinct in unique indexes, so multiple rows
with `email = NULL` for the same event would **not** collide. Because the app requires email in
MVP (§13 Q3), `email` is never null in practice and the unique constraint is effective. If email
is later made optional and device-fingerprint is used for one-per-event, the uniqueness key must
change accordingly (flagged §13 Q3).

### 6.4 Relation on `Event`
The `Event` model (from Story 3) carries the back-relation `submissions Submission[]`. If Story 3
left a placeholder, no change is needed; otherwise this story adds the back-relation. No other
`Event` columns change.

### 6.5 Migration notes
- Single forward migration: `add_submission` — creates `SubmissionStatus` enum, `Submission`
  table, the two indexes, the unique constraint, and the FK with `ON DELETE CASCADE`.
- Generated via `prisma migrate dev` against `swara_dev`; applied to `swara_test` in CI and
  `swara_prd` on deploy (per Story 1 §11 pooler/direct-URL guidance).
- No data backfill (new table).
- No destructive change (additive only) — safe to deploy without downtime.
- **Blocking prerequisite:** the migration references `Event.id`; it cannot apply unless Story 3's
  `Event` table exists in the same schema history. Confirm Story 3's migration precedes this one.

---

## 7. External Services / Integrations / Config

**No new external service** is integrated in this story (no Stripe, no Resend send, no S3, no
AI). The contributor confirmation email and the self-service deletion link are explicitly
**Story 20** (and reminder emails are Story 18) — this form does not send any email.

### Config additions (BOTH files, per project convention)
Add to **`src/config/env.ts`** (raw reads) and **`src/config/index.ts`** (typed Zod), with
sensible defaults so the story works without new ops setup:

| Env var | Type | Default | Used for | Notes |
|---|---|---|---|---|
| `CONTRIB_RATELIMIT_MAX` | int | `5` | Max submit attempts per window per IP (§5.5) | Optional; default applied if unset |
| `CONTRIB_RATELIMIT_WINDOW_SEC` | int | `600` | Rate-limit window seconds (§5.5) | Optional |

- Both must be added to `src/config/env.ts` AND `src/config/index.ts` (no direct `process.env`
  anywhere else — enforced by the ESLint `no-restricted-syntax` rule from Story 1).
- Redis (already configured) is reused for the rate-limit counter; **no new `REDIS_URL`**.
- Add the two vars to `.env.example` for discoverability.
- If the team prefers not to introduce config now, the limits may be in-code constants; this doc
  defaults to config so production can tune without a deploy. Flagged §13 Q6.

---

## 8. Seed Data

Extend the dev seed (or add one if Story 3 didn’t) to support manual testing of the form and the
downstream admin views.

Seed should create, for **one seeded event** (an `ACTIVE` event with a future
`submissionDeadline` and a known slug, e.g. `riyas-graduation`):

| # | contributorName | relationship | email | content fields | consent | status |
|---|---|---|---|---|---|---|
| 1 | Priya Sharma | Friend | priya@example.com | textMessage + funnyMemory | true | `PENDING` |
| 2 | Arjun Mehta | Cousin | arjun@example.com | advice only | true | `APPROVED` |
| 3 | Sara Khan | Teacher | sara@example.com | textMessage only | true | `REJECTED` |
| 4 | Dev Patel | Classmate | dev@example.com | funnyMemory only | true | `FLAGGED` |

Plus, to exercise business labels, optionally a second **business** event
(`occasionType = BUSINESS_EVENT`, slug e.g. `acme-25th`) with one submission using
`professionalNote`.

Seed requirements:
- All seeded submissions have `consentGiven = true` and a non-null `consentAt`.
- Each has a distinct `email` per event (respect the unique constraint).
- `ipAddress` may be a placeholder (e.g. `127.0.0.1`) or null.
- A **closed** event (deadline in the past) is helpful to manually verify the deadline-closed
  state; add one if not already seeded by Story 3.
- Seed must be idempotent (upsert by slug/email) so re-running doesn’t violate uniqueness.

---

## 9. Testing

`SKIP_INTEGRATION` env flag gates DB-touching tests (project convention; integration tests skip
when set, e.g. in environments without a test DB).

### 9.1 Unit tests (no DB)
| Test | Asserts |
|---|---|
| Deadline open vs closed | Given `submissionDeadline` and `now`, the gate returns open/closed correctly at boundaries (just-before, exactly-at, just-after the instant) |
| At-least-one-field rule | Passes with any one content field non-empty; fails when all four empty / whitespace-only |
| Consent required | Validation fails when `consentGiven` is false/absent; passes when true |
| Business-vs-personal label logic | `isBusiness` true ⇒ business labels + `professionalNote` shown; false ⇒ personal labels + `professionalNote` hidden/ignored |
| Field validation | Length caps (120 / 254 / 5000), email format, trimming/whitespace handling, email lowercased |
| professionalNote ignored when personal | Submitted `professionalNote` on a personal occasion is dropped (stored null) |
| Status gating | Event status outside collecting set ⇒ load/submit return not-collecting |

### 9.2 Integration tests (DB; skipped under `SKIP_INTEGRATION`)
| Test | Asserts |
|---|---|
| Happy-path submit | Valid payload on an open `ACTIVE` event inserts one `Submission` with `status=PENDING`, `consentGiven=true`, `consentAt` set, correct `eventId`, content fields stored, email lowercased |
| Duplicate-email rejection | Second submit with same (eventId, email) is rejected gracefully (E8); exactly **one** row exists; no 500 |
| Deadline enforcement (server) | Submit after `submissionDeadline` rejected (E3); no row written |
| Status enforcement (server) | Submit to a non-collecting event rejected (E2); no row written |
| Empty submission | Submit with all content fields empty rejected (E6); no row written |
| Consent missing | Submit with `consentGiven=false` rejected (E5); no row written |
| IP + consentAt recorded | On success, `ipAddress` and `consentAt` are persisted (non-null) |
| Cascade delete | Deleting the parent event removes its submissions |

### 9.3 Rate-limit test
- Unit/integration: N+1 submit attempts from the same IP within the window ⇒ the (N+1)th is
  rejected (E7). Use a fake/short window. Verify fail-open behavior when the limiter store is
  unavailable (no crash; submit proceeds; warning logged).

### 9.4 (Optional) component/render tests
- Open state renders all required fields; business event additionally renders `professionalNote`
  with the business label; closed/not-found states render the correct copy and **no** form.

---

## 10. Security & Surprise Integrity

| Concern | Control |
|---|---|
| Public form abuse (spam) | Per-IP rate limit (§5.5); mandatory consent; one-per-email unique constraint; length caps to bound payload size |
| Slug enumeration | Not-found and not-collecting states are generic and identical-feeling; no honoree name leaked; no "event existed but is gone" signal |
| One-per-email | DB-level `@@unique([eventId, email])`; race-safe; email normalized (lowercase/trim) so trivial case variants can’t bypass |
| IP storage | `ipAddress` stored **only** for abuse detection (architecture §7.1, §10.5); never displayed to contributors or other users; treated as PII for retention/deletion |
| Consent storage/exportability | `consentGiven` + separate `consentAt` timestamp persisted per submission; exportable for compliance (requirements §8; admin export is Story 7/13). Never write a row without consent |
| No honoree exposure | The form never shows the honoree’s email/contact; no honoree notification is sent or offered; honoree name shown only as the tribute subject in open/closed states |
| Surprise: search indexing | `/contribute/[slug]` and the thank-you page set `noindex, nofollow` and `Referrer-Policy: no-referrer` so the link doesn’t leak via search or referrers (architecture §10.1) |
| No cross-contributor leakage | A contributor never sees others’ submissions, counts, or names |
| CSRF | Next.js Server Actions are origin-checked by the framework; rely on that (no custom token needed) |
| Input handling | All text stored as-is (no HTML execution); rendering surfaces (admin, later) must escape — flagged as a downstream requirement for Story 7 |

**Deferred:** CAPTCHA for very large events (architecture §10.5) — future story.

---

## 11. Observability / Audit

| Signal | Where | Notes |
|---|---|---|
| Submit success | Structured log (`src/lib/logger.ts`) | Log `eventId`, `submissionId`, **no** raw email/IP at info level (PII); email/IP only at debug or redacted |
| Validation rejection | log (debug) | Counts of E4–E6 useful for form-friction analysis |
| Rate-limit hit (E7) | log (warn) | Include IP hash + eventId for abuse review |
| Duplicate email (E8) | log (info) | Expected case; track rate to size the "already submitted" UX |
| Unexpected error (E9) | log (error) | Full error; safe message to user |
| Audit log (`AuditLog`) | **Not** written in this story | `AuditLog` is admin/system-action oriented (architecture §7.1). A public contributor submit is not an admin action; submission existence is the audit record. Flagged §13 Q8 if a `submission.created` audit entry is desired |

PII discipline: emails and IPs are never logged in plaintext at info level; redact or hash.

---

## 12. Definition of Done

Story 5 is done only when all are true:

- [ ] `prisma/schema.prisma` has the `Submission` model + `SubmissionStatus` enum exactly per §6;
      migration created and applied to dev; CI applies to test; deploy applies to prod.
- [ ] `/contribute/[slug]` renders the open form for an `ACTIVE`, pre-deadline event with correct
      personal/business labels.
- [ ] Deadline-closed, not-collecting, and not-found states render correct, on-brand copy with no
      honoree exposure where required.
- [ ] Submit inserts a `PENDING` submission with `consentGiven=true`, `consentAt`, `ipAddress`,
      normalized email, and trimmed content fields.
- [ ] At-least-one-field, mandatory consent, deadline, and status are all enforced **server-side**.
- [ ] Duplicate (eventId, email) submit is rejected gracefully (no 500, exactly one row).
- [ ] Per-IP rate limit active; fails open if the limiter store is down.
- [ ] Thank-you page reachable after a successful submit; refresh-safe; offers no honoree contact.
- [ ] `noindex/nofollow` + `Referrer-Policy: no-referrer` on the contributor pages.
- [ ] Config vars added to **both** `src/config/env.ts` and `src/config/index.ts` (+ `.env.example`);
      no direct `process.env` anywhere (ESLint passes).
- [ ] Seed creates sample submissions across statuses; seed is idempotent.
- [ ] Unit + integration tests (§9) pass; integration tests honor `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; deploy succeeds.
- [ ] No TODO comments left in committed code; `docs/stories.md` Story 5 row marked done.
- [ ] Accessibility checks (§4.8) satisfied: labels, focus-on-error, keyboard, contrast.

---

## 13. Open Questions / Assumptions

| # | Question / Assumption | This doc’s default | Needs confirmation? |
|---|---|---|---|
| Q1 | **Which `EventStatus` values may collect submissions?** Story 5 is parallel with Story 4; only Story 4 sets `ACTIVE` via Stripe webhook. | Collecting set = `{ ACTIVE }`. For dev/test before Story 4 lands, seed events directly as `ACTIVE`. | **Yes** — confirm no pre-payment collecting state is wanted |
| Q2 | **Which occasions are "business" for adaptive labels?** Requirements §5.2 names `BUSINESS_EVENT` for label swaps but also `ANNIVERSARY` for the professional note. | Labels swap on `BUSINESS_EVENT`; `professionalNote` shows for `BUSINESS_EVENT` **and** `ANNIVERSARY`. | **Yes** — confirm the split or simplify to `BUSINESS_EVENT` only |
| Q3 | **Is email mandatory, or device-fingerprint as the alternate one-per-event key?** Requirements §5.2 says "email **or** device fingerprint"; architecture uses `@@unique([eventId,email])` and `email String?`. | Email **mandatory** in MVP; one-per-email via the unique constraint. No fingerprinting. | **Yes** — fingerprint is materially more work and weaker; recommend email-only |
| Q4 | **Thank-you: dedicated route vs inline state?** | Dedicated route `/contribute/[slug]/thank-you`. | Low stakes — confirm preference |
| Q5 | **Case-insensitive email uniqueness?** Postgres unique is case-sensitive by default. | Normalize to lowercase before store + compare, so `A@x.com` == `a@x.com`. | Recommend yes |
| Q6 | **Rate-limit config vs constants; fail-open vs fail-closed if Redis down?** | Config-driven defaults (5 / 600s); **fail open** on limiter outage. | Confirm fail-open is acceptable |
| Q7 | **Add `adminNote` column now (Story 8 owner) to avoid a later migration?** | Include now (nullable, unused until Story 8). | Confirm; alternatively defer to Story 8 |
| Q8 | **Write an `AuditLog` `submission.created` entry?** | No — submission row is the record; `AuditLog` is for admin/system actions. | Confirm |
| Q9 | **Should the form show a live remaining-time / deadline banner?** | Show the deadline date (long form) but no live countdown in this story. | Low stakes |
| Q10 | **`Event` schema not yet on `main` (only `User` exists).** | Assume Story 3 lands `Event` per architecture §7.1 before this migration. | **Yes** — Story 3 must merge first |
