# Story 4 — Stripe Payment + Event Activation (Design)

**Epic:** B — Event Creation
**Sequence:** 4 (depends on Story 3; parallel with Story 5)
**Depends on:** Story 1 (foundation), Story 2 (organizer auth), Story 3 (event creation — draft `Event` with `status=DRAFT`, slug, organizer ownership)
**Unlocks:** A paid, `ACTIVE` event that contributors can submit to (Story 5+)
**Complexity:** Medium (1–3 days)

> This is a design-level specification. No code. Contracts are stated as field
> names, types, enum values, route signatures, payloads, status codes, and
> state transitions for a later code-gen step to implement exactly.

---

## 1. Story Summary

Turn the free draft event from Story 3 into a **paid, activated** event. Story 4
introduces the single MVP 1 **Package** as a first-class, data-driven entity
(features read from `package.features[]`, never hardcoded by tier), creates a
**Stripe Checkout Session** for an organizer paying for their draft event, and
activates the event (`DRAFT → ACTIVE`) **only** when a cryptographically signed
Stripe webhook (`checkout.session.completed`) is received and verified. Payment
state is tracked on the event via `paymentStatus` and `stripeSessionId`.

The load-bearing rule from `architecture.md` §6.1 and §11.1: **activation never
happens on the browser redirect** (the redirect is user-manipulable). Activation
happens once, idempotently, in the webhook handler, deduped by `stripeSessionId`.

---

## 2. Scope

### In Scope

- `Package` model added to the Prisma schema as a first-class entity with
  `features[]` (string array). One seeded MVP 1 package row.
- A server-side **create Checkout Session** action/route that:
  - is authenticated (organizer must own the draft event),
  - never exposes `STRIPE_SECRET_KEY` to the browser,
  - records `stripeSessionId` on the event and sets `paymentStatus=PENDING`,
  - returns the Stripe-hosted Checkout URL for redirect.
- A **webhook receiver route** at `/api/stripe/webhook` that:
  - verifies the Stripe signature with `STRIPE_WEBHOOK_SECRET`,
  - handles `checkout.session.completed` (and `checkout.session.async_payment_failed` / `checkout.session.expired` for status tracking),
  - runs the activation transaction `DRAFT → ACTIVE`, idempotently,
  - sets `paymentStatus=PAID` on success.
- Frontend: package selection display rendered from `package.features[]`; a "pay"
  action that redirects to Stripe Checkout; success and cancel return pages; the
  `DRAFT → ACTIVE` state reflected in the organizer's event view.
- Config: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
  added to **both** `src/config/env.ts` and `src/config/index.ts`.
- `AuditLog` entry `payment.activated`; `NotificationLog` enqueue of the
  organizer payment-confirmation email (the dispatch implementation is Story-2/
  notifications-era infrastructure; this story enqueues the intent).
- Seed data: the MVP 1 `Package` row, a matching Stripe test product/price, and a
  `DRAFT` event to pay for.
- Unit + integration tests per §9.

### Out of Scope (do NOT build in Story 4)

- Multiple packages / pricing tiers (MVP 2). The schema supports many rows; only
  one is seeded.
- Per-feature gating logic that *consumes* `features[]` downstream (e.g. enabling
  password-protected share pages). Story 4 only stores and displays features.
- Refund initiation UI/flow. The `REFUNDED` enum value exists and the webhook may
  set it if a refund event is configured, but no admin refund action is built.
- Stripe Customer / saved-card / subscription concepts — this is a one-time
  payment via Checkout.
- Stripe live-mode setup (test mode only in this story; live-mode flip is a
  launch-checklist item, dev-setup §10).
- Contributor flow, deadline enforcement, AI pipeline (later stories).
- Coupon / discount codes, tax configuration beyond Stripe defaults.

---

## 3. Dependencies & Sequence

| Needs (already on `main`) | Source |
|---|---|
| `Event` model with `status` (default `DRAFT`), `paymentStatus` (default `PENDING`), `stripeSessionId`, `packageId`, `organizerId`, `slug` | Story 3 schema (mirrors `architecture.md` §7.1) |
| `EventStatus` enum incl. `DRAFT`, `ACTIVE` | Story 3 / architecture §7.1 |
| `PaymentStatus` enum (`PENDING`, `PAID`, `REFUNDED`, `FAILED`) | architecture §7.1 (added/used here) |
| Organizer auth + session (owner check) | Story 2 |
| Typed config module, single `process.env` reader (`src/config/env.ts`) | Story 1 |
| `AuditLog`, `NotificationLog` models | architecture §7.1 |

