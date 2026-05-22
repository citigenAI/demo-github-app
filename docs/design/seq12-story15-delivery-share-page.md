# Sequence 12 / Story 15 — Delivery: Share Page + Download Link + Delivery Email

**Implementation design document. Design-level only — NO CODE.** This spec defines exact
contracts (the public share route + its security headers, share-token generation, the SharePage
creation trigger off an approved/available `FinalVideo`, the secure time-limited download
mechanism, the organizer-only delivery email through the `Channel` interface with the honoree
suppression filter, view counting, and every error case) so a later code-generation step
implements exactly this and nothing more. Where a value is a proposal awaiting confirmation it is
flagged **[CONFIRM]**; genuine ambiguities are listed in §13, not silently chosen. **No code
appears in this document.**

| Field | Value |
|---|---|
| Story number / title | Story 15 — Share page + download link + delivery email |
| Epic | H — Delivery |
| Sequence number | 12 (this is the 12th design in build order) |
| Depends on | **Story 14 (Editor upload back + admin review)** — the manual-path *approve* action that produces an approved `FinalVideo` and triggers delivery — **OR Story 17 (AI video assembly + encoding)** — the AI-path completion that produces `FinalVideo` variants. Delivery fires **whenever a `FinalVideo` becomes approved/available for an event, from either path** (`docs/stories.md` row 15: "Depends On: 14 (or 17)"). |
| Also assumes on `main` | Story 1 (typed `config` in `src/config/env.ts` + `src/config/index.ts`, Prisma client `src/lib/db.ts`, Redis/BullMQ, `logger`, worker scaffold, CI); Story 3 (`Event` + `OccasionType`/`EventStatus` incl. `DELIVERED`, `organizerId → User`, `slug`, `deliveryDate`); Story 6 (object-storage layer + presigned-URL helper, MinIO dev / R2 prod); Story 7 (admin auth gate + `/admin/events/[id]` detail layout + `requireAdmin`); Story 8 (`AuditLog` model + audit-in-transaction pattern); Story 9 (BullMQ queue registry + `enqueue` helper + idempotency `jobId` convention); Story 18 (the **`Channel` interface + shared notification dispatcher + `NotificationLog` dedupe + the honoree-suppression filter**). `FinalVideo` model + `VideoSource`/`VideoVariant` enums are introduced by whichever of Story 14/17 lands first (this story only **reads** them — see §3, §13 Q4). |
| Unlocks | Story 19 (Data retention — keys its 30-day lifecycle off delivery; `SharePage`/`FinalVideo` are part of what hard-delete removes — `architecture.md` §11.4). |
| Complexity | M (1–3 days) |

