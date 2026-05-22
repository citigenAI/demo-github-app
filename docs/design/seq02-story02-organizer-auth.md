# Story 2 — Organizer Authentication (Design)

**Epic:** B — Event Creation
**Sequence number:** 2
**Depends on:** Story 1 (Foundation) only
**Complexity:** Small (0.5–1 day)
**Status:** Design — implementation pending

> This is a design-level specification. It contains **no code**. It defines exact field names, routes, contracts, validation rules, and behavior so the implementation step can build the story without further interpretation. Decisions trace to `docs/requirements.md`, `docs/architecture.md`, `docs/stories.md`, and `docs/branding.md`. Genuine ambiguities are listed in §13 rather than invented away.

---

## 1. Story Summary

### Goal
Add passwordless, magic-link email authentication for the **Organizer** role using NextAuth.js. An organizer enters their email on a `/login` page, receives a sign-in link by email (Mailpit in dev, Resend in prod), clicks it, and lands authenticated. Their account persists in the database. Organizer-only areas of the app are protected by session-aware middleware. Sign-out is supported.

### Success criteria
A reviewer checking out `main` and following run instructions can:

- [ ] Visit `/login`, enter a valid email, submit, and see a "Check your email" confirmation state.
- [ ] Open Mailpit (`http://localhost:8025`) and find a branded magic-link email addressed to that email.
- [ ] Click the link and be redirected into the app as an authenticated organizer.
- [ ] On first sign-in, a `User` row is created with `role = ORGANIZER`; on subsequent sign-ins, no duplicate user is created.
- [ ] Access a protected organizer route (the placeholder `/events` page) only when authenticated; an unauthenticated request to `/events` redirects to `/login`.
- [ ] Sign out and lose access to `/events` (redirected back to `/login`).
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` pass; CI green; deploys to Vercel; magic link works in prod via Resend.

### What it unlocks next
- **Story 3 (Event creation)** — needs an authenticated organizer identity (`session.user.id`) to own created events (`Event.organizerId`).
- **Story 7 (Admin dashboard)** — reuses this NextAuth installation and the role seam to add Google OAuth for `ADMIN` and admin route gating.

---

## 2. Scope

### In scope
- NextAuth.js installation and configuration (App Router route handler).
- Email (magic-link / "Email provider") sign-in for organizers.
- Prisma Adapter persistence: the NextAuth-required models (`Account`, `Session`, `VerificationToken`) plus modifications to the existing `User` model.
- `/login` page with the email-entry form and the "check your email" state, plus error and verify-request handling.
- Sign-out action available from a minimal authenticated header/menu.
- Session strategy decision (database sessions — see §5) and its justification.
- Middleware-based protection of organizer routes, demonstrated on a placeholder `/events` route group.
- First-login user creation defaulting to `role = ORGANIZER`.
- The `Role` seam so Story 7 can add `ADMIN` (Google OAuth) without reshaping this design.
- Magic-link email transport: Mailpit SMTP in dev, Resend in prod; one branded email template.
- New env vars added to **both** `src/config/env.ts` (raw read) and `src/config/index.ts` (typed Zod schema).

### Explicitly out of scope (owned by later stories)
| Deferred item | Owning story |
|---|---|
| Admin Google OAuth provider + admin route gating + `ADMIN_EMAIL_DOMAINS` enforcement | Story 7 |
| Event creation wizard, "My Events" list content, slug/QR/share text | Story 3 |
| Any real content inside `/events` (this story ships a protected placeholder only) | Story 3 |
| Stripe / payments | Story 4 |
| Contributor flows (anonymous; no login) | Story 5–6 |
| Editor links (signed JWT, no session) | Story 13–14 |
| Password reset, 2FA, account settings, profile editing, account deletion | Not in MVP 1 |
| Rate-limiting infrastructure beyond NextAuth's built-in token model (see §10) | Not required this story; revisit with abuse signals |

**Surprise integrity note:** Login is organizer-only and self-initiated. No login flow ever emails the honoree. The honoree is an excluded actor; this story introduces no path that could email them. (No `honoreeEmail` exists yet — that field arrives with the `Event` model in Story 3.)

---

## 3. Dependencies & Sequence

- **Sequence number:** 2.
- **Prerequisite stories:** Story 1 only.
- **Must already exist on `main` (delivered by Story 1):**
  - Typed config module: `src/config/index.ts` (Zod) + `src/config/env.ts` (the only file that reads `process.env`).
  - Prisma client singleton `src/lib/db.ts`; `User` model + `Role` enum in `prisma/schema.prisma`; migrations working against Supabase.
  - Next.js 15 App Router with `src/app/`, brand fonts/tokens loaded in `src/app/layout.tsx` and `src/app/globals.css`.
  - `@/` import alias; ESLint rule banning `process.env` outside `src/config/env.ts`.
  - Local infra via Docker Compose including **Mailpit** (SMTP `localhost:1025`, UI `localhost:8025`).
  - Vitest set up with unit + integration folders.
- **Reserved by Story 1, activated here:** `.env.example` already lists `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `ADMIN_EMAIL_DOMAINS`, `SMTP_HOST`, `SMTP_PORT`, `RESEND_API_KEY`, `RESEND_FROM_ADDRESS` as "reserved for later stories." This story wires the auth + email subset of those into config and code. `ADMIN_EMAIL_DOMAINS` is added to config now (for the seam) but **not enforced** until Story 7.