**Sequencing note:** Story 3 creates the `Event`, `EventStatus`, and (per
architecture §7.1) the `paymentStatus`/`stripeSessionId`/`packageId` fields. If
any of those fields or the `PaymentStatus` enum are not yet present when Story 4
starts, Story 4's migration adds them (see §6 migration notes). Story 4 owns the
new **`Package`** model regardless. Parallel with Story 5 (contributor submit) —
no shared files beyond the `Event` model.

**Ambiguity flag:** Whether `AuditLog` / `NotificationLog` models already exist on
`main` by Story 4 depends on how earlier stories landed them. If absent, Story 4
adds the minimal `AuditLog` and `NotificationLog` models per architecture §7.1 so
the audit/enqueue requirements (§11) can be met. Resolve at implementation time.

---

## 4. Frontend / UI Design

All copy follows `branding.md`: sentence-case buttons, title-case headings, no
exclamation marks in transactional copy, honoree name spelled exactly as entered.

### 4.1 Package selection display (data-driven)

Rendered on the event payment step (the final step of the Story 3 wizard, or a
dedicated `/events/[id]/pay` view for an existing draft).

- The package card is built **entirely from the `Package` row**, never from a
  hardcoded tier name. Display elements:
  - `name` — package title.
  - `priceCents` — formatted as currency (e.g. `$XX.XX`), using `currency`.
  - `features[]` — rendered as a bulleted list. Each feature string maps to a
    human-readable label via a presentation lookup (feature-key → display label).
    Unknown keys fall back to a humanized version of the key. **No `if (tier ===
    'premium')` branching anywhere.**
  - `deliverySlaDays` — shown as "Delivered within N days".
  - `includedRevisions` — shown as "N included revision(s)".
- A single primary CTA: **"Pay and activate"** (sentence case). Disabled while the
  create-session request is in flight.
- If the event is already `ACTIVE` (paid), the card shows a paid state instead of
  the CTA (see §4.4) — defends against double payment.

### 4.2 "Pay" action → redirect to Stripe Checkout

- The CTA calls the server-side create-session endpoint (§5.1) for this `eventId`.
- On success the server returns the Stripe-hosted Checkout `url`; the browser
  performs a full-page redirect to that URL. The browser **never** sees the
  secret key; only the publishable key (if Stripe.js is used client-side) and the
  returned session URL.
- The redirect target is Stripe's hosted Checkout page (PCI scope stays with
  Stripe; the app never touches card data).
- **Test card:** in test mode, complete payment with `4242 4242 4242 4242`, any
  future expiry, any CVC, any postal code (dev-setup §5).

### 4.3 Success and cancel return pages

Stripe redirects the browser back to app-owned URLs after the hosted flow.

| Page | Route | Behavior |
|---|---|---|
| Success | `/events/[id]/pay/success?session_id={CHECKOUT_SESSION_ID}` | Shown after a successful Stripe redirect. **MUST NOT activate the event.** Reads the event's current state from the DB. If webhook already processed → show "Payment received. Your event is active." If not yet processed → show an optimistic pending state: "Payment received — finalizing your event. This page will update shortly." with light client polling / refresh. |
| Cancel | `/events/[id]/pay/cancel` | Shown when the organizer abandons Checkout. Event remains `DRAFT`, `paymentStatus` unchanged (`PENDING`). Copy: "Payment canceled. Your event is saved as a draft — you can pay anytime to activate it." Offers a "Try again" link back to §4.1. |

Stripe Checkout Session is created with `success_url` and `cancel_url` set to the
two routes above (success_url includes the `{CHECKOUT_SESSION_ID}` template var).

**Branding copy (from `branding.md` voice — calm, no exclamation marks):**
- Checkout (package card subhead): "One payment activates your event and opens it to contributors."
- Success (activated): "Your event for **{honoreeName}** is active. Share the link with contributors to start collecting wishes."
- Success (pending): "Payment received — we're finalizing your event. This updates automatically."
- Cancel: "Payment canceled. Your draft is saved. Pay anytime to activate."

### 4.4 DRAFT → ACTIVE reflected in UI

- The organizer's event detail and "My Events" list display the event `status`
  and `paymentStatus`.
- A `DRAFT` event shows a "Draft — payment required" badge and the pay CTA.
- An `ACTIVE` event shows an "Active" badge, the contributor share link/QR (from
  Story 3 artifacts), and hides the pay CTA.