> **Sources of truth honored:** `docs/requirements.md` §5.8 (Video Output — *Download link = secure
> time-limited URL sent to organizer*; *Private share page = `/share/{token}`, password-OPTIONAL
> viewing page*; MVP 1 = token URL, **no** password protection), §4 MVP 1 ("Download link" +
> "Private share page (token URL; no password protection in MVP 1)"), §8 (share page must support
> optional password — *schema present, UI deferred to MVP 2*; surprise integrity), §9 (out of scope:
> **honoree-facing flow** — the app workflow ends at delivery to the organizer). `docs/architecture.md`
> §6.5 end (after admin approval: encode variants → **generate share page** → **notify organizer**),
> §10.1 Surprise Integrity Controls (share page `noindex,nofollow` + Referrer-Policy headers; token
> 32-byte cryptographically random; URL never logged in full — `/share/[redacted]`; optional password
> required only when `is_surprise` [MVP 2]; OG/preview images honoree-name-free), §7.1 (`SharePage`
> model — `token @unique`, `passwordHash` optional, `expiresAt`, `viewCount`; `FinalVideo` model),
> §7.2 (object-storage layout — `share/poster.jpg`; `final/` served via CDN signed URLs 24h;
> presigned GET 15-min), §1 (architectural driver: **surprise integrity** is load-bearing),
> §10.2 (share access is **anonymous via token** — no login), §14 (env vars — `CDN_DOMAIN`,
> `CDN_SIGNING_KEY`, `NEXT_PUBLIC_SHARE_DOMAIN`, `RESEND_*`), §16 (config single-source).
> Also: `docs/branding.md` (share-page visual design + the delivery-email copy — §11 "Delivery email
> — video ready"), `docs/stories.md`, `docs/stories/story-01-foundation.md` (doc + config style),
> `CLAUDE.md`, `prisma/schema.prisma` (current: `User` + `Role` only), and the sibling designs
> `seq06-story18-reminder-automation.md` (the `Channel` interface, shared dispatcher, honoree
> suppression filter, `NotificationLog` dedupe — **reused verbatim** here), and
> `seq05-story07-admin-dashboard-readonly.md` (admin event-detail surface — the delivery-status row
> is added here; §10 of that doc already states "when share pages arrive, admin views must redact the
> token").

> **Note on the upstream `FinalVideo` producers.** At the time of writing,
> `docs/design/seq11-story14-editor-upload-review.md` and
> `docs/design/seq11-story17-ai-video-assembly-encoding.md` are **not present** in the repo.
> This story therefore treats the `FinalVideo` model + `VideoSource`/`VideoVariant` enums and the
> *approve/complete handoff* exactly as specified in `architecture.md` §7.1 (model) and §6.5 (the
> manual-path "approve → generate share page → notify organizer" handoff). When Story 14 and/or
> Story 17 land, **reconcile §3, §5.1, and §13 Q4 against their concrete `FinalVideo` insert and
> delivery-trigger contracts before generating code.** This story is written to consume EITHER path
> without change.

---

## 1. Story Summary

### Goal
Deliver the finished tribute to the **organizer** — and only the organizer. When a `FinalVideo`
becomes approved/available for an event (manual path: admin approves the editor's upload, Story 14;
AI path: encoding completes, Story 17), this story:

1. **Creates a `SharePage`** for the event — a private, token-addressed viewing page at
   **`/share/{token}`** (optionally on a dedicated `NEXT_PUBLIC_SHARE_DOMAIN`), with a 32-byte
   cryptographically random URL-safe token as the *only* access credential (no login —
   `architecture.md` §10.2). The page is `noindex, nofollow` with a strict `Referrer-Policy`, plays
   the master/YouTube video, offers a **secure time-limited download**, and exposes a
   **MVP 2 password seam** (the `passwordHash` column exists; the UI is **not** built).
2. **Issues a secure, time-limited download link** for the master deliverable (and, where the
   package includes them, the Reel / YouTube variants) — a **presigned GET (15-min)** or
   **CDN-signed URL (24h)** per `architecture.md` §7.2.
3. **Sends one delivery email to the organizer** through the **`Channel` interface** (Email, MVP 1)
   built in Story 18 — routed through the **honoree-suppression filter** so the email is **never**
   sent to the honoree, with `NotificationLog` dedupe so it fires at most once.
4. **Flips the event status to `DELIVERED`** and records `share.created` / `delivery.email.sent` in
   the audit/notification logs. **Increments `SharePage.viewCount`** on each share-page view.

This is the moment the product earns its name (`branding.md` §9 — the one "magical" reveal). It is
also where surprise integrity is most load-bearing: a leaked token, an indexed page, a referrer
leak, or an email to the honoree all break the surprise (`architecture.md` §1, §10.1).

### What it adds (delta over what's already on `main`)
- The **`SharePage`** Prisma model (first physical use of `architecture.md` §7.1's model) +
  relation to `Event` + migration.
- The **public share route** `/share/[token]` (App Router) with security headers
  (`noindex,nofollow` + `Referrer-Policy`), the token lookup, the video player, the download action,
  the invalid/expired-token state, and the honoree-name-free OG/meta defaults.
- A **secure download** server endpoint/action that mints a presigned GET (15-min) or CDN-signed URL
  (24h) for the requested `FinalVideo` variant.
- The **delivery trigger**: a `delivery` step (called from the Story 14 approve action and/or the
  Story 17 completion handler, or a small `delivery` job) that creates the `SharePage`, sends the
  organizer email via the shared dispatcher, flips status, and writes audit/notification rows.
- The **delivery email template** (organizer-only) in brand voice (`branding.md` §11).
- A **delivery-status row** on the admin event-detail surface (Story 7) showing "Delivered ✓",
  delivery timestamp, view count, and a **redacted** share URL (`/share/[redacted]`).
- Config additions in **both** config files: `NEXT_PUBLIC_SHARE_DOMAIN`, `CDN_DOMAIN`,
  `CDN_SIGNING_KEY`, plus reuse of `RESEND_*` / the `Channel` config from Story 18 and the storage
  config from Story 6.

### Success criteria
- [ ] When a `FinalVideo` is approved/available (from Story 14 approve **or** Story 17 completion),
      exactly one `SharePage` is created for the event, with a unique 32-byte URL-safe token and
      `viewCount = 0`.
- [ ] Visiting `/share/{token}` for a valid, non-expired token renders the tribute (video player +
      download), responds with `noindex,nofollow` + a strict `Referrer-Policy`, and **increments
      `viewCount`**.
- [ ] An invalid token → **404**; an expired token → **410 Gone** — neither leaks event/honoree data.
- [ ] The download action returns a working, time-limited URL (presigned GET 15-min **or** CDN-signed
      24h) for the master variant; the link expires per policy.
- [ ] Exactly one **delivery email** is sent, **to the organizer only**; an attempt to the honoree is
      **suppressed and logged** (`status = suppressed_surprise`) and never delivered.
- [ ] The full token never appears in any log (URL logged as `/share/[redacted]`); OG/meta carry **no
      honoree name** by default.
- [ ] Event status is `DELIVERED`; `AuditLog` has a `share.created` row; `NotificationLog` has the
      `delivery.organizer` send (and the dispatch is idempotent under retry).
- [ ] New env vars present in **both** config files; no `process.env` read outside
      `src/config/env.ts` (ESLint `no-restricted-syntax` stays green).
- [ ] Unit + integration tests (§9) pass; integration tests skip cleanly under `SKIP_INTEGRATION`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; deploys.

### What it unlocks
- **Story 19 (Data retention)** keys the 30-day lifecycle off delivery and hard-deletes `SharePage` +
  `FinalVideo` + `final/` objects (`architecture.md` §11.4).

---

## 2. Scope

### In scope (this story)
- The **`SharePage`** model + migration + `Event` relation (§6).
- **SharePage creation** triggered on final-video approval/availability — works for **both** the
  manual (Story 14 approve) and AI (Story 17 completion) paths (§5.1).
- **32-byte URL-safe cryptographically random token** generation + uniqueness handling (§5.2).
- The **public share route** `/share/[token]` — token lookup, security headers
  (`noindex,nofollow` + `Referrer-Policy`), video player (master / YouTube), download action,
  honoree-name-free OG/meta defaults, invalid/expired-token states, **`viewCount` increment** (§4, §5.3).
- **Secure time-limited download:** presigned GET (15-min) **or** CDN-signed URL (24h) for the
  `FinalVideo` variant(s) (§5.4, §7).
- The **organizer-only delivery email** through the Story 18 `Channel` interface + shared dispatcher,
  passing the **honoree-suppression filter**, deduped via `NotificationLog` (§5.5).
- **Event status flip → `DELIVERED`** and audit/notification logging (§5.6, §11).
- An **optional `expiresAt`** on `SharePage` (the delivery email says "the link stays live for 30
  days" — `branding.md` §11; see §5.7, §13 Q3).
- A **delivery-status row** on the admin event-detail surface (token **redacted**) (§4.4).
- Config additions in **both** config files (§7).
- Seed data: an event with a `FinalVideo` + a valid `SharePage` token, plus an **expired-token**
  example (§8).
- Tests: token randomness/uniqueness, headers present, surprise filter (never email honoree),
  expired/invalid token handling, download URL expiry, view-count increment, approve→sharepage+email
  (§9).

### Out of scope (deferred — with owners)
| Deferred item | Owner / where |
|---|---|
| **Password-protected share page UI** (set password as organizer; bcrypt verify on view; required when `is_surprise`) | **MVP 2** — `SharePage.passwordHash` column ships now (the schema seam); the *UI + verification flow* is deferred (`requirements.md` §4/§8; `architecture.md` §10.1 #4, §18 MVP 2 table). This doc designs the **seam** only (§5.3, §10), it does not build password protection. |
| **`Event.is_surprise` flag** (drives "password required") | **MVP 2** — not collected in MVP 1 (no organizer field for it today). Flagged §13 Q5. |
| **Honoree-facing flow** (reveal to honoree, honoree playback page, honoree notification) | **Permanently out of scope (v1)** — the app ends at delivery to the organizer (`requirements.md` §9; `architecture.md` §15). This story sends nothing to, and builds nothing for, the honoree. |
| **The `FinalVideo` rows themselves** (encoding, variants, editor upload) | **Stories 14 / 17** — this story only **reads** `FinalVideo`. |
| **Richer "after event date" OG previews** (opt-in honoree-name imagery) | MVP 2+ (`architecture.md` §10.1 #5) — MVP 1 OG is honoree-name-free, always. |
| **Data-retention deletion of the share page / link expiry sweeps** | **Story 19** (`architecture.md` §11.4). This story may set `expiresAt`; Story 19 owns the lifecycle/deletion cron. |
| **Organizer "regenerate share link" / rotate token** action | Out of MVP 1 (flagged §13 Q6). The schema supports a future rotate (token is `@unique`, replaceable). |
| **Share-page view analytics beyond a counter** (per-view log, geo, unique-visitor) | Out of MVP 1 — `viewCount` is a single integer (§5.3). |

**Surprise-integrity note (scope-level):** every choice in this story is bounded by the surprise
driver. The share page is anonymous-via-token (no login), unindexable, referrer-suppressed, and
honoree-name-free; the delivery email goes to the organizer **only** and is filtered against the
honoree address. Nothing here ever contacts or surfaces to the honoree.

---

## 3. Dependencies & Sequence

### Must already be on `main`
- **Story 1 (Foundation):** typed `config` (`src/config/env.ts` + `src/config/index.ts`), Prisma
  client (`src/lib/db.ts`), Redis/BullMQ, `logger`, worker entry (`src/workers/index.ts`), CI.
- **Story 3 (Event creation):** `Event` with `organizerId → User`, `honoreeName`, `occasionType`,
  `slug`, `deliveryDate`, `status: EventStatus` (incl. the `DELIVERED` value), and (when present)
  `honoreeEmail` — currently **absent** per Story 3's assumption; the honoree filter is a no-op when
  null but is present and ready (see §10, §13 Q1). The organizer's email is `Event.organizer.email`.
- **Story 6 (Media uploads):** the **object-storage abstraction + presigned-URL helper**
  (MinIO dev / R2 prod) — reused to mint the **presigned GET** for downloads (§5.4).
- **Story 7 (Admin dashboard):** `requireAdmin()` + the `/admin/events/[id]` detail layout — the
  delivery-status row is added to it here (§4.4). Story 7 §10 already mandates token redaction.
- **Story 8 (Submission approval):** `AuditLog` model + the audit-in-transaction pattern reused for
  `share.created` (§11).
- **Story 9 (Workers):** the BullMQ queue registry + `enqueue` helper + idempotency `jobId`
  convention — used if delivery runs as a small `delivery` job rather than inline (§5.1, §13 Q7).
- **Story 18 (Reminder automation):** the **`Channel` interface + shared notification dispatcher +
  honoree-suppression filter + `NotificationLog` dedupe**. This story **adds a trigger + template**,
  not new notification plumbing (`seq06-story18` §3 "What this unlocks").
- **`FinalVideo` model + `VideoSource`/`VideoVariant` enums:** introduced by whichever of
  **Story 14 or Story 17** lands first. This story reads `FinalVideo` (variant = `MASTER` primary,
  optional `REEL`/`YOUTUBE`/`THUMBNAIL`); it does not own that model. (§13 Q4.)

### The delivery trigger works for BOTH paths (the core dependency design)
Delivery is **producer-agnostic**. It fires on the single fact "an approved/available `FinalVideo`
now exists for this event," regardless of which path produced it:

| Path | Producer (upstream story) | Hand-off into this story |
|---|---|---|
| **Manual** | Story 14 — admin **approves** the editor's uploaded `final.mp4` | `architecture.md` §6.5: approve → enqueue encode variants → **generate share page → notify organizer**. Story 14's approve action calls this story's **`deliverEvent(eventId)`** entry point (§5.1) once a `FinalVideo` (source `EDITOR_UPLOADED`) is present. |
| **AI** | Story 17 — FFmpeg encoder produces master + Reel + YouTube + thumbnail variants | On encoding completion, Story 17 calls the same **`deliverEvent(eventId)`** entry point once `FinalVideo` rows (source `AI_GENERATED`) exist. |

Both call **one** idempotent entry point. The trigger does not care about `VideoSource`; it selects
the event's `FinalVideo` rows, picks the `MASTER` (and any available `REEL`/`YOUTUBE` for download),
and proceeds. **Idempotency:** `deliverEvent` is safe to call more than once — if a `SharePage`
already exists and the delivery email is already logged `sent`, it no-ops (§5.1, §5.6). This handles
re-approval, retried jobs, and the both-paths-exist edge (§13 Q2).

### Sequence within this story
```
1. Schema: add SharePage model + Event relation → verify: prisma migrate runs, generate clean
2. Config: add NEXT_PUBLIC_SHARE_DOMAIN, CDN_DOMAIN, CDN_SIGNING_KEY in env.ts + index.ts → verify: config parses
3. Token + SharePage creation: deliverEvent() creates SharePage (32-byte token, optional expiresAt) idempotently → verify: unit + integration
4. Share route: /share/[token] lookup, security headers, player, viewCount++, invalid/expired states → verify: route tests
5. Download: presigned GET (15-min) or CDN-signed (24h) for FinalVideo variant → verify: URL minted + expiry tests
6. Delivery email: organizer-only template via Channel dispatcher (honoree filter + dedupe) → verify: send + suppression tests
7. Status flip + audit/notification logging; admin delivery-status row (token redacted) → verify: status=DELIVERED, logs present
8. Seed + tests + DoD → verify: lint/typecheck/test green
```

---

## 4. Frontend / UI Design

Two distinct surfaces: the **public share page** (the only honoree-/recipient-visible UI in the
product — though intended for the *organizer*, it is anonymous-via-token) and an **admin
delivery-status row**. There is **no honoree-facing flow** (`requirements.md` §9) and **no organizer
password-setting UI** in MVP 1 (§2).

All copy follows `branding.md`: warm, calm, **no exclamation marks**, **honoree name spelled exactly
as stored** (branding §10 — but **never** placed in indexable OG/meta, §10), occasion-aware nouns,
Fraunces (display) + Inter (body), Lucide outline icons, palette tokens. The share page is the
**one** place the signature gradient + gentle gold reveal (≤700ms, never on repeat) is earned
(`branding.md` §4, §9).

### 4.1 Share route — confirm path & domain
- **Path:** `/share/[token]` (App Router dynamic segment). `[token]` is the `SharePage.token`, **not**
  the event slug — share access is a distinct concern (`architecture.md` §7.1 schema decision).
- **Domain [CONFIRM]:** the share page **may** live on a dedicated `NEXT_PUBLIC_SHARE_DOMAIN`
  (`architecture.md` §14 — "share pages may live on a different domain"). Two viable shapes (decide
  at code time — §13 Q1):
  - **(A) Same Next.js app, separate hostname:** `NEXT_PUBLIC_SHARE_DOMAIN` (e.g.
    `share.swaramagical.com`) points at the same deployment; the `/share/[token]` route is served
    from it. The delivery email + canonical share URL are built from `NEXT_PUBLIC_SHARE_DOMAIN` when
    set, falling back to `NEXT_PUBLIC_APP_URL`.
  - **(B) App-domain path:** `/share/{token}` lives under `NEXT_PUBLIC_APP_URL` if no separate share
    domain is configured.
  - **Recommendation:** support both via a single `shareBaseUrl` config accessor
    (`NEXT_PUBLIC_SHARE_DOMAIN ?? NEXT_PUBLIC_APP_URL`); MVP 1 may ship (B) and adopt (A) later
    without code change. A separate domain has a real surprise-integrity benefit (the share host
    carries no organizer/admin cookies and no app branding that hints at the honoree) — §10.

### 4.2 Share page layout (the recipient view)
| Element | Content / behavior |
|---|---|
| **Header / banner** | The signature gradient banner (`branding.md` §4). Wordmark "Swara Magical Memories — by Swara Media" (branding §6). **No honoree name in the page `<title>` or OG/meta** (§10); the honoree name **may** appear in the on-page H1 (e.g. "{HonoreeName}'s {occasion} tribute") because the page body is behind the unguessable token and `noindex` — see §10 / §13 Q7 for the on-page-name decision. **[CONFIRM]** |
| **Video player** | Plays the **master** variant by default (1920×1080); a YouTube variant may back an alternate source (`requirements.md` §5.8 "video player [master/youtube]"). The player streams from a **CDN-signed URL (24h)** (`architecture.md` §7.2 — `final/` served via CDN signed URLs). Poster image = `share/poster.jpg` (honoree-name-free; §7). |
| **Download action** | A "Download" button per available variant (master always; Reel/YouTube when the package includes them — §13 Q8). Clicking calls the secure-download action (§5.4) and starts the time-limited download. Copy: "Download" (sentence case, no "!"). |
| **Reveal motion** | The one signature moment: a gentle fade-up + subtle gold sparkle on first load (`branding.md` §9), ≤700ms, never repeating. |
| **Password seam (hidden in MVP 1)** | The page is **publicly viewable with the token alone** in MVP 1. The layout reserves the place where a password prompt would sit (MVP 2). No password input renders in MVP 1 (§5.3, §10). |
| **Footer** | "by Swara Media" lockup (branding §6). No honoree contact, no "share with the honoree" affordance, no link back into the authenticated app. |

### 4.3 Share page states
| State | Behavior |
|---|---|
| **Valid token, video ready** | Render the player + download(s); increment `viewCount` (§5.3); set security headers (§5.3). |
| **Invalid / unknown token** | Render a calm, **generic** not-found page; HTTP **404**. **No** event/honoree detail, **no** "did you mean", **no** enumeration. Copy: "This link isn't valid." (§5.3, §10). |
| **Expired token** (`expiresAt` in the past) | Render a calm expired page; HTTP **410 Gone**. Copy: "This link has expired. Contact the event organizer for a new one." (No honoree name; the organizer is the recovery path — `requirements.md` §9.) (§5.3.) |
| **Token valid but no `FinalVideo` yet** | Should not normally occur (the page is created only at delivery), but render a calm "Your tribute is being prepared." with **no** download; HTTP 200. Defensive only (§5.3, §13 Q9). |
| **Loading** | Quietly purposeful skeleton (branding §9, 200ms). |
| **Error** | Calm inline "We couldn't load this right now. Please try again." Never expose internals. |

> Surprise note: **every** non-success state is honoree-name-free and detail-free, so an attacker
> probing tokens learns nothing about who/what the event is.

### 4.4 Admin delivery-status (added to Story 7 event detail)
On `/admin/events/[id]` (admin-gated, `requireAdmin`), add a small **read-only** "Delivery" section:
| Field | Display | Notes |
|---|---|---|
| Delivered? | "Delivered ✓" / "Not delivered" | from `Event.status === DELIVERED` and SharePage existence |
| Delivered at | short functional date+time | from `SharePage.createdAt` / the `share.created` audit row |
| Share URL | **`/share/[redacted]`** | the token is **never** rendered in full to admin (`architecture.md` §10.1 #3; Story 7 §10). A "copy full link" affordance is **out of scope** (§13 Q6). |
| View count | integer | from `SharePage.viewCount` |
| Delivery email | "Sent ✓" / "Suppressed" / "Failed" | from `NotificationLog` for trigger `delivery.organizer` |

No mutation controls (no "resend", no "rotate" in MVP 1 — §2, §13 Q6).

### 4.5 Branding specifics
- Share page is the **celebratory** surface — gradient banner + the single gold-sparkle reveal are
  permitted here and **only** here in this story (`branding.md` §4, §9). The admin row is operational
  (no gradient).
- Delivery email copy follows `branding.md` §11 "Delivery email — video ready" verbatim in tone
  (see §5.8): "{HonoreeName}'s {occasion} tribute is ready. Watch it, download it, save it." with
  `[Watch]` (share page) + `[Download]` actions and "the link stays live for 30 days," "by Swara
  Media" footer. **No exclamation marks** (branding §10).

---

## 5. Backend / API Design

The web parts (the `/share/[token]` route, the download action) run on Vercel (sync, < 60s —
`architecture.md` §4). The **delivery trigger** is invoked from the upstream approve/complete action
(Story 14 / 17); it is **idempotent** and may run inline in that action or as a tiny `delivery`
BullMQ job (§5.1, §13 Q7). All notification sending goes through the **Story 18 dispatcher**.

### 5.1 SharePage creation — `deliverEvent(eventId)` (the trigger)
**Single idempotent entry point** called by both producers (§3). Algorithm:

1. **Guard / preconditions.** Load the `Event` (with `organizer`) and its `FinalVideo` rows. Require
   at least a `MASTER` `FinalVideo` to exist; if none, **no-op** and log (defensive — the producer
   should not call before a `FinalVideo` exists; §13 Q9). [CONFIRM] whether `MASTER` is mandatory or
   any variant suffices — recommendation: require `MASTER`.
2. **Create `SharePage` (idempotent).** If a `SharePage` already exists for `eventId` (the model is
   `eventId @unique`) → reuse it (do **not** mint a new token, do **not** reset `viewCount`).
   Otherwise create one with:
   - `token` = a freshly generated 32-byte URL-safe random string (§5.2),
   - `passwordHash = null` (MVP 1 — the seam; §10),
   - `expiresAt` = per §5.7 policy (default: `deliveryDate`-anchored or null — §13 Q3),
   - `viewCount = 0`.
   Use an **upsert/create-if-absent** keyed on `eventId` so concurrent producers (the both-paths edge)
   cannot create two share pages; on the unique-constraint race, fetch the existing row.
3. **Send the delivery email** to the **organizer** via the shared dispatcher (§5.5) — deduped on
   `(eventId, "delivery.organizer", organizerEmail)`. If already `sent`, the dispatcher no-ops.
4. **Flip event status → `DELIVERED`** (conditional update; §5.6).
5. **Audit:** write `AuditLog { action: "share.created", eventId, actorId: <admin or system>,
   metadata: { source: VideoSource, hasReel, hasYoutube } }` — **token NOT in metadata** (§10, §11).
6. Return a result the caller can log: `{ sharePageCreated: boolean, deliveryEmail: "sent" |
   "suppressed_surprise" | "failed" | "deduped", status: "DELIVERED" }`. **No token in the return
   that gets logged in full.**

> **Inline vs job:** the whole sequence is small (one DB write + one email + one status flip). It may
> run **inline** in the Story 14 approve action / Story 17 completion handler, or as a `delivery`
> BullMQ job for retry isolation. Either is acceptable; idempotency (steps 2–4) makes both safe.
> **Recommendation:** inline for the manual path (admin is waiting on the approve response) with the
> email dispatch itself retried by the dispatcher (§5.5); a job is fine for the AI path. (§13 Q7.)

### 5.2 Token generation
| Property | Contract |
|---|---|
| **Entropy** | **32 bytes** from a cryptographically secure RNG (Node `crypto.randomBytes(32)` / `webcrypto.getRandomValues`). `architecture.md` §10.1 #3. |
| **Encoding** | **URL-safe** (base64url or base62), no padding, no `+`/`/`/`=` — safe in a path segment and in email links. Resulting length ~43 chars (base64url of 32 bytes). |
| **Uniqueness** | Stored in `SharePage.token @unique`. On the astronomically unlikely collision, the unique constraint rejects the insert → **regenerate and retry** (bounded retry, e.g. 3 attempts) before surfacing an error. |
| **Opacity** | The token carries **no** event/honoree information (it is random, not derived) — it cannot be reverse-engineered to an event id or name. |
| **Logging** | The token is **never** logged in full anywhere; any log line referencing the share URL uses `/share/[redacted]` (§10, §11). |

### 5.3 The share page route — `/share/[token]`
- **Type:** App Router route (Server Component page, optionally a route handler for the OG image).
  Served from `shareBaseUrl` (§4.1).
- **Lookup:** find `SharePage` by `token`. The lookup is the access control — there is **no session,
  no login** (`architecture.md` §10.2).
- **Branches:**
  - **Not found** → respond **404** with the generic not-found UI (§4.3). No DB detail leaked.
  - **Found but `expiresAt` in the past** → respond **410 Gone** with the expired UI (§4.3).
  - **Found, valid** → load the event's `FinalVideo` rows (for the player + download), render the
    page (§4.2), **increment `viewCount`** (see below), and set the security headers (below).
- **Security headers (LOAD-BEARING — `architecture.md` §10.1 #2):** every response from
  `/share/[token]` (and its sub-requests for the OG image) sets:
  | Header | Value | Why |
  |---|---|---|
  | `X-Robots-Tag` | `noindex, nofollow, noarchive` | keep the page out of search indexes |
  | `<meta name="robots">` | `noindex, nofollow` | belt-and-braces in the HTML head |
  | `Referrer-Policy` | `no-referrer` | the token must **never** leak via the `Referer` header to any third party (e.g. when the embedded video/CDN is fetched, or if the page links out) — `architecture.md` §10.1 #2 |
  | `Cache-Control` | `private, no-store` **[CONFIRM]** | avoid shared-cache/CDN caching of a tokenized page; §13 Q10 |
  - **No `<link rel="canonical">` to an app URL** and no Open Graph tag containing the honoree name
    (§10).
- **View counting:** on a successful valid-token render, increment `viewCount` by 1 via an atomic
  DB increment (`{ increment: 1 }`), **not** a read-modify-write (avoids lost updates under
  concurrency). Counting policy [CONFIRM]: count **every** valid GET render (simple integer; §2). Do
  **not** count 404/410 responses, and do **not** attempt unique-visitor dedup in MVP 1 (§13 Q11).
  Bot/prefetch over-counting is accepted for MVP 1 (the counter is informational, surfaced only to
  admin §4.4).
- **Password seam (MVP 1 = pass-through):** because `passwordHash` is `null` in MVP 1, the route
  serves the page directly. The route is structured so that a future MVP 2 check
  ("if `passwordHash` set and no valid password cookie → render password prompt, 401-style gate")
  slots in **before** rendering the player — but **that branch is not built now** (§10).

### 5.4 Secure download — presigned GET or CDN-signed URL
The **download action** (a server action or thin route handler invoked from the share page's
Download button, and the URL embedded in the delivery email) returns a **time-limited** URL for a
requested `FinalVideo` variant. Two mechanisms, both per `architecture.md` §7.2:

| Mechanism | Expiry | Use | Notes |
|---|---|---|---|
| **CDN-signed URL** | **24h** | **Playback + download** of `final/` objects served via the CDN (`CDN_DOMAIN` + `CDN_SIGNING_KEY`) | `architecture.md` §7.2: "CDN-served paths (final delivery, share page assets) use signed CloudFront/Cloudflare URLs with 24-hour expiry and rotate." This is the **primary** delivery mechanism — the player source and the in-email/in-page download links are CDN-signed (24h). |
| **Presigned GET (S3/R2)** | **15-min** | A short-lived direct-object download when not fronted by the CDN (e.g. dev/MinIO, or a deliberately tighter link) | `architecture.md` §7.2: "Admin downloads use presigned GET (15-minute expiry)." Reuse Story 6's presigned-URL helper. |

**Decision (MVP 1):** use **CDN-signed URLs (24h)** for both the player source and the download links
in the share page + email (so the email's "Download" link works for ~24h without a round-trip), and
fall back to **presigned GET (15-min)** in environments without a CDN (dev/MinIO). The selection is
config-driven (`CDN_DOMAIN`/`CDN_SIGNING_KEY` present → CDN-signed; else presigned). **[CONFIRM]** the
download-link lifetime in the email (24h CDN-signed) vs. minting a fresh short link per click — §13 Q3.

**Variant selection:** `MASTER` is the default deliverable; `REEL` / `YOUTUBE` are offered when the
package includes them and the rows exist (`requirements.md` §5.8; §13 Q8). The action validates the
requested `variant` against the event's actual `FinalVideo` rows and refuses unknown variants (404).

**Access control on download:** the download action is reachable **only with a valid, non-expired
share token** (it takes the token + variant; it re-checks the `SharePage` exactly as §5.3 does). An
invalid/expired token → 404/410, no URL minted. The minted URL itself is the bearer credential for
the bytes; its short/medium expiry bounds exposure (`architecture.md` §10.3 / §7.2). The full token
and the signed URL are **never logged** (§10).

### 5.5 Delivery email — organizer only, via the `Channel` dispatcher
- **Path:** call the **Story 18 shared dispatcher** with a single notification request — **never** a
  `Channel` directly (`seq06-story18` §5.5). The dispatcher owns the honoree filter, dedupe, send,
  retry, and `NotificationLog` write.
- **Dispatcher request (this story's trigger):**
  | Field | Value |
  |---|---|
  | `eventId` | the delivered event |
  | `trigger` | **`delivery.organizer`** (the dedupe + audit key — a new token added by this story) |
  | `recipientType` | `organizer` |
  | `recipientEmail` | `Event.organizer.email` (normalized lowercase) |
  | `channel` | `email` (MVP 1) |
  | `templateId` | `delivery.organizer` (§5.8) |
  | `templateVars` | `{ honoreeName, occasionNoun, shareUrl, downloadUrl, expiresInDays, dashboardUrl }` |
  | `eventContext` | `{ honoreeEmail, honoreeName, occasionType, ... }` — enough for the **honoree filter** and rendering |
- **Honoree suppression (LOAD-BEARING):** the dispatcher's **first** step compares `recipientEmail`
  to `eventContext.honoreeEmail` (case-insensitive, normalized). The organizer email should never
  equal the honoree email, but the filter runs regardless: any match → write `NotificationLog`
  `status = suppressed_surprise`, emit the critical alert (`architecture.md` §13), **send nothing**
  (`seq06-story18` §5.5 step 1; §10 here). When `honoreeEmail` is null/absent (current Story 3 state)
  the comparison is simply never true — the filter is a present-but-inert safety net (§13 Q1).
- **Dedupe / at-most-once:** keyed on `(eventId, "delivery.organizer", organizerEmail)`. If a `sent`
  (or `suppressed_surprise`) row exists → no-op (re-delivery, retried job, or both-paths edge cannot
  double-send) (`seq06-story18` §5.4).
- **Retry:** transient send failure → dispatcher retries (3 attempts, backoff); permanent failure →
  `NotificationLog` `failed` + admin alert (`seq06-story18` §5.6). The admin sees "Failed" in §4.4.
- **Recipients are ONLY the organizer.** No contributor, no admin, **no honoree** copy is sent at
  delivery. (Admins learn of delivery via the dashboard status row, §4.4, not an email — §13 Q12.)

### 5.6 Status flip → `DELIVERED`
- After the SharePage exists and the email dispatch has been attempted, set `Event.status =
  DELIVERED`. Use a **conditional/idempotent** update so a re-run does not fight a concurrent
  transition: only relevant transitions advance to `DELIVERED` (e.g. from `IN_REVIEW` /
  `FINAL_VIDEO_UPLOADED` / `AI_ROUTED` post-encode — the exact prior status depends on the path;
  treat the flip as "set to `DELIVERED` if not already `DELIVERED`"). [CONFIRM] the exact allowed
  prior states with Story 14/17 (§13 Q4).
- The flip is **independent of email success**: a failed delivery email does **not** block marking
  the event delivered (the SharePage exists and is valid; the email is retried by §5.5 and is
  visible as "Failed" to admin). The deliverable is ready regardless of the notification. [CONFIRM]
  — alternative is to keep status pre-`DELIVERED` until the email sends; recommendation: flip on
  SharePage existence, surface email failure separately (§13 Q13).

### 5.7 `expiresAt` policy
- `SharePage.expiresAt` is **nullable**. The delivery email promises "the link stays live for 30
  days" (`branding.md` §11). Two options (§13 Q3):
  - **(A)** `expiresAt = null` in MVP 1 (the share page never expires on its own); the **30-day**
    promise is enforced by **Story 19's retention deletion** (hard-delete at event_date + ~37d), not
    by `expiresAt`. The download links still expire (CDN-signed 24h / presigned 15-min) independently.
  - **(B)** Set `expiresAt = deliveryDate + 30d` (or `createdAt + 30d`) so the share page itself
    returns **410** after the window even before retention deletion.
  - **Recommendation:** **(A)** — keep `expiresAt = null` in MVP 1 and let Story 19 own the lifecycle,
    so we have one source of truth for "how long data lives." The route + tests still fully support a
    non-null `expiresAt` (the expired-token path is built and tested via the seeded expired example,
    §8). The email's "30 days" copy is then a statement about the retention policy, not the token TTL.

### 5.8 Delivery email template (organizer)
Copy follows `branding.md` §11 "Delivery email — video ready": warm, calm, **no exclamation marks**,
**honoree name exactly as stored**, occasion-aware noun (same map as siblings: `GRADUATION→
"graduation"`, `BIRTHDAY→"birthday"`, `WEDDING→"wedding"`, `ANNIVERSARY→"anniversary"`,
`RETIREMENT→"retirement"`, `BUSINESS_EVENT→"business event"`), HTML + plaintext variants, "by Swara
Media" footer.

| Template ID | Trigger | Recipient | One-line voice | Variables |
|---|---|---|---|---|
| `delivery.organizer` | `delivery.organizer` | organizer | "{honoreeName}'s {occasion} tribute is ready. Watch it, download it, save it." | `honoreeName`, `occasionNoun`, `shareUrl` (the `/share/{token}` link on `shareBaseUrl`), `downloadUrl` (CDN-signed/presigned master), `expiresInDays` (e.g. 30), `dashboardUrl` |
| | | | Body actions: **[Watch]** → `shareUrl`, **[Download]** → `downloadUrl`. Reassurance line: "Save it somewhere safe — the link stays live for 30 days." (branding §11). | |

Notes:
- The email is the **one** place a working share link is delivered. The `shareUrl` **does** contain
  the full token (it must — it is the access credential the organizer uses); the token therefore
  exists in the email body but is **never written to logs** (the `NotificationLog` row stores
  `trigger`/`recipientType`/`status`, **not** the URL — `architecture.md` §7.1 fields; §10/§11).
- The email **never** references or offers to notify the honoree, never carries the honoree's
  contact, and never suggests "share with {honoree}" (`branding.md`, surprise integrity).
- Subject in brand voice, no "!": e.g. "{honoreeName}'s {occasion} tribute is ready".

### 5.9 Endpoints / operations summary
| Method | Path / op | Auth | Request | Response | Status codes |
|---|---|---|---|---|---|
| GET | `/share/[token]` | **anonymous (token is the credential)** | path `token` | HTML share page + security headers; `viewCount++` | **200** (valid); **404** (unknown token); **410** (expired) |
| POST/action | secure-download action (token + variant) | **anonymous + valid token** | `{ token, variant }` | a time-limited URL (CDN-signed 24h / presigned 15-min) | 200 (URL); 404 (unknown token/variant); 410 (expired token) |
| GET | `/share/[token]` OG image (if a route handler) | anonymous | path `token` | **honoree-name-free** image (`share/poster.jpg`) + `noindex` headers | 200; 404; 410 |
| internal | `deliverEvent(eventId)` | called by Story 14 approve / Story 17 completion (admin/system context) | `eventId` | `{ sharePageCreated, deliveryEmail, status }` | n/a (internal) |
| GET | `/admin/events/[id]` (delivery row) | **admin session** (`requireAdmin`) | path `id` | HTML incl. delivery status (**token redacted**) | 200; 302 (non-admin) |

---

## 6. Database Design

This story physically introduces **`SharePage`** (fully specified in `architecture.md` §7.1; this is
its owning story) + the `Event` back-relation. No other model changes. **`FinalVideo`** is owned by
Story 14/17 — this story only adds (if not already present) the `Event ↔ FinalVideo` read usage.

### 6.1 `SharePage` model — fields
Matches `architecture.md` §7.1 exactly (so no later story renames anything):

| Field | Type | Null? | Default | Notes |
|---|---|---|---|---|
| `id` | String (cuid) | no | `cuid()` | PK |
| `eventId` | String | no | — | FK → `Event.id`; **`@unique`** (one share page per event) |
| `event` | relation `Event` | — | — | `@relation(fields: [eventId], references: [id], onDelete: Cascade)` (share page is meaningless without its event; retention/right-to-delete removes it — `architecture.md` §11.4) |
| `token` | String | no | — | **`@unique`**; 32-byte URL-safe cryptographically random (§5.2); the share URL credential |
| `passwordHash` | String | **yes** | `null` | **MVP 2 seam** — column ships now; **no** password UI/verification in MVP 1 (§10) |
| `expiresAt` | DateTime | **yes** | `null` | optional expiry; MVP 1 default `null` (§5.7); when in the past → route returns **410** |
| `viewCount` | Int | no | `0` | atomic `{ increment: 1 }` per valid render (§5.3) |
| `createdAt` | DateTime | no | `now()` | delivery timestamp (used by admin §4.4 + retention) |

> Field names/types are taken **verbatim** from `architecture.md` §7.1 — do not "improve" them. The
> model is intentionally minimal (no per-view log, no rotation history — §2).

### 6.2 Indexes & constraints
| Index / constraint | Definition | Purpose |
|---|---|---|
| `token @unique` | unique index on `token` | the share-route lookup is by `token`; uniqueness also catches the (astronomically rare) collision on insert (§5.2) |
| `eventId @unique` | unique index on `eventId` | enforces one `SharePage` per event; makes `deliverEvent` create-if-absent race-safe (§5.1) |
| FK `eventId → Event.id` | `onDelete: Cascade` | share page removed with the event (retention / right-to-delete — `architecture.md` §11.4) |

No additional index needed (lookups are by the two unique columns).

### 6.3 `Event` changes
- **Add** the back-relation `sharePage SharePage?` on `Event` (the other side of the `eventId @unique`
  FK — one-to-optional-one).
- **No new `Event` columns.** In particular, **no `is_surprise` column** in MVP 1 (that flag, which
  would make password "required," is MVP 2 — §2, §13 Q5). `honoreeEmail` remains whatever Story 3
  merged (currently absent); the honoree filter handles null (§10).
- `Event.status` already includes `DELIVERED` (`architecture.md` §7.1 enum) — no enum change.
- The `Event ↔ FinalVideo` relation (`finalVideos FinalVideo[]`) is declared by Story 14/17; this
  story consumes it. If neither has merged when this story is built, coordinate so the relation +
  `FinalVideo` model land first (§3, §13 Q4).

### 6.4 Migration notes
- Migration name e.g. `add_share_page` — creates the `share_page` table, the `token` + `eventId`
  unique indexes, the FK with `ON DELETE CASCADE`, and the `Event.sharePage` back-relation (virtual).
- **Additive only** — no backfill, no destructive change; safe to `prisma migrate deploy` against
  `swara_prd` (Story 1's pooled `DATABASE_URL` / direct `DIRECT_URL` convention).
- Run `prisma generate` after migrate so `SharePage` types are available to web + workers; verify
  `npm run typecheck` clean.
- **Prerequisite:** references `Event.id`; the `FinalVideo` read path requires the Story 14/17
  migration that creates `FinalVideo` to precede this in history (§3).

---

## 7. External Services / Integrations / Config

### 7.1 External services
- **CDN (Cloudflare / CloudFront)** — serves `final/` objects + `share/poster.jpg` via **signed URLs
  (24h)** using `CDN_DOMAIN` + `CDN_SIGNING_KEY` (`architecture.md` §4, §7.2, §14). New: the signing
  helper that produces a signed URL for a storage key (the exact signing scheme depends on the chosen
  CDN — Cloudflare signed URLs vs CloudFront signed URLs — §13 Q14).
- **Object storage (S3/R2, MinIO in dev)** — reused from Story 6 for **presigned GET (15-min)** as
  the non-CDN fallback (§5.4).
- **Resend** (prod email) / **Mailpit** (dev SMTP) — via the **Story 18 `EmailChannel`**; this story
  adds **no** new email infra, only a template + trigger (`seq06-story18` §7).
- **Redis / BullMQ** — reused only if delivery runs as a `delivery` job (§5.1); no new Redis.
- **No honoree-facing service, no WhatsApp** at delivery (MVP 1).

### 7.2 Config — add in BOTH `src/config/env.ts` and `src/config/index.ts`
Per the load-bearing convention (`story-01-foundation.md` §3, `architecture.md` §16): every new var
is read **only** in `src/config/env.ts` (raw) and validated/typed in `src/config/index.ts` (Zod).
No `process.env` elsewhere (ESLint `no-restricted-syntax`). Add each to `.env.example` too.

**Raw reads to add in `src/config/env.ts`:**
`NEXT_PUBLIC_SHARE_DOMAIN`, `CDN_DOMAIN`, `CDN_SIGNING_KEY`.

**Typed config to add in `src/config/index.ts`:**
| Config field | Env var | Type | Default | Notes |
|---|---|---|---|---|
| `share.domain` | `NEXT_PUBLIC_SHARE_DOMAIN` | string (url/host)? | unset → fall back to `app.publicUrl` | builds `shareBaseUrl` for `/share/{token}` links + the email `shareUrl` (§4.1). `NEXT_PUBLIC_*` so it is available to client where needed. |
| `cdn.domain` | `CDN_DOMAIN` | string (host)? | — | e.g. `media.swaramagical.com`; presence selects CDN-signed downloads over presigned (§5.4) |
| `cdn.signingKey` | `CDN_SIGNING_KEY` | string? | — | secret used to sign CDN URLs; **server-only**, never sent to client, never logged |

**Already present — this story USES, does not re-add:**
- `NEXT_PUBLIC_APP_URL` (Story 1) — `shareBaseUrl` fallback + `dashboardUrl`.
- `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, the `email.*` block + `Channel`/dispatcher config
  (Story 18).
- `S3_*` storage config + the presigned-URL helper (Story 6).

**Zod refinements:**
- When `cdn.domain` is set, `cdn.signingKey` is **required** (a CDN domain without a signing key
  cannot sign URLs). In `env === "production"`, require both `cdn.domain` and `cdn.signingKey`
  (prod delivery must use signed CDN URLs — fail fast at boot if missing). In dev/test they may be
  empty (falls back to presigned GET against MinIO). **[CONFIRM]** prod-required (§13 Q14).
- `share.domain` is optional everywhere; when unset the share links use `app.publicUrl`.

> Add **only** the three vars this story needs. Do not re-add Story 18 / Story 6 vars. `CDN_SIGNING_KEY`
> is a secret: read only via `config`, never logged, never shipped to the client (it is **not**
> `NEXT_PUBLIC_*`).

### 7.3 Object storage paths used
- **Playback / download source:** `events/{event_id}/final/master.mp4` (+ `reel.mp4`, `youtube.mp4`
  where present) — `architecture.md` §7.2. Served CDN-signed (24h) / presigned (15-min).
- **OG / poster image:** `events/{event_id}/share/poster.jpg` — the **honoree-name-free** preview
  image (`architecture.md` §7.2 — "still SAFE for surprise; never honoree's face publicly indexed";
  §10.1 #5). [CONFIRM] who produces `poster.jpg` — likely the encoder/thumbnail step (Story 17) or a
  copy of the auto thumbnail; if absent, the share page uses a brand-only placeholder (§13 Q15).

---

## 8. Seed Data

Extend the idempotent dev/test seed (Stories 3/5/6/7). Seed only in non-production (guard on
`config.env`), upsert by stable key (idempotent), dates relative to seed-run `now`.

| Seed fixture | Setup | Exercises |
|---|---|---|
| **Delivered event + valid share** | An `Event` (`status=DELIVERED`, owned by the seeded organizer, occasion e.g. GRADUATION) with at least a `MASTER` `FinalVideo` row (dummy `final/master.mp4` object) **and** a `SharePage` with a real 32-byte token, `passwordHash=null`, `expiresAt=null`, `viewCount` e.g. 3. | the happy path: `/share/{token}` renders, player + download work, `viewCount` increments; admin delivery row shows "Delivered ✓ / 3 views / `/share/[redacted]`" |
| **Expired-token event** | An `Event` (`status=DELIVERED`) with a `FinalVideo` + a `SharePage` whose `expiresAt = now − 1 day`. | the **410 expired** path (§4.3, §5.3) — proves expired tokens are rejected without leaking data |
| **AI-source vs editor-source** [CONFIRM] | One delivered event whose `FinalVideo.source = AI_GENERATED` and one `= EDITOR_UPLOADED`. | proves delivery is producer-agnostic (§3) — both render/download identically |
| **(optional) Reel + YouTube variants** | The delivered event also has `REEL` + `YOUTUBE` `FinalVideo` rows. | proves the multi-variant download list (§5.4, §13 Q8) |
| **Honoree-suppression case** [only if `honoreeEmail` exists] | A delivered event whose `honoreeEmail` equals the organizer address used as the delivery recipient. | proves the honoree filter logs `suppressed_surprise` and sends nothing (§10) — otherwise covered by unit tests with a synthetic context |

Also seed:
- Reuse the seeded **organizer `User`** (e.g. `organizer@example.com`) as the delivery recipient so a
  delivery email is observable in Mailpit locally.
- The dummy `final/` objects need only exist as storage keys (or be stubbed) so presigned/CDN URL
  generation has something to sign; the seed need not upload real video bytes.
- Seed a matching `NotificationLog` `sent` row (trigger `delivery.organizer`) for the
  already-delivered fixture so dedupe/idempotency tests have data, and an `AuditLog` `share.created`
  row.

All seeded tokens are real random 32-byte values (so token-shape tests pass) but **never** printed to
seed logs (print `/share/[redacted]`).

---

## 9. Testing

Follow the Story 1 pattern (Vitest, `tests/unit` + `tests/integration`, `vite-tsconfig-paths`).
DB/infra-touching tests are gated by **`SKIP_INTEGRATION`**. Email sends are **mocked** (stub the
`Channel`/dispatcher) in unit tests; integration asserts against Mailpit / a captured-send fake.
CDN/presigned URL generation is asserted by **shape + expiry**, not by hitting a live CDN.

### 9.1 Unit tests (pure logic, no DB, no network)
| Test | Asserts |
|---|---|
| **Token randomness / length / encoding** | tokens are 32 bytes of CSRNG output, URL-safe (no `+`/`/`/`=`/path-unsafe chars), ~43 chars; two generations differ; high-entropy (no obvious pattern). |
| **Token uniqueness retry** | a simulated unique-constraint collision triggers regenerate-and-retry (bounded), eventually succeeds; exhausting retries surfaces a clear error. |
| **Security headers present** | a valid share render sets `X-Robots-Tag: noindex, nofollow, noarchive`, emits `<meta robots noindex,nofollow>`, and `Referrer-Policy: no-referrer` (and the chosen `Cache-Control`). |
| **OG/meta honoree-name-free** | the rendered `<title>` and OG tags contain **no** honoree name; the poster reference is `share/poster.jpg` (or the placeholder). |
| **Invalid token → 404** | unknown token yields a 404 with the generic not-found UI and **no** event/honoree detail in the response. |
| **Expired token → 410** | `expiresAt` in the past yields 410 with the expired UI; future/`null` `expiresAt` does not. Boundary: `expiresAt == now` [CONFIRM] (treat as expired). |
| **viewCount increment** | a valid render increments by exactly 1 via atomic increment; 404/410 renders do **not** increment. |
| **Download URL minting + expiry** | CDN-signed URL carries the ~24h expiry; presigned GET carries the 15-min expiry; selection is config-driven (CDN domain present → CDN-signed; absent → presigned); unknown variant → refused; the signing key never appears in the URL beyond the signature param and is never logged. |
| **Surprise filter — never email honoree** | with a context where `recipientEmail == honoreeEmail` (case/space-normalized) → outcome `suppressed_surprise`, **no channel send call**, critical alert emitted; with `honoreeEmail` null → filter inert, organizer send proceeds. (Exercises the Story 18 dispatcher contract.) |
| **Delivery dedupe** | given an existing `sent`/`suppressed_surprise` row for `(eventId,"delivery.organizer",organizerEmail)` → `deliverEvent` no-ops the email; only a `failed` row allows retry. |
| **deliverEvent idempotency** | calling twice (e.g. both paths, or a retried job) creates **one** `SharePage` (same token, `viewCount` not reset), sends **one** email, flips status once. |
| **Status flip** | `deliverEvent` sets `DELIVERED`; a second call does not re-flip / fight; email failure does not block the flip (per §5.6 decision). |
| **Template rendering** | `delivery.organizer` renders with sample vars: honoree name verbatim, correct occasion noun, `[Watch]`→`shareUrl`, `[Download]`→`downloadUrl`, "30 days" copy, "by Swara Media" footer, **no exclamation mark**; HTML + plaintext both produced. |
| **shareBaseUrl resolution** | `share.domain` set → links use it; unset → fall back to `app.publicUrl`. |

### 9.2 Integration tests (DB + mocked/local email; `SKIP_INTEGRATION` gates)
| Test | Flow |
|---|---|
| **approve → SharePage + delivery email** | seed an event with a `MASTER` `FinalVideo` (no SharePage) → invoke `deliverEvent` (simulating the Story 14 approve / Story 17 completion) → assert: exactly one `SharePage` with a unique token, `viewCount=0`, status `DELIVERED`, **one** captured organizer email (mock/Mailpit), one `NotificationLog` `delivery.organizer` `sent`, one `AuditLog` `share.created` (token NOT in metadata). |
| **Re-deliver is idempotent** | call `deliverEvent` twice → no second SharePage, no second email, no status churn. |
| **Both-paths race** | concurrent `deliverEvent` calls (AI + manual) → exactly one SharePage, one email (the `eventId @unique` + dedupe hold). |
| **Share route — valid** | seed delivered event + SharePage → GET `/share/{token}` → 200, security headers present, player/download present, `viewCount` incremented; GET again → incremented again. |
| **Share route — invalid** | GET `/share/{unknown}` → 404, generic, no leak. |
| **Share route — expired** | GET `/share/{expiredToken}` → 410, generic, no leak; `viewCount` NOT incremented. |
| **Download — valid token** | request download for `MASTER` with a valid token → a time-limited URL (assert expiry param/lifetime); request with an expired token → 410, no URL. |
| **Honoree suppression end-to-end** | (only with `honoreeEmail` present) an event whose honoree email collides with the recipient → no email captured, `NotificationLog` `suppressed_surprise`, alert emitted. |
| **Admin delivery row** | as an `ADMIN` session, GET `/admin/events/[id]` for a delivered event → shows "Delivered ✓", view count, and `/share/[redacted]` (the **full token is not present** in the response). |

### 9.3 Tests ↔ success criteria mapping
- Token + headers + OG → §9.1 token/header/OG tests.
- Invalid/expired → 404/410 → §9.1 + §9.2 route tests.
- Download expiry → §9.1 + §9.2 download tests.
- Never email honoree → §9.1 surprise-filter + §9.2 suppression test.
- One SharePage + one email + status → §9.2 approve→delivery + idempotency tests.
- Token never logged / redacted in admin → §9.2 admin-row test + §11 log assertions.

---

## 10. Security & Surprise Integrity

Surprise integrity is the **load-bearing** driver here (`architecture.md` §1). Every control:

| Control | Design |
|---|---|
| **Unguessable token = the only credential** | 32-byte CSRNG, URL-safe, `@unique`, carries no event/honoree info (§5.2). Share access is **anonymous via token, no login** (`architecture.md` §10.2). The search space (2^256) makes enumeration infeasible. |
| **`noindex, nofollow` + `noarchive`** | `X-Robots-Tag` header **and** `<meta robots>` on every `/share/{token}` response (and the OG-image sub-request) so the page never enters a search index (`architecture.md` §10.1 #2). |
| **`Referrer-Policy: no-referrer`** | the token must never leak via `Referer` to any third party (CDN fetch, any outbound link). Set on every share response (`architecture.md` §10.1 #2). |
| **Token never logged in full** | every log line touching the share URL uses **`/share/[redacted]`**; the token is excluded from `AuditLog.metadata`, `NotificationLog` (which stores `trigger`/`status`, not the URL), structured request logs, and error traces (`architecture.md` §10.1 #3; §11). The token **does** appear in the delivery email body (it must — it is the link), but the email body is not logged. |
| **OG / preview honoree-name-free** | by default the OG image is `share/poster.jpg` (or a brand placeholder) and OG/meta carry **no** honoree name (`architecture.md` §10.1 #5). The honoree name **must not** appear in the page `<title>` or any OG tag. (On-page H1 name is behind the token + `noindex`; final call flagged §13 Q7.) |
| **Delivery only to the organizer — never the honoree** | the delivery email goes to `Event.organizer.email` only; it passes the **honoree-suppression filter** (`architecture.md` §10.1 #1; `seq06-story18` §5.5): any recipient == `honoreeEmail` → `suppressed_surprise` + critical alert + no send. The filter is present even though `honoreeEmail` is currently absent (inert no-op until collected — §13 Q1). |
| **No honoree-facing surface at all** | no honoree email, no honoree page, no honoree notification — the app ends at delivery to the organizer (`requirements.md` §9; `architecture.md` §15). |
| **Optional-password seam (MVP 2)** | `passwordHash` ships as a `null` column; the share route is structured so a future "if `passwordHash` set → password gate before render" check slots in (§5.3). **No password UI or verification is built in MVP 1** — the seam is designed, not implemented (`architecture.md` §10.1 #4, §18 MVP 2; `requirements.md` §8). When `Event.is_surprise` arrives (MVP 2), password becomes *required* for surprise events. |
| **Time-limited download** | bytes are reachable only via short/medium-lived signed URLs (CDN-signed 24h / presigned 15-min — `architecture.md` §7.2); private ACL on all objects (`architecture.md` §10.3). The `CDN_SIGNING_KEY` is server-only, never client-shipped, never logged. |
| **Generic, leak-free error states** | 404 (unknown) / 410 (expired) responses are honoree-name-free and detail-free (§4.3) so token probing reveals nothing about who/what the event is. |
| **Separate share host (optional)** | serving `/share/{token}` from `NEXT_PUBLIC_SHARE_DOMAIN` keeps the page free of app/admin cookies and app branding that could hint at the honoree (§4.1) — a defense-in-depth option. |
| **Admin token redaction** | the admin delivery row shows `/share/[redacted]`, never the raw token (`architecture.md` §10.1 #3; Story 7 §10). |

---

## 11. Observability / Audit

| Concern | Design |
|---|---|
| **`share.created` audit** | on SharePage creation, write `AuditLog { action: "share.created", eventId, actorId: <admin user id for manual path / null (system) for AI path>, metadata: { source, hasReel, hasYoutube } }`. **Token is NOT in metadata** (§10). |
| **Delivery notification** | the organizer delivery send is recorded in `NotificationLog` (trigger `delivery.organizer`, `recipientType=organizer`, `status` ∈ `sent`/`failed`/`suppressed_surprise`) via the Story 18 dispatcher — the audit substrate for "was it delivered" (admin §4.4 reads it). |
| **`viewCount`** | the single share-page engagement metric; surfaced only to admin (§4.4). No per-view log in MVP 1 (§2). |
| **No full token in logs** | request logging for `/share/[token]` redacts the path to `/share/[redacted]`; the token is excluded from all structured logs, traces, and error reports (§10). Add a redaction rule for the share path. |
| **Critical alert — honoree suppression** | any `suppressed_surprise` at delivery raises the critical alert from `architecture.md` §13 ("any honoree-email suppression event" → potential data-model bug) — inherited from the Story 18 dispatcher. |
| **Delivery failure alert** | a `failed` delivery email raises the dispatch-failure admin alert (`architecture.md` §11.1) and shows "Failed" in the admin delivery row (§4.4). |
| **Metrics (light)** | "on-time delivery rate" (`architecture.md` §13 business metrics) is computable from `Event.status=DELIVERED` + `SharePage.createdAt` vs `deliveryDate`; this story produces the data, not the dashboard. |

---

## 12. Definition of Done

- [ ] `SharePage` model added (fields/types/uniques per §6, verbatim from `architecture.md` §7.1) +
      `Event.sharePage` back-relation; additive migration `add_share_page` runs clean;
      `prisma generate` + `npm run typecheck` green.
- [ ] `deliverEvent(eventId)` exists as a single **idempotent** entry point callable from both the
      Story 14 approve action and the Story 17 completion handler; creates exactly one `SharePage`
      (32-byte URL-safe token, `passwordHash=null`, `viewCount=0`, `expiresAt` per §5.7), sends one
      organizer email, flips status to `DELIVERED`, writes `share.created` audit (token-free).
- [ ] `/share/[token]` route: valid → 200 with player + download + `noindex,nofollow,noarchive` +
      `Referrer-Policy: no-referrer` + honoree-name-free OG; unknown → 404; expired → 410; `viewCount`
      increments on valid renders only.
- [ ] Secure download mints a working time-limited URL (CDN-signed 24h with `CDN_DOMAIN`/
      `CDN_SIGNING_KEY`; presigned GET 15-min fallback) for the `MASTER` variant (and available
      Reel/YouTube); unknown/invalid variant or token refused; signing key never logged/client-shipped.
- [ ] Delivery email goes through the Story 18 `Channel` dispatcher to the **organizer only**, passes
      the **honoree-suppression filter**, is **deduped** (at most once), and renders in brand voice
      (`branding.md` §11) with `[Watch]`/`[Download]` and the "30 days" line, no exclamation marks.
- [ ] **No** value is ever sent to or surfaced for the honoree; the full token never appears in any
      log (URL redacted to `/share/[redacted]`); admin delivery row shows redacted token + view count.
- [ ] MVP 2 **password seam** present (column + route structure) but **no** password UI/verification
      built; **no** honoree-facing flow built.
- [ ] New env vars (`NEXT_PUBLIC_SHARE_DOMAIN`, `CDN_DOMAIN`, `CDN_SIGNING_KEY`) wired in **both**
      config files + `.env.example` with the prod refinement (CDN required in prod); no `process.env`
      outside `src/config/env.ts` (ESLint green).
- [ ] Seed produces a delivered event with a valid `SharePage` token **and** an expired-token example
      (idempotent; non-prod only); tokens never printed in full.
- [ ] Unit + integration tests (§9) pass; integration skips cleanly under `SKIP_INTEGRATION`;
      `npm run lint`, `npm run typecheck`, `npm run test` green; CI green; deploys; CDN signing works
      in prod with prod env vars.
- [ ] Ops/setup (not code): CDN configured for the `final/`-prefix + `share/poster.jpg` with signed
      URLs and the signing key/domain; `NEXT_PUBLIC_SHARE_DOMAIN` DNS (if a separate host is chosen).

---

## 13. Open Questions / Assumptions

| # | Question / Assumption | Default taken (this doc) |
|---|---|---|
| **Q1** | **Share domain vs app domain.** Does `/share/{token}` live on a dedicated `NEXT_PUBLIC_SHARE_DOMAIN` or under the app domain? (§4.1) | **Assumption:** support both via a `shareBaseUrl = NEXT_PUBLIC_SHARE_DOMAIN ?? NEXT_PUBLIC_APP_URL` accessor; MVP 1 may ship under the app domain and adopt a separate host later with no code change. A separate host is recommended for surprise integrity. **Confirm the launch hostname.** Also: `honoreeEmail` is currently **absent** (Story 3) — the honoree filter is present-but-inert until the field is collected; confirm when/if it is added. |
| **Q2** | **What triggers delivery when BOTH a manual and an AI `FinalVideo` could exist?** | **Assumption:** `deliverEvent` is idempotent and producer-agnostic — the **first** producer to call it creates the SharePage + sends the email; any later call no-ops (one SharePage per event via `eventId @unique`, one email via dedupe). In practice the routing gate (Story 12) means an event takes one path; the both-paths case is an edge handled safely, not a normal flow. **Confirm** there is no requirement to *replace* a delivered video with a later one (re-delivery / re-render). |
| **Q3** | **Token / link expiry policy.** Does the `SharePage` itself expire (`expiresAt`), and what is the download-link lifetime? (§5.4, §5.7) | **Assumption:** `expiresAt = null` in MVP 1 (Story 19 owns the 30-day lifecycle); download links are **CDN-signed 24h** (presigned 15-min fallback). The email's "30 days" describes the retention policy, not the token TTL. **Confirm** 24h download-link lifetime vs. minting fresh short links per click. |
| **Q4** | **`FinalVideo` contract + allowed prior statuses for the flip.** Story 14/17 design docs are not yet present. (§3, §5.6, §6.3) | **Assumption:** consume `FinalVideo` exactly per `architecture.md` §7.1 (`source`, `variant`, `storagePath`, `durationSec`, `sizeBytes`); require a `MASTER` variant; flip to `DELIVERED` from whatever the path's prior status is (idempotent "set if not already DELIVERED"). **Reconcile against Story 14/17 when they land.** |
| **Q5** | **`Event.is_surprise` flag** that would make password "required." | **Assumption:** **not** in MVP 1 (no field collected). Password is entirely MVP 2; the `passwordHash` column is the only seam shipped. |
| **Q6** | **Organizer "regenerate / rotate share link" and "copy full link" (admin).** | **Assumption:** **out of MVP 1.** No rotate action; admin sees only a redacted link. The schema (token `@unique`, replaceable) supports a future rotate. |
| **Q7** | **Inline vs `delivery` BullMQ job** for `deliverEvent`; **on-page honoree name** in the H1. | **Assumption:** inline for the manual path (admin awaits the response), email retried by the dispatcher; a job is fine for the AI path. **On-page H1:** the honoree name **may** appear in the page body (behind token + `noindex`) but **never** in `<title>`/OG. **Confirm** whether even the on-page H1 should be name-free for maximum caution. |
| **Q8** | **Download = master only or all variants?** (§5.4) | **Assumption:** the **MASTER** is always offered; **Reel/YouTube** are offered when the package includes them and the `FinalVideo` rows exist (MVP 1 single package includes all three per `requirements.md` §4). **Confirm** the per-variant download UX (one button vs a small list). |
| **Q9** | **`SharePage` exists but no `FinalVideo`** (race / mis-call). (§4.3, §5.1) | **Assumption:** `deliverEvent` requires a `MASTER` before creating a SharePage, so this should not occur; the route still renders a calm "being prepared" 200 defensively. |
| **Q10** | **`Cache-Control` for the tokenized page.** (§5.3) | **Assumption:** `private, no-store` to keep the tokenized page out of shared caches/CDNs. **Confirm** against any desire to CDN-cache the (static) page shell. |
| **Q11** | **View-count semantics.** Count every GET, or unique visitors / exclude bots? (§5.3) | **Assumption:** count **every** valid GET render (simple integer; bot/prefetch over-count accepted). No unique-visitor logic in MVP 1. |
| **Q12** | **Does anyone besides the organizer get a delivery email?** (§5.5) | **Assumption:** organizer **only**. Admins learn of delivery via the dashboard status row (§4.4), not an email. **No** contributor/honoree delivery email. Confirm if an admin "delivered" email is wanted (would be a separate trigger). |
| **Q13** | **Flip-on-SharePage vs flip-on-email-success.** (§5.6) | **Assumption:** flip to `DELIVERED` once the SharePage exists (deliverable is ready); surface email failure separately. Confirm if business prefers withholding `DELIVERED` until the email sends. |
| **Q14** | **CDN signing scheme** (Cloudflare signed URLs vs CloudFront signed URLs) + prod-required config. (§7.1, §7.2) | **Assumption:** signing helper abstracts the chosen CDN; `CDN_DOMAIN`+`CDN_SIGNING_KEY` required in prod (fail-fast), optional in dev (presigned GET fallback). **Confirm** the CDN product (drives the exact signing algorithm). |
| **Q15** | **Who produces `share/poster.jpg`?** (§7.3) | **Assumption:** produced by the encoder/thumbnail step (Story 17) or copied from the auto thumbnail, and guaranteed honoree-name-free; if absent at delivery, the share page falls back to a brand-only placeholder. **Confirm** the producer + the name-free guarantee for any face used. |

> **Resolved by sources of truth (not open):** MVP 1 has **no share-page password** (`requirements.md`
> §4/§8, `architecture.md` §18) — only the `passwordHash` seam. The share page is **anonymous via
> token, no login** (`architecture.md` §10.2). The app has **no honoree-facing flow** (`requirements.md`
> §9, `architecture.md` §15). The delivery email goes to the **organizer only**, filtered against the
> honoree (`architecture.md` §10.1 #1). Token is **32-byte** random, `noindex,nofollow` +
> `Referrer-Policy`, **never logged in full** (`architecture.md` §10.1 #2–#3). `final/` is served via
> **CDN signed URLs (24h)**; presigned GET is **15-min** (`architecture.md` §7.2).