---

## 4. Frontend / UI Design

### 4.1 Routes & pages

| Route | Type | Auth | Purpose |
|---|---|---|---|
| `/login` | Public page | Unauthenticated (redirect away if already signed in) | Email entry + "check your email" state |
| `/login` (error display) | Same page | Public | Renders NextAuth error/verify-request states via query params (see §4.4) |
| `/api/auth/[...nextauth]` | Route handler | Public (NextAuth-managed) | All NextAuth endpoints: `signin`, `callback`, `signout`, `session`, `csrf`, `providers`, `verify-request`, `error` |
| `/events` | Protected page group | Organizer session required | Placeholder authenticated landing this story; Story 3 fills it in |

NextAuth's default pages are **overridden** so branding is consistent: configure `pages.signIn = "/login"`, `pages.verifyRequest = "/login?state=check-email"`, `pages.error = "/login?error=..."`. We do not ship NextAuth's stock UI.

### 4.2 Components

| Component | Responsibility |
|---|---|
| `LoginForm` (client component) | Email input + submit; calls NextAuth `signIn("email", { email, redirect: false, callbackUrl })`; on success transitions to the "check email" view; on error shows inline message |
| `LoginPage` (server component) | Reads `state` / `error` query params; renders wordmark, `LoginForm` or the "check email" panel or the error panel; redirects to `/events` if a session already exists |
| `AuthHeader` (server component) | Minimal authenticated header used on `/events`: wordmark + signed-in email + Sign-out control |
| `SignOutButton` (client component) | Calls NextAuth `signOut({ callbackUrl: "/login" })` |
| `SessionProvider` wrapper (client) | Wraps the authenticated subtree so client components can read session via `useSession`; mounted in the `/events` layout, not the root layout (keeps public pages free of the provider) |

### 4.3 Layout & states

`/login` page states (single page, state-driven):

1. **Default (form)** — wordmark per branding §6 ("Swara" deep-saffron Fraunces semibold; "Magical Memories" Fraunces light below), a short welcome line, the email field, the submit button, and the "by Swara Media" lockup in the footer.
2. **Loading** — submit button shows a disabled/working state while the `signIn` promise is pending; form inputs disabled.
3. **Check email (success)** — replaces the form with a confirmation panel: heading "Check your email", body "We sent a sign-in link to {email}. Click it to continue. The link is valid for 24 hours." plus a "Use a different email" affordance that returns to the form. This is the state shown both after a successful client submit and when NextAuth redirects to `verifyRequest`.
4. **Error** — when `?error=` is present (or the client `signIn` returns an error), show a calm inline message mapped from the error code (see §4.4) and keep the form usable.
5. **Empty** — N/A (the form is the resting state).

`/events` placeholder states:

- **Authenticated:** `AuthHeader` + a simple "Your events" heading and an empty-state line in brand voice: "No events yet. When you create your first tribute, it'll appear here." (Story 3 replaces this body.)
- **Unauthenticated:** never rendered — middleware redirects to `/login` before the page runs.

### 4.4 Forms — every field + validation

**Login form**

| Field | Type | Required | Client validation | Server-side handling |
|---|---|---|---|---|
| `email` | email (single text input) | Yes | Non-empty; valid email format (HTML `type="email"` + a format check); trim + lowercase before submit | NextAuth Email provider validates and normalizes; unknown emails are still accepted (first sign-in creates the user) |

Submit button label: **"Send sign-in link"** (sentence case per branding §10).

**Form submission behavior:**
- Use `signIn("email", { email, redirect: false, callbackUrl: <resolved> })` so the page can render the in-place "check email" state instead of a full navigation.
- `callbackUrl` resolves to the value of an incoming `?callbackUrl=` query param if present and same-origin; otherwise defaults to `/events`. Reject/ignore any off-origin `callbackUrl` (open-redirect protection — see §10).
- **Enumeration neutrality:** the UI shows the same "Check your email" state whether or not the email belongs to an existing user. We never reveal account existence.

**NextAuth error-code → user message mapping** (rendered on `/login?error=<code>`):