- The transition surfaces without a manual reload only after the webhook runs.
  The success page handles the brief window between redirect and webhook (§4.3) by
  showing the pending state and polling the event status.

---

## 5. Backend / API Design

### 5.1 Create Checkout Session (server-side only)

| Property | Value |
|---|---|
| Type | Server Action **or** route handler `POST /api/events/[id]/checkout` (implementer's choice; must run server-side only) |
| Auth | Required. Session organizer must be the event's `organizerId`. |
| Input | `eventId` (from path/closure). No client-supplied price/package — looked up server-side. |
| Secret usage | Uses `config.stripe.secretKey` to call Stripe. **Never** returned to or referenced by client code. |

**Preconditions (all enforced server-side):**
1. Event exists and belongs to the authenticated organizer → else `403`/`404`.
2. Event `status === DRAFT` and `paymentStatus !== PAID`. If already `ACTIVE`/`PAID`
   → return a conflict (`409`) or redirect to the event view; never create a
   second paid session for an already-paid event.
3. Event has a valid `packageId` resolving to an existing `Package` row → else `422`.

**Steps:**
1. Load the `Package` row by `event.packageId` (server-side price source of truth).
2. Create a Stripe Checkout Session with:
   - `mode = "payment"` (one-time).
   - Line item priced from Stripe (preferred: the package's stored Stripe
     `price_id`; see §6 `Package.stripePriceId`). Using a stored Stripe Price ID
     keeps Stripe as the price source of truth and avoids passing ad-hoc amounts.
   - `success_url` = `{appUrl}/events/{id}/pay/success?session_id={CHECKOUT_SESSION_ID}`.
   - `cancel_url` = `{appUrl}/events/{id}/pay/cancel`.
   - `client_reference_id = event.id` (links the session back to the event without
     trusting client input on return).
   - `metadata = { eventId, packageId, organizerId }` (redundant linkage; the
     webhook reads `eventId` from here / from `client_reference_id`).
   - `idempotency_key` on the Stripe API call = a deterministic key derived from
     the event, e.g. `checkout:{eventId}` (prevents duplicate sessions if the
     organizer double-clicks). See note in §5.4.
3. Persist `event.stripeSessionId = session.id` and ensure
   `paymentStatus = PENDING` (no change if already PENDING).
4. Optionally write `AuditLog { action: "payment.checkout_created", eventId, actorId: organizerId, metadata: { sessionId } }`.
5. Return `{ url: session.url }` (the hosted Checkout URL) to the client for redirect.

**Response codes:**

| Code | When |
|---|---|
| `200` (or action return) | Session created; body `{ url }` |
| `401` | Not authenticated |
| `403` | Authenticated but not the event owner |
| `404` | Event not found |
| `409` | Event already `ACTIVE`/`PAID` |
| `422` | Event has no/invalid package |
| `500` | Stripe API error (logged; user sees a retry-able error) |

### 5.2 Webhook receiver

| Property | Value |
|---|---|
| Route | `POST /api/stripe/webhook` (path fixed by dev-setup §5 and architecture §6.1) |
| Auth | **None via session.** Authenticity is established by Stripe signature verification only. |
| Body parsing | Reads the **raw request body** (unparsed bytes) — required for signature verification. The route must opt out of any JSON body parsing/transform. |
| Verification | Validates the `Stripe-Signature` header against the raw body using `config.stripe.webhookSecret` (`STRIPE_WEBHOOK_SECRET`). Invalid/missing signature → `400`, no side effects. |

**Events handled:**

| Stripe event type | Action |
|---|---|
| `checkout.session.completed` | Primary activation trigger. Run the activation transaction (§5.3). Set `paymentStatus = PAID`, `status = ACTIVE`. |
| `checkout.session.async_payment_succeeded` | Treated identically to `completed` for delayed-settlement payment methods (idempotent — see §5.4). |
| `checkout.session.async_payment_failed` | Set `paymentStatus = FAILED`. Do **not** activate. Audit `payment.failed`. |
| `checkout.session.expired` | Session abandoned/expired. Leave event `DRAFT`; optionally set `paymentStatus = FAILED` only if it was `PENDING` for this session. No activation. |
| (any other type) | Acknowledge with `200` and ignore (so Stripe doesn't retry). Log at debug. |

> Activation is keyed on `checkout.session.completed`/`async_payment_succeeded`.
> Refunds (`charge.refunded`) are **out of scope** for processing in Story 4 but,
> if a refund webhook is later enabled, it would set `paymentStatus = REFUNDED`.

**Webhook response codes:**

| Code | When |
|---|---|
| `200` | Signature valid AND handler completed (including idempotent no-ops and ignored event types). Tells Stripe "received". |
| `400` | Missing/invalid signature, or unparsable body. Stripe will not treat this as deliverable; surfaces as a webhook failure in Stripe dashboard. |
| `500` | Signature valid but handler threw (e.g. DB unavailable). **Stripe retries** with backoff (architecture §11.1). The handler must be safe to re-run (idempotent, §5.4). |

### 5.3 Activation transaction (DRAFT → ACTIVE)

Runs inside a single DB transaction so partial activation can't occur.

1. Resolve the target event:
   - Prefer `session.client_reference_id` (= `eventId`), fall back to
     `session.metadata.eventId`, and cross-check against the event whose
     `stripeSessionId === session.id`.
   - If no event matches → log a warning, return `200` (don't make Stripe retry a
     payload we can't map; alert per §11). Do not throw.
2. **Idempotency check (dedupe by `stripeSessionId`):** if the event is already
   `status = ACTIVE` and `paymentStatus = PAID` for this `stripeSessionId`, treat
   as a duplicate delivery → no-op, return `200`. (Also guarded by the audit-log
   check, §11 / architecture §8.2.)
3. Within the transaction, update the event:
   - `paymentStatus = PAID`
   - `status = ACTIVE`
   - (slug, QR, share text were generated in Story 3 at draft creation; Story 4
     does not regenerate them. If architecture §6.1's "generate slug/QR/share
     text on activation" is the chosen split, do it here instead — see open
     question Q4.)
4. Write `AuditLog { action: "payment.activated", eventId, actorId: null (system), metadata: { stripeSessionId, packageId, amountTotal, currency } }`.
5. Enqueue the organizer confirmation notification: insert/enqueue a
   `NotificationLog` intent `{ eventId, recipientType: "organizer", recipientEmail: organizer.email, channel: "email", trigger: "event.activated", status: "queued" }`. Honoree-email suppression filter (architecture §10.1) applies at dispatch time.
6. Commit. Return `200`.

**Why activation is webhook-only (state it explicitly in the design):** the
browser `success_url` redirect is fully under the user's control (they can hit it
without paying, replay it, or share it). The webhook is signed by Stripe with a
shared secret the client never holds, so it is the only trustworthy signal that
money actually moved. The success page therefore *reads* state but never *writes*
activation (architecture §6.1, §10).

### 5.4 Idempotency & retries

- **Dedupe key:** `Event.stripeSessionId`. Each Checkout Session maps to exactly
  one event; re-receiving the same `session.id` finds an already-`PAID`/`ACTIVE`
  event and no-ops (architecture §11.1).
- **Stripe-side idempotency:** the create-session call passes
  `idempotency_key = checkout:{eventId}` so a double-submit doesn't create two
  sessions. (Caveat: if the first session expired, a new key may be required to
  start a fresh session; implementer may suffix with a short attempt counter or
  drop the key for explicit "try again" — flag Q5.)
- **Side-effect guard:** before sending the organizer confirmation, the handler
  checks for an existing `AuditLog payment.activated` or `NotificationLog
  event.activated` for the event; if present, skip (architecture §8.2 — side
  effects check the log before emitting).
- **Missed webhook:** Stripe redelivers automatically; the idempotent handler
  produces the same result (architecture §11.1). No manual reconciliation needed
  for MVP 1.
- **Out-of-order delivery:** if `expired`/`failed` arrives *after* `completed`,
  the handler must not downgrade an already-`PAID` event — guard status writes on
  current state.

### 5.5 Error handling summary

| Failure | Response |
|---|---|
| Invalid webhook signature | `400`, no DB writes |
| Event not found for session | `200` + warning log + alert (§11); avoids infinite Stripe retries on an unmappable payload |
| DB error mid-activation | transaction rolls back; return `500`; Stripe retries; idempotent on replay |
| Duplicate `completed` delivery | idempotent no-op; `200` |
| `async_payment_failed` | `paymentStatus = FAILED`; event stays `DRAFT`; `200` |
| Create-session Stripe error | `500` to caller; organizer can retry; no event mutation beyond unchanged `PENDING` |

---

## 6. Database Design

### 6.1 New model — `Package`

First-class entity. Features are data, not code.

| Field | Type | Null? | Default | Notes |
|---|---|---|---|---|
| `id` | String (cuid) | no | `cuid()` | PK |
| `name` | String | no | — | Display name (MVP 1: e.g. "Magical Memories") |
| `priceCents` | Int | no | — | Integer cents; avoids float money bugs |
| `currency` | String | no | `"usd"` | ISO currency; matches Stripe price currency |
| `features` | String[] | no | `[]` | e.g. `["video_master","reel","youtube","auto_thumbnail","download_link","share_page"]`. Code reads `features.includes(x)`, never tier names. |
| `deliverySlaDays` | Int | no | — | SLA window shown in UI and used downstream |
| `includedRevisions` | Int | no | `0` | Included revision count |
| `stripeProductId` | String | yes | null | Stripe product reference (test-mode for now) |
| `stripePriceId` | String | yes | null | Stripe Price ID used as the Checkout line item (price source of truth) |
| `active` | Boolean | no | `true` | Allows retiring a package without deleting rows (MVP 2 tiering) |
| `createdAt` | DateTime | no | `now()` | |
| `updatedAt` | DateTime | no | `@updatedAt` | |

- Relation: `Event.packageId` → `Package.id`. In Story 4, formalize the relation
  (`package Package @relation(fields:[packageId], references:[id])`) if Story 3
  left `packageId` as a bare string. Use `onDelete: Restrict` (don't allow
  deleting a package that events reference).

> The logical model in `requirements.md` §4 lists `id, name, price_cents,
> features[], delivery_sla_days, included_revisions`. The schema above maps those
> one-to-one (camelCase in Prisma) and adds `currency`, `stripeProductId`,
> `stripePriceId`, `active`, timestamps for the Stripe integration and lifecycle.

### 6.2 `Event` fields used / added

These mirror `architecture.md` §7.1. Story 4 *uses* them; it *adds* any that
Story 3 didn't already create.

| Field | Type | Null? | Default | Story 4 role |
|---|---|---|---|---|
| `status` | `EventStatus` | no | `DRAFT` | Transitioned `DRAFT → ACTIVE` on activation |
| `paymentStatus` | `PaymentStatus` | no | `PENDING` | Set `PAID` / `FAILED` (`REFUNDED` reserved) |
| `stripeSessionId` | String | yes | null | Stores Checkout Session id; the idempotency dedupe key |
| `packageId` | String | no | — | FK to `Package`; price source via `Package.stripePriceId` |
| `organizerId` | String | no | — | Ownership check for create-session |
| `slug` | String (unique) | no | — | Created Story 3; referenced for share/contrib links |

### 6.3 Enums

- `PaymentStatus { PENDING PAID REFUNDED FAILED }` — add if not present
  (architecture §7.1). Default `PENDING`.
- `EventStatus { DRAFT ACTIVE ... }` — already exists from Story 3; Story 4 only
  uses `DRAFT` and `ACTIVE`.

### 6.4 Status transition matrix

| From `status` | To `status` | Trigger | Side `paymentStatus` |
|---|---|---|---|
| `DRAFT` | `DRAFT` (unchanged) | create Checkout Session | `PENDING` |
| `DRAFT` | `ACTIVE` | webhook `checkout.session.completed` / `async_payment_succeeded`, verified | `PAID` |
| `DRAFT` | `DRAFT` (unchanged) | webhook `async_payment_failed` | `FAILED` |
| `DRAFT` | `DRAFT` (unchanged) | webhook `checkout.session.expired` | `FAILED` (only if was `PENDING` for this session) |
| `ACTIVE` | `ACTIVE` (unchanged) | duplicate `completed` delivery | `PAID` (idempotent no-op) |

### 6.5 Migration notes

- New migration adds the `Package` model and (if absent) `PaymentStatus` enum,
  `Event.paymentStatus`, `Event.stripeSessionId`, and the `Event → Package`
  relation. Run via Prisma against `swara_dev` then `swara_test` (dev-setup §4);
  `swara_prd` migrated at deploy time.
- `Package.features` is a Postgres `text[]` column (Prisma `String[]`).
- Backfill: existing draft events from Story 3 dev/seed data must reference a
  valid `packageId`. The seed (§8) creates the package first, then the draft
  event pointing at it.
- Index: `Event.stripeSessionId` should be indexed (lookup by session id in the
  webhook). Consider `@unique` on `stripeSessionId` to hard-enforce one-session-
  per-event dedupe (allow null). Flag: a `@unique` blocks a legitimate "create a
  fresh session after expiry" reuse — see Q5; if reuse is required, keep it a
  plain index, not unique.

---

## 7. External Services / Integrations / Config

### 7.1 Stripe (test mode in dev)

- One Stripe **Product** for the MVP 1 package and one **Price** (one-time,
  amount = `priceCents`, currency = `currency`). The Price ID is stored on the
  `Package` row (`stripePriceId`) and used as the Checkout line item.
- Hosted Checkout only — the app never collects card data (PCI scope on Stripe).
- **Stripe Radar** is on by default for fraud screening (architecture §10.5);
  no app-side fraud logic in Story 4.
- Test card `4242 4242 4242 4242` for end-to-end checkout (dev-setup §5).
- The product/price can be created via Composio's Stripe tools (dev-setup §9) in
  **test mode only**; live-mode creation is a launch-checklist task (dev-setup
  §10).

### 7.2 Webhook endpoint

- Path: **`/api/stripe/webhook`** (fixed; matches dev-setup §5 and the prod
  webhook URL in the launch checklist).
- Local testing: `stripe listen --forward-to localhost:3000/api/stripe/webhook`;
  the CLI prints the signing secret → set as `STRIPE_WEBHOOK_SECRET` in
  `.env.development.local`. Trigger with `stripe trigger checkout.session.completed`.
- Production endpoint registered in the Stripe dashboard at
  `https://swaramagical.com/api/stripe/webhook` (launch checklist, dev-setup §10).

### 7.3 Config / env vars

Per repo convention, add to **both** files (no `process.env` outside config):

- `src/config/env.ts` — add raw reads:
  `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.
- `src/config/index.ts` — add a `stripe` object to the Zod schema and the parse
  call:

| Config path | Source env var | Type / validation | Exposure |
|---|---|---|---|
| `config.stripe.secretKey` | `STRIPE_SECRET_KEY` | `string` (non-empty) | **Server-only** — never imported into client components |
| `config.stripe.publishableKey` | `STRIPE_PUBLISHABLE_KEY` | `string` (non-empty) | Safe to expose to client (publishable by design) |
| `config.stripe.webhookSecret` | `STRIPE_WEBHOOK_SECRET` | `string` (non-empty) | **Server-only** — webhook route only |

- These already appear in `.env.example` (dev-setup §7) as `sk_test_...`,
  `pk_test_...`, `whsec_...`. No new `.env.example` lines required; this story
  wires them into the typed config.
- The Zod parse fails fast at boot if any are missing (architecture §16 / config
  module behavior), keeping with the "no silent runtime failures" rule.

> Note: the live schema also uses `DIRECT_URL` for migrations; that is a Story
> 1/3 concern and unrelated to Story 4. Story 4 touches only the three Stripe vars.

---

## 8. Seed Data

The dev seed (`npm run seed`, dev-setup §8) gains three rows so the pay flow is
exercisable end-to-end on localhost.

1. **MVP 1 Package row:**
   - `name`: "Magical Memories" (placeholder; final name TBD per architecture §17).
   - `priceCents`: a placeholder dev amount (e.g. `4900` = `$49.00`) — final
     price TBD (architecture §17 / Q1). Currency `"usd"`.
   - `features`: derived from requirements §4 MVP 1 list, e.g.
     `["video_master","reel","youtube","auto_thumbnail","download_link","share_page"]`.
   - `deliverySlaDays`: placeholder (e.g. `7`).
   - `includedRevisions`: `0` (MVP 1).
   - `stripeProductId` / `stripePriceId`: the test-mode product/price IDs (see
     below). If created lazily, seed can leave null and the create-session path
     falls back to an inline price_data line item (flag Q2 — preference is stored
     Price ID).

2. **Stripe test product/price:** a test-mode Product + one-time Price matching
   the package amount/currency, created via Composio/Stripe CLI in test mode. Its
   IDs are written back to the seeded `Package` row.

3. **A `DRAFT` event to pay for:** an event owned by the seeded dev organizer
   user, `status=DRAFT`, `paymentStatus=PENDING`, `packageId` pointing at the
   seeded package, with valid honoree/slug fields from Story 3. This is the row a
   developer pays for with `4242 4242 4242 4242` to watch `DRAFT → ACTIVE`.

`swara_test` seed: the same package row (deterministic id) so integration tests
can attach a draft event to it; AI mock mode is on but irrelevant to this story.

---

## 9. Testing

`AI_MOCK_MODE=true` in CI (dev-setup §11). Stripe is mocked in unit/integration;
real Stripe + CLI only in E2E (out of this story's automated scope but noted).

### 9.1 Unit tests

| Test | Asserts |
|---|---|
| Webhook signature verification — valid | A correctly signed payload passes verification and is dispatched to the handler. |
| Webhook signature verification — invalid/missing | Tampered body or wrong/absent signature → `400`, **zero** DB writes. |
| Idempotency dedupe | Same `checkout.session.completed` delivered twice → event activated once; second call is a no-op `200`; only one `payment.activated` audit row; only one organizer notification enqueued. |
| Activation logic | Given a `DRAFT`/`PENDING` event matching the session, sets `status=ACTIVE`, `paymentStatus=PAID`; given an already-`PAID` event, no-op. |
| Out-of-order guard | `expired`/`async_payment_failed` after `completed` does not downgrade an `ACTIVE`/`PAID` event. |
| Checkout session params | Create-session builds the session with correct `mode`, line item (stored `stripePriceId`), `success_url`/`cancel_url`, `client_reference_id=eventId`, `metadata.eventId`, and a deterministic idempotency key. Secret key is read only from `config.stripe.secretKey`. |
| `features[]` reads | Package presentation maps `features` strings to labels with no tier-name branching; unknown keys humanize gracefully. (Guards the data-driven rule.) |
| Auth/precondition guards | Non-owner → `403`; already-paid event → `409`; missing package → `422`. |

### 9.2 Integration tests (Docker infra, mocked Stripe)

| Test | Flow |
|---|---|
| Webhook → activation with DB | Seed a `DRAFT` event + package; feed a signed `checkout.session.completed` (test signing secret) to the webhook route; assert event is `ACTIVE`/`PAID`, audit row written, notification enqueued. |
| Idempotent redelivery against DB | Replay the same event; assert no duplicate state, audit, or notification. |
| Unmappable session | Webhook for a `session.id` with no matching event → `200`, warning logged, no writes. |
| Create-session persists `stripeSessionId` | Call create-session (mocked Stripe returns a session) → event has `stripeSessionId` set, `paymentStatus=PENDING`. |

- **Mocking Stripe:** stub the Stripe SDK so create-session returns a canned
  `{ id, url }`; for the webhook, construct payloads signed with the **test**
  `STRIPE_WEBHOOK_SECRET` so the real signature-verification path runs (do not
  bypass verification in the test — verify it).
- **`SKIP_INTEGRATION`:** integration tests are gated behind a `SKIP_INTEGRATION`
  flag (consistent with the project's integration-test gating) so a contributor
  without Docker/Redis/Postgres can still run unit tests; CI runs both.

---

## 10. Security

- **Signed webhook only.** Every webhook request is verified against
  `STRIPE_WEBHOOK_SECRET` over the **raw** body before any processing. Unverified
  requests get `400` and touch nothing.
- **Never activate on the redirect.** The `success_url` page is informational; it
  reads state and never writes activation. This is the core anti-tamper control
  (architecture §6.1, §10) — a user replaying or forging the success URL cannot
  activate an unpaid event.
- **Secret handling.** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are
  server-only, read solely through `config.stripe.*`, never bundled into client
  code or `NEXT_PUBLIC_*`. Only `STRIPE_PUBLISHABLE_KEY` may reach the browser.
- **No card data in scope.** Hosted Checkout keeps PCI scope on Stripe.
- **Ownership enforcement.** Create-session verifies the organizer owns the event;
  the event id is never trusted from the client return — the webhook re-derives it
  from `client_reference_id`/`metadata` and cross-checks `stripeSessionId`.
- **Stripe Radar** provides fraud screening on payments (architecture §10.5,
  threat "Payment fraud"). No additional app-side fraud logic in MVP 1.
- **No PII leak in logs.** Log session ids and event ids, not card/customer PII.

---

## 11. Observability / Audit

- **AuditLog `payment.activated`** — written inside the activation transaction:
  `{ action: "payment.activated", eventId, actorId: null /* system */, metadata: { stripeSessionId, packageId, amountTotal, currency } }`. Also (optional)
  `payment.checkout_created` on session creation and `payment.failed` on
  `async_payment_failed`. The audit log doubles as the side-effect guard
  (architecture §8.2): the handler checks for an existing `payment.activated` row
  before re-emitting side effects.
- **NotificationLog organizer confirmation** — the activation transaction enqueues
  an `event.activated` email intent to the organizer (`recipientType=organizer`,
  `channel=email`, `status=queued`/`sent` per dispatcher). The honoree-email
  suppression filter (architecture §10.1) applies at send time. Dedupe by checking
  for an existing `event.activated` `NotificationLog` for the event.
- **Critical alert: webhook failures.** Per architecture §13, alert when Stripe
  webhook failures exceed **5/hour** (signature failures, `5xx` from the handler,
  or unmappable sessions). Emit a metric/log on each webhook `400`/`500` and on
  the unmappable-session warning so the alert can fire. This is the highest-
  priority alert for this story because activation depends on the webhook.
- Standard request/error tracing on both routes (architecture §13); the webhook
  trace carries `eventId` and `stripeSessionId` as span attributes.

---

## 12. Definition of Done

- [ ] `Package` model added; migration applied to `swara_dev` and `swara_test`.
- [ ] `Event.paymentStatus`, `Event.stripeSessionId`, `Event → Package` relation
      present (added here if Story 3 didn't); `PaymentStatus` enum present.
- [ ] `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` wired
      into **both** `src/config/env.ts` and `src/config/index.ts`; boot fails fast
      if missing; no `process.env` outside config (lint rule passes).
- [ ] Create-session endpoint: owner-gated, server-side, returns hosted Checkout
      URL, persists `stripeSessionId` + `paymentStatus=PENDING`, never exposes the
      secret key.
- [ ] Webhook route `/api/stripe/webhook`: raw-body signature verification with
      `STRIPE_WEBHOOK_SECRET`; handles `checkout.session.completed` (+ async
      success/failure, expired); ignores others with `200`.
- [ ] Activation `DRAFT → ACTIVE` runs only in the webhook, idempotently, deduped
      by `stripeSessionId`; success page does not activate.
- [ ] Package selection UI renders from `features[]` (no tier-name branching);
      pay CTA redirects to Stripe; success and cancel pages behave per §4.3;
      `DRAFT/ACTIVE` reflected in event views.
- [ ] `AuditLog payment.activated` and `NotificationLog event.activated` written/
      enqueued exactly once per paid event.
- [ ] Seed creates the MVP 1 package, the Stripe test product/price, and a draft
      event to pay for.
- [ ] Unit + integration tests in §9 pass (incl. signature verification,
      idempotency, activation, checkout params, `features[]` reads); `SKIP_INTEGRATION`
      honored; CI green with `AI_MOCK_MODE=true`.
- [ ] Manual E2E on localhost: create draft → pay with `4242 4242 4242 4242` →
      Stripe CLI forwards webhook → event flips to `ACTIVE`; success page shows
      activated; cancel path leaves event `DRAFT`.
- [ ] No tier-name conditionals anywhere (`if (tier === ...)` rejected per
      architecture §18 discipline).
- [ ] PR references this design doc and the story.

---

## 13. Open Questions / Assumptions

| # | Item | Status |
|---|---|---|
| Q1 | **MVP 1 price** not finalized (architecture §17). | Assumption: seed uses a placeholder (e.g. `$49.00`); real price set once decided; Stripe Price ID updated on the `Package` row. No code change needed — price is data. |
| Q2 | Checkout line item: stored Stripe **Price ID** vs inline `price_data`. | Assumption: prefer stored `stripePriceId` (Stripe is price source of truth). Inline `price_data` from `priceCents` is an acceptable fallback if no Price exists yet. |
| Q3 | Do `AuditLog` / `NotificationLog` models already exist on `main` by Story 4? | If not, Story 4 adds them per architecture §7.1. Resolve at implementation. |
| Q4 | Slug/QR/share-text generation: at **draft creation** (Story 3) or at **activation** (architecture §6.1 sequence shows it at activation). | Assumption: generated at draft creation in Story 3 (so the organizer sees the URL pre-payment); activation only flips status. Confirm against the Story 3 design. |
| Q5 | Should `Event.stripeSessionId` be `@unique`? | Trade-off: `@unique` hardens dedupe but blocks creating a fresh session after expiry. Assumption: plain index + app-level guard, to allow a "try again" after an expired/canceled session. |
| Q6 | On `checkout.session.expired`, set `paymentStatus=FAILED` or leave `PENDING`? | Assumption: set `FAILED` only when it was `PENDING` for that exact session, so an abandoned attempt is distinguishable from "never started". Low stakes; revisit if it confuses the UI. |
| Q7 | Currency: hardcode `usd` for MVP 1? | Assumption: yes (`Package.currency` default `"usd"`); field exists for future flexibility, not exercised in MVP 1. |

---

*Design only. Implementation in the Story 4 PR. Sources: requirements.md §4/§5.1/§8,
architecture.md §6.1/§7.1/§10/§11.1/§13/§14/§16, development-setup.md §5/§7, branding.md.*