| NextAuth `error` code | Shown message (brand voice, no exclamation) |
|---|---|
| `Verification` | "That sign-in link has expired or was already used. Enter your email to get a new one." |
| `EmailSignin` | "We couldn't send the sign-in link just now. Please try again in a moment." |
| `Configuration` | "Sign-in is temporarily unavailable. Please try again shortly." (also logged at error level server-side) |
| `AccessDenied` | "This email isn't allowed to sign in." (not expected for organizers in MVP 1; reserved for Story 7 admin gating) |
| default / unknown | "Something went wrong signing you in. Please try again." |

### 4.5 User flows

**Sign-in (happy path):**
1. Organizer opens `/login`.
2. Enters email → "Send sign-in link" → loading → "Check your email" panel.
3. NextAuth creates a `VerificationToken` and sends the magic-link email (Mailpit dev / Resend prod).
4. Organizer clicks the link → hits `/api/auth/callback/email?...` → token verified and consumed → session established (DB session cookie set) → redirected to `callbackUrl` (default `/events`).
5. First-time email → a `User` row is created (`role = ORGANIZER`); returning email → existing user reused.

**Already-authenticated visiting `/login`:** server component detects a session and redirects to `/events`.

**Protected-route flow (unauthenticated):** request to `/events` → middleware finds no valid session → redirect to `/login?callbackUrl=/events`. After successful sign-in the organizer returns to `/events`.

**Sign-out:** click Sign out in `AuthHeader` → NextAuth `signOut` clears the session cookie and deletes the DB `Session` row → redirect to `/login`.

### 4.6 Responsive + branding / voice notes
- Single-column, centered card layout; comfortable on mobile (web-responsive only, per requirements §9). Reuse the centered composition pattern from the existing landing page.
- Palette/typography from `branding.md` §4–§6: ivory background, ink text, deep-saffron primary CTA, Fraunces display + Inter body (already loaded via `layout.tsx`).
- Copy is warm, clear, calm; no exclamation marks; sentence case for buttons and labels; title case for headings (branding §3, §10).
- Footer lockup "by Swara Media" present on `/login` (branding §6 lists login/dashboard first-login as a lockup placement).

### 4.7 Accessibility
- Email input has an associated visible `<label>` and `autoComplete="email"`; `type="email"`; `inputMode="email"`.
- All states announce changes: the "Check your email" panel uses an `aria-live="polite"` region; error messages associated to the input via `aria-describedby` and `role="alert"`.
- Submit button reachable and operable by keyboard; visible focus rings; loading state communicated to assistive tech (e.g., `aria-busy`).
- Color contrast meets WCAG AA (deep-saffron + ink, ink on ivory) per branding §4.
- Sign-out is a real button, keyboard-operable.

---

## 5. Backend / API Design

### 5.0 Session strategy decision (database sessions) — **DECISION + JUSTIFICATION**

**Decision: use NextAuth database sessions (the Prisma Adapter with `session.strategy = "database"`), not JWT sessions.**

Rationale:
1. **The Email (magic-link) provider requires a database adapter regardless** — verification tokens must be persisted (`VerificationToken` table) to be single-use and expirable. Since we already pay the cost of the adapter, database sessions add little and remove the JWT/secret-rotation footguns.
2. **Server-side revocation.** Sign-out and future "force log-out" / account deletion are trivial with DB sessions (delete the row). JWT sessions can't be revoked before expiry without extra denylist machinery.
3. **Role correctness on change.** When Story 7 introduces `ADMIN`, a role change is reflected on the next request because the session is read from the DB + user row, rather than baked into a possibly-stale signed token.
4. **Vercel + Supabase fit.** The app already holds a Prisma connection to Supabase; storing sessions there is one more low-write table. Auth traffic is low-volume (organizers, not contributors), so the per-request DB read is acceptable.
5. **Simplicity.** No need to reason about token size, claims, or refresh. Cookie holds an opaque session id; everything else is server state.

Trade-off accepted: one DB read per authenticated request for session lookup. Given organizer-only auth and low volume, this is the right call. (If a future high-RPS surface needs JWT, that is a localized change behind the same `auth()` accessor.)

### 5.1 NextAuth route handler

| Item | Value |
|---|---|
| Path | `/api/auth/[...nextauth]` |
| Methods | `GET`, `POST` (NextAuth dispatches internally) |
| Auth | Public (this *is* the auth surface) |
| Provider(s) | **Email** (magic link) only this story. Provider id: `email`. |
| Adapter | Prisma Adapter bound to the `db` singleton |
| Session | `{ strategy: "database", maxAge: 30 days, updateAge: 24h }` |
| Secret | `config.auth.secret` (`NEXTAUTH_SECRET`) |
| Pages | `signIn: "/login"`, `verifyRequest: "/login?state=check-email"`, `error: "/login"` |
| Cookies | NextAuth defaults; `secure` cookies in production; `httpOnly`, `sameSite=lax` |

**Email provider configuration:**
- `from`: `config.email.fromAddress` (`RESEND_FROM_ADDRESS`).
- Token validity (`maxAge`): **24 hours** (matches the copy in §4.3).
- **Send transport is environment-switched** by a single custom `sendVerificationRequest` implementation (see §5.3) — not by swapping providers — so the seam is one function.

**Callbacks:**
- `session` callback: attach `user.id` and `user.role` to the returned session object so `session.user.id` and `session.user.role` are available to server code and to `useSession`. (Type augmentation of the NextAuth `Session`/`User` types is required.)
- `signIn` callback: return `true` for the Email provider in MVP 1 (all organizers allowed). This callback is the **seam** where Story 7 will add the `ADMIN`/domain-allowlist check for the Google provider; document it as such with no enforcement now.

**User creation:** handled by the Prisma Adapter automatically on first successful verification. New `User` rows get `role = ORGANIZER` from the schema default. No custom create logic required; the adapter's `createUser` writes `email` (and `name`/`emailVerified` per adapter contract).

### 5.2 Auth accessor / service module

Provide a single server-side module (e.g., `src/lib/auth.ts`) that:
- Builds and exports the NextAuth configuration object (`authOptions` / the NextAuth v5 `auth` handler set).
- Exports a server helper to read the current session (`auth()` in NextAuth v5, or `getServerSession(authOptions)` in v4) so pages/route handlers/middleware import one thing.
- Is the **only** module that constructs NextAuth config; the route handler and middleware import from here.

> **Version note (assumption A1, §13):** This design is written to be valid for NextAuth v4 *or* Auth.js v5. The contracts (provider id `email`, DB sessions, adapter models, callbacks) are the same; only import names differ. The implementer picks the version compatible with Next.js 15 (Auth.js v5 / `next-auth@5` is the smoother fit for App Router) and follows that library's exact handler/middleware idioms.

### 5.3 Email send seam (`sendVerificationRequest`)

A single custom function controls how the magic link is delivered:

| Env | Transport | Selection rule |
|---|---|---|
| development / test | SMTP to Mailpit (`config.email.smtpHost` / `config.email.smtpPort`, no auth, no TLS) | when `config.email.resendApiKey` is absent **or** `config.env !== "production"` |
| production | Resend API (`config.email.resendApiKey`, from `config.email.fromAddress`) | when `config.env === "production"` (Resend key required) |

Inputs available to the function: `identifier` (recipient email), `url` (the verification callback URL), `provider`, `expires`. The function:
1. Renders the branded email (subject + HTML + plaintext — see §7.4).
2. Sends via the selected transport.
3. On send failure, throws so NextAuth surfaces `EmailSignin` to the user and the attempt is logged (see §11).
4. **Never sends to any address other than `identifier`** (the organizer's own email). No bcc, no honoree path exists.

### 5.4 Middleware (route protection)

| Item | Value |
|---|---|
| File | `src/middleware.ts` |
| Matcher | Protect organizer areas only: `["/events/:path*"]` this story. Do **not** match `/`, `/login`, `/api/auth/*`, static assets, or `/api/health`. |
| Logic | If no valid session for a matched request → redirect to `/login?callbackUrl=<original path>` (same-origin only). If session exists → continue. |
| Implementation | Use NextAuth's middleware integration (v5 `auth` middleware wrapper, or v4 `withAuth`) reading the session cookie. |

Edge consideration: with database sessions, middleware checks for the presence/validity of the session cookie at the edge; authoritative session/user lookups happen in server components/route handlers via the auth accessor. Middleware is the coarse gate; server components do the fine-grained `session.user` reads.

### 5.5 Endpoints summary

| Method | Path | Auth | Request | Response | Status codes |
|---|---|---|---|---|---|
| GET/POST | `/api/auth/[...nextauth]` | public | NextAuth-managed (csrf token, email, callback params) | NextAuth-managed (redirects, JSON for `/session`, `/providers`, `/csrf`) | 200; 302 redirects; 400 bad request; 403 csrf failure |
| GET | `/login` | public (redirects authed → `/events`) | query: `state?`, `error?`, `callbackUrl?` | HTML page | 200; 302 (if already authed) |
| GET | `/events` (+ subpaths) | organizer session | — | HTML page | 200; 302 → `/login` if unauthenticated |

No bespoke REST endpoints are added beyond the NextAuth handler; sign-in/out happen through NextAuth client methods hitting `/api/auth/*`.

### 5.6 Error handling
- Email transport failure → `sendVerificationRequest` throws → user sees `EmailSignin` message; server logs the failure with the (redacted) recipient.
- Invalid/expired/used token at callback → NextAuth redirects to `/login?error=Verification`; mapped to the friendly message in §4.4.
- Missing/invalid config at boot (e.g., `NEXTAUTH_SECRET` too short, missing Resend key in prod) → config Zod parse throws at startup with a clear message (consistent with Story 1's fail-fast config). See §7.
- CSRF/double-submit handled by NextAuth defaults.

---

## 6. Database Design

All additions are to `prisma/schema.prisma`. This story adds the three NextAuth-adapter models and extends `User`. `Role` enum already exists (unchanged). Per project convention, only the models this story needs are added.

### 6.1 `User` (modified)

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | String | no | `cuid()` | existing PK |
| `email` | String | no | — | existing; `@unique` (existing) |
| `name` | String | yes | — | existing |
| `role` | Role | no | `ORGANIZER` | existing; first-login default |
| `createdAt` | DateTime | no | `now()` | existing |
| `emailVerified` | DateTime | yes | — | **added** — required by NextAuth adapter contract; set when the email is verified via magic link |
| `accounts` | Account[] | — | — | **added** relation (back-reference) |
| `sessions` | Session[] | — | — | **added** relation (back-reference) |

> `events` relation is **not** added here — it arrives with the `Event` model in Story 3.

### 6.2 `Account` (added — NextAuth adapter)

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | String | no | `cuid()` | PK |
| `userId` | String | no | — | FK → `User.id` |
| `type` | String | no | — | adapter field |
| `provider` | String | no | — | adapter field |
| `providerAccountId` | String | no | — | adapter field |
| `refresh_token` | String | yes | — | OAuth; unused by Email provider, present for Story 7 Google |
| `access_token` | String | yes | — | OAuth |
| `expires_at` | Int | yes | — | OAuth |
| `token_type` | String | yes | — | OAuth |
| `scope` | String | yes | — | OAuth |
| `id_token` | String | yes | — | OAuth (`@db.Text`) |
| `session_state` | String | yes | — | OAuth |
| `user` | User | — | — | relation, `onDelete: Cascade` |

Constraints/indexes:
- `@@unique([provider, providerAccountId])`
- `@@index([userId])`

> The `Account` table is included now (standard NextAuth adapter schema) even though the Email provider doesn't populate it, so adding Google OAuth in Story 7 is purely additive — no migration to introduce the table later.

### 6.3 `Session` (added — NextAuth adapter, database sessions)

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | String | no | `cuid()` | PK |
| `sessionToken` | String | no | — | `@unique`; opaque value stored in the cookie |
| `userId` | String | no | — | FK → `User.id` |
| `expires` | DateTime | no | — | session expiry |
| `user` | User | — | — | relation, `onDelete: Cascade` |

Indexes:
- `@@index([userId])`

### 6.4 `VerificationToken` (added — NextAuth adapter, magic link)

| Field | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `identifier` | String | no | — | the email being verified |
| `token` | String | no | — | `@unique`; the single-use magic-link token (hashed by NextAuth) |
| `expires` | DateTime | no | — | token expiry (24h per §5.1) |

Constraints:
- `@@unique([identifier, token])`
- No standalone `id` column (standard NextAuth `VerificationToken` shape).

### 6.5 Enums
- `Role { ORGANIZER ADMIN }` — **unchanged** (already present). `ADMIN` exists for the seam; not assignable via this story's flow.

### 6.6 Migration notes
- Create one migration (suggested name `add_nextauth_models`) that: adds `Account`, `Session`, `VerificationToken`; adds `emailVerified` + relation back-references to `User`.
- `emailVerified` is nullable, so the migration is non-destructive against any existing `User` rows.
- Run `prisma migrate dev` against `swara_dev`; `prisma migrate deploy` against `swara_test` (CI) and `swara_prd` (deploy). Field/column naming uses the NextAuth-adapter-expected names exactly (snake_case OAuth fields on `Account`, `sessionToken`, `providerAccountId`) — do not rename, or the adapter breaks.

---

## 7. External Services / Integrations / Config

### 7.1 Env vars to add

Add each to **both** `src/config/env.ts` (raw read) **and** `src/config/index.ts` (typed Zod schema). Values already documented in `.env.example` (currently in the "reserved" comment block — uncomment/activate the auth + email subset).

| Env var | Purpose | Config path (typed) | Zod rule |
|---|---|---|---|
| `NEXTAUTH_SECRET` | Signs NextAuth cookies/CSRF; required by NextAuth | `auth.secret` | `string().min(32)` |
| `NEXTAUTH_URL` | Canonical app URL NextAuth builds callback links from | `auth.url` | `string().url()` |
| `ADMIN_EMAIL_DOMAINS` | Comma-separated allowlist; **parsed now for the seam, enforced in Story 7** | `auth.adminEmailDomains` (string[]) | split on `,`, trim; allow empty array |
| `SMTP_HOST` | Mailpit host in dev (magic-link transport) | `email.smtpHost` | `string()` (default `localhost` acceptable) |
| `SMTP_PORT` | Mailpit port in dev (`1025`) | `email.smtpPort` | coerce to `number()` |
| `RESEND_API_KEY` | Resend API key for prod sends | `email.resendApiKey` | `string().optional()` (required only in prod — see refinement) |
| `RESEND_FROM_ADDRESS` | From address for the magic-link email | `email.fromAddress` | `string()` (email-shaped) |

**Config refinement:** in production (`env === "production"`), `email.resendApiKey` must be present and non-empty; otherwise the Zod schema fails fast at boot. In dev/test it may be empty (Mailpit path). Add this as a Zod `superRefine`/`refine` so misconfiguration is caught at startup, consistent with Story 1's config behavior.

> Add only the auth + email vars this story needs. Do **not** introduce storage/Stripe/AI/editor vars here — they belong to their owning stories. Reading `process.env` anywhere except `src/config/env.ts` is forbidden (ESLint-enforced).

### 7.2 New runtime dependencies (libraries)
- NextAuth / Auth.js (`next-auth`), and the Prisma Adapter (`@auth/prisma-adapter` for v5, or `@next-auth/prisma-adapter` for v4) — match the chosen NextAuth version.
- An SMTP client for the dev transport (e.g., `nodemailer`) — used by `sendVerificationRequest`'s Mailpit path. (NextAuth's Email provider can also accept an SMTP `server` config directly; either is acceptable as long as dev points at Mailpit and prod uses Resend.)
- Resend SDK (`resend`) for the prod transport.

### 7.3 Email provider behavior by environment
- **Dev/test:** SMTP → Mailpit (`SMTP_HOST=localhost`, `SMTP_PORT=1025`), no auth, no TLS. Emails are caught in the Mailpit UI (`http://localhost:8025`); nothing leaves the machine.
- **Prod:** Resend API with `RESEND_API_KEY`, `from = RESEND_FROM_ADDRESS`.

### 7.4 Email template (single transactional template — magic link)

Content follows branding §3 (warm, clear, no exclamation marks) and §11 (transactional footer lockup).

| Element | Value |
|---|---|
| Subject | `Your sign-in link for Swara Magical Memories` |
| Greeting | `Hi,` (no name on first sign-in; name unknown) |
| Body | "Use the button below to sign in to Swara Magical Memories. The link is valid for 24 hours and can be used once." |
| Primary CTA | Button labeled **"Sign in"** linking to `{url}` (deep-saffron button per branding) |
| Fallback | Plaintext URL shown for clients that don't render the button |
| Security line | "If you didn't request this, you can safely ignore this email." |
| Footer | `— Swara Magical Memories` / `by Swara Media` (lockup per branding §6/§11) |
| Plaintext version | Required (subject + greeting + instruction + raw URL + security line + footer) for deliverability |

The template must **not** include any honoree or event content (none exists at login time anyway) and must render correctly in Mailpit and Resend.

---

## 8. Seed Data

Add to the project seed (the `npm run seed` referenced in dev-setup §8; create the seed entry point if it does not yet exist).

| Record | Fields | Why |
|---|---|---|
| Dev organizer | `email = organizer@example.com`, `name = "Dev Organizer"`, `role = ORGANIZER` | Lets a developer test the protected `/events` route and (later) Story 3 ownership without going through email each time; magic-link sign-in for this email creates a `Session` for the existing user |
| Dev admin (seam only) | `email = admin@swaramagical.com`, `name = "Dev Admin"`, `role = ADMIN` | Pre-creates an `ADMIN` user so Story 7 has a target; **not used by this story's login flow** (no admin UI yet). Documents that role is a DB property |

Seed must be **idempotent** (upsert by unique `email`) so re-running doesn't error. Never seed `swara_prd`. Do not seed sessions or verification tokens (those are created by the live flow).

> Note: even seeded users still authenticate via the magic link — seeding only creates the `User` row, not a session. This is intentional and matches the passwordless model.

---

## 9. Testing

Tests live under `tests/unit` and `tests/integration`, run with Vitest (Story 1 setup). Integration tests that need a DB use `swara_test`; honor a `SKIP_INTEGRATION` guard so they no-op when infra/DB is unavailable (skip with a clear message rather than fail).

### 9.1 Unit tests

| Test | Asserts | Edge cases |
|---|---|---|
| Config parses auth + email vars | Given all required env present, `config.auth.secret/url/adminEmailDomains` and `config.email.*` are typed and populated | `ADMIN_EMAIL_DOMAINS` empty → `[]`; comma list → trimmed array |
| Config prod refinement | In `production` with no `RESEND_API_KEY`, config parse throws; in `development` it succeeds with empty key | secret shorter than 32 chars → throws |
| Email transport selector | Returns the Mailpit/SMTP transport when env is dev/test or Resend key absent; returns Resend transport when `env === production` and key present | missing Resend key in prod path → error surfaced |
| `sendVerificationRequest` recipient guard | Sends only to `identifier`; the rendered email contains the exact `{url}` and the 24h validity copy | send-transport throws → function propagates the error |
| Email template render | Subject equals the spec string; HTML contains the CTA href = `{url}`; plaintext contains the raw URL; footer contains "by Swara Media"; body contains no exclamation mark | — |
| `signIn` callback (Email) | Returns `true` for the email provider (organizer allowed) | documents the Story-7 admin seam returns `true` here for now |
| `session` callback shape | Resulting session includes `user.id` and `user.role` | role default surfaces as `ORGANIZER` |
| `callbackUrl` sanitizer | Same-origin relative path is preserved; off-origin/absolute external URL is rejected and falls back to `/events` | empty/missing → `/events` |
| Error-code → message map | Each NextAuth error code maps to the exact friendly string in §4.4; unknown code → default message | — |

### 9.2 Integration tests

| Test | Infra | Mocking | Asserts |
|---|---|---|---|
| Magic-link end-to-end (token) | `swara_test` DB + NextAuth handler | Mock the email transport to capture the verification `url` instead of sending | Submitting an email creates a `VerificationToken`; following the captured callback `url` creates a `Session` and (for a new email) a `User` with `role = ORGANIZER`; token is single-use (second use fails with `Verification`) |
| First-login user creation | `swara_test` DB | transport mock | New email → exactly one new `User`; same email signing in again → no duplicate `User` (count unchanged) |
| Protected route redirect | App route + middleware | unauthenticated request | GET `/events` without a session → 302 to `/login?callbackUrl=/events` |
| Protected route allowed | App route + middleware | authenticated session (DB session row + cookie) | GET `/events` with a valid session → 200 |
| Sign-out | `swara_test` DB | authenticated session | After sign-out, the `Session` row is deleted and a subsequent `/events` request redirects to `/login` |
| Expired token | `swara_test` DB | transport mock + clock past `expires` | Following an expired callback `url` → `Verification` error, no `Session` created |

> Whisper/Claude/Stripe mocks are irrelevant here. The only external boundary mocked is the **email transport**; the DB and NextAuth logic are exercised for real against `swara_test`.

### 9.3 Tests ↔ success criteria mapping
- "Check your email" UI state → covered by `sendVerificationRequest`/template unit tests + the magic-link integration test producing a token.
- First-login creates one `ORGANIZER` user, no duplicates → first-login integration test.
- Protected `/events` gating → protected-route redirect + allowed integration tests + middleware unit-level sanitizer.
- Sign-out → sign-out integration test.
- Prod uses Resend, dev uses Mailpit → transport selector unit test.

---

## 10. Security & Surprise Integrity

| Control | Design |
|---|---|
| Passwordless, single-use tokens | Magic-link `VerificationToken` is single-use and expires in 24h; consumed on first valid callback |
| Session strategy | Database sessions; opaque `sessionToken` cookie; server-side revocation on sign-out |
| Cookie hardening | `httpOnly`, `sameSite=lax`, `secure` in production (NextAuth defaults); `NEXTAUTH_SECRET ≥ 32` chars enforced by config |
| CSRF | NextAuth built-in CSRF token on the sign-in POST |
| Open-redirect protection | `callbackUrl` accepted only if same-origin/relative; otherwise falls back to `/events` (validated in code and unit-tested) |
| Account-enumeration neutrality | `/login` shows the identical "check your email" state regardless of whether the email exists |
| Honoree exclusion | Login emails go only to the self-submitted organizer address (`identifier`); no honoree contact exists at this stage and no flow can email one |
| Role boundary | `ADMIN` is a DB-only property; this story's flow can never assign `ADMIN`. The Email provider's `signIn` callback returns `true` for organizers only; admin/domain gating is added in Story 7 at this same seam |
| Route protection scope | Middleware matcher protects only organizer areas (`/events/*`); public routes (`/`, `/login`, `/api/auth/*`, `/api/health`, static) remain open |
| Rate limiting | Not built this story (no infra yet). NextAuth's token model limits brute force somewhat. Note as a follow-up if abuse appears; Redis-backed rate limiting exists per architecture but is not wired for auth in MVP 1 (assumption A2, §13) |
| Secrets handling | All auth/email secrets read only via `config`; never logged; recipient emails redacted in logs (§11) |

---

## 11. Observability / Audit

This story predates the `AuditLog` and `NotificationLog` tables (introduced with `Event` in Story 3). Therefore:

- **No DB audit/notification rows are written this story** (the tables don't exist yet). Mark formal `AuditLog`/`NotificationLog` integration **N/A for this story**.
- **Structured logging** via the existing `src/lib/logger.ts`:
  - `info` on successful magic-link send (log the trigger `auth.magic_link.sent` with a **redacted/hashed** recipient, never the full email or the token/URL).
  - `warn` on email transport failure (`auth.magic_link.failed`, redacted recipient, error class).
  - `info` on sign-in success and sign-out (user id only; never email in plaintext).
  - `error` on config/NextAuth `Configuration` failures.
- **Never log** the verification token, the full magic-link URL, or `NEXTAUTH_SECRET`.
- Metrics: none required this story. (Future: tie auth send/verify counts into the metrics layer once it lands.)

---

## 12. Definition of Done

Story 2 is done only when all are true:

- [ ] All §1 success criteria pass locally.
- [ ] New env vars added to **both** `src/config/env.ts` and `src/config/index.ts` with the §7.1 Zod rules and the prod Resend refinement; `.env.example` updated (auth + email vars moved out of the "reserved" block).
- [ ] Prisma migration `add_nextauth_models` created and applied to `swara_dev`; `migrate deploy` runs clean against `swara_test` and `swara_prd`.
- [ ] `/login` renders all states (form, loading, check-email, error) per §4 with brand styling and a11y attributes.
- [ ] Magic link works via Mailpit in dev (visible at `:8025`) and via Resend in prod.
- [ ] First sign-in creates one `ORGANIZER` `User`; repeat sign-in creates no duplicate.
- [ ] `/events` placeholder is protected: unauthenticated → redirect to `/login?callbackUrl=/events`; authenticated → 200.
- [ ] Sign-out clears the session and deletes the `Session` row.
- [ ] Seed creates an idempotent dev organizer (+ seam admin); `npm run seed` is re-runnable.
- [ ] No `process.env` reads outside `src/config/env.ts`; ESLint passes.
- [ ] `npm run lint`, `npm run typecheck`, `npm run test` pass; CI green on the PR.
- [ ] PR merged to `main`; Vercel auto-deploy succeeds; magic-link sign-in works on the deployed URL with prod env vars set.
- [ ] No TODO comments left in committed code (planned work lives in the story plan, not in comments).

---

## 13. Open Questions / Assumptions

**Assumptions (proceeding unless corrected):**
- **A1 — NextAuth version.** Implementer may use Auth.js v5 (`next-auth@5`) or NextAuth v4. v5 is the recommended fit for Next.js 15 App Router. All contracts in this doc hold for both; only import/handler names differ. The adapter model shapes (Account/Session/VerificationToken) are identical across versions.
- **A2 — No auth rate limiting in MVP 1.** Architecture mentions Redis-backed rate-limit state, but wiring it to the auth endpoints is not in this story's scope. Acceptable given organizer-only, low-volume auth and single-use tokens. Revisit if abuse appears.
- **A3 — Post-login landing is `/events`.** Default `callbackUrl` after sign-in is `/events` (the route Story 3 builds out). This story ships `/events` as a protected placeholder so the redirect target exists and the gate is testable.
- **A4 — Token validity 24h.** Chosen to match the email copy and a comfortable organizer UX; not specified in source docs. Adjustable in one place (`provider.maxAge`).
- **A5 — Session maxAge 30 days / updateAge 24h.** Reasonable defaults for a low-friction organizer experience; not specified in source docs.
- **A6 — `Account` table included now.** Although the Email provider doesn't use it, including the full standard adapter schema avoids a schema change in Story 7 when Google OAuth lands.

**Open questions for product/owner:**
- **Q1 — Sender identity.** `RESEND_FROM_ADDRESS` placeholder is `hello@swaramagical.com`; confirm the production from-address and that its domain is verified in Resend before prod sign-in works.
- **Q2 — Magic-link domain.** Confirm `NEXTAUTH_URL` in prod (the final domain decision in branding §12 — `swaramagical.com` vs `magical.swara.media`) so callback URLs and cookie domains are correct.
- **Q3 — Should organizers be able to set/edit `name` at first login?** Currently `name` stays null until known (Story 3 could capture it during event creation). Confirm no profile step is wanted in Story 2.
- **Q4 — Admin sign-in path coexistence (Story 7 preview).** Confirm admins will use a *separate* sign-in affordance (Google) rather than the magic-link form, so this story's `/login` can stay organizer-only without future rework. The `signIn` callback seam assumes yes.
