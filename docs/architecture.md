# Architecture: Swara Magical Memories

System design reference. Read alongside `requirements.md`. Decisions here are load-bearing — change with care.

---

## 1. Architectural Drivers

Three constraints shape every decision below. If a design choice violates one of these, it is wrong.

| Driver | What it forces |
|---|---|
| **Surprise integrity** | Many events are surprises for the honoree. The system must NEVER send communications to the honoree, NEVER expose the share page without authorization, and NEVER leak the URL via referrers, search indexing, or social previews. |
| **Hard delivery date** | Organizers pay against a delivery commitment. The system must track SLA, route work to whatever channel (AI or human) makes the date, and escalate before it slips. |
| **Bimodal workload** | Submissions trickle in over days/weeks, then heavy AI processing fires near the deadline. Provisioning, queue priorities, and cost optimization must reflect this. |

Secondary drivers: minimal contributor friction (no login, any media mix), flexible AI/manual routing, and admin-as-creative-director (the admin is not a data-entry clerk — they make judgment calls the system must support).

---

## 2. System Context

```
┌─────────────────────────────────────────────────────────────────────┐
│                       External Actors & Systems                     │
└─────────────────────────────────────────────────────────────────────┘

  Organizer ──┐                                    ┌── Stripe
              │                                    │      (payment + webhooks)
  Contributor─┤      ┌─────────────────────┐       │
              ├─────►│                     │◄──────┤── Resend / SendGrid
  Honoree     │      │   Swara Magical     │       │      (email)
   (excluded) │      │      Memories       │       │
              │      │                     │◄──────┤── Twilio / WhatsApp API
  Swara Admin ┤      │                     │       │      (optional)
              │      │                     │◄──────┤── Anthropic Claude API
  Video Editor┘      └─────────────────────┘       │      (reasoning, scripts)
                                                   │
                                                   ├── OpenAI Whisper API
                                                   │      (transcription)
                                                   │
                                                   └── S3 / R2
                                                          (object storage)
```

The honoree is explicitly listed as an excluded actor. Every notification path checks: "does this expose the event to the honoree?"

---

## 3. Logical Architecture — Bounded Contexts

The system divides into six bounded contexts. Each owns its data, exposes a clean interface, and can be reasoned about independently.

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Event Management │  │  Submission      │  │  Media Pipeline  │
│                  │  │  Collection      │  │                  │
│ Organizer flow:  │  │ Contributor flow:│  │ AI processing:   │
│ create event,    │  │ public form,     │  │ transcribe,      │
│ payment,         │  │ flexible media,  │  │ analyze,         │
│ packages,        │  │ deadline gate,   │  │ score quality,   │
│ share artifacts  │  │ direct-to-S3     │  │ complexity score │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                     │
         └──────────┬──────────┴──────────┬──────────┘
                    │                     │
            ┌───────▼─────────────────────▼──────┐
            │     Editorial Workflow             │
            │                                    │
            │ Admin dashboard, AI vs Manual      │
            │ routing, script/storyboard review, │
            │ approval, editor assignment        │
            └────────────────┬───────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
     ┌────────▼────────┐         ┌──────────▼─────────┐
     │  Delivery       │         │  Notifications     │
     │                 │         │                    │
     │ Output encoding,│         │ Email + WhatsApp   │
     │ share page,     │         │ dispatcher; cron   │
     │ download links  │         │ reminders;         │
     │                 │         │ surprise filtering │
     └─────────────────┘         └────────────────────┘
```

**Why bounded contexts and not microservices:** v1 ships as a modular monolith. Contexts are enforced via folder boundaries and explicit service interfaces, not network calls. The pipeline and notification dispatcher run as separate worker processes (long-running jobs), but everything else lives in one deployable. This minimizes ops burden for an early-stage product while preserving the seams for future splitting.

---

## 4. Physical Deployment

```
┌─────────────────────────────────────────────────────────────────┐
│                      Vercel (Edge + Functions)                  │
│                                                                 │
│  Next.js App: SSR pages, API routes (sync only, <60s)           │
│  - Organizer pages, Admin dashboard, Contributor form           │
│  - Auth endpoints, presigned URL generation                     │
│  - Stripe webhook receiver                                      │
└────────────────┬──────────────────────────────┬─────────────────┘
                 │                              │
                 ▼                              ▼
       ┌──────────────────┐          ┌──────────────────┐
       │   PostgreSQL     │          │  Redis (BullMQ)  │
       │   (Neon/Supabase)│          │  Upstash         │
       │                  │          │                  │
       │ All relational   │          │ Job queues,      │
       │ data, audit log  │          │ rate-limit state │
       └──────────────────┘          └────────┬─────────┘
                                              │
                              ┌───────────────┴─────────────────┐
                              │                                 │
                              ▼                                 ▼
                  ┌────────────────────────┐      ┌────────────────────────┐
                  │  Worker Service        │      │  Encoder Service       │
                  │  (Railway / Fly.io)    │      │  (Railway / Fly.io)    │
                  │                        │      │                        │
                  │  Node.js workers:      │      │  FFmpeg-based:         │
                  │  - Transcription       │      │  - HD → Reel crop      │
                  │  - Analysis (Claude)   │      │  - YouTube encode      │
                  │  - Quality scoring     │      │  - Thumbnail extract   │
                  │  - Storyboard/script   │      │  - Subtitle burn-in    │
                  │  - Brief ZIP assembly  │      │                        │
                  │  - Notifications       │      │  Pulled out of main    │
                  │                        │      │  workers because FFmpeg│
                  │                        │      │  is CPU-heavy and      │
                  │                        │      │  benefits from a       │
                  │                        │      │  dedicated pool        │
                  └──────────┬─────────────┘      └────────────┬───────────┘
                             │                                 │
                             └────────────────┬────────────────┘
                                              │
                                              ▼
                                  ┌────────────────────────┐
                                  │   Object Storage       │
                                  │   (S3 / Cloudflare R2) │
                                  │                        │
                                  │   Direct browser       │
                                  │   uploads via          │
                                  │   presigned URLs       │
                                  │                        │
                                  │   Final videos served  │
                                  │   via CloudFront/      │
                                  │   Cloudflare CDN       │
                                  └────────────────────────┘
```

**Why three deployment targets:**
- **Vercel** for the web app: edge SSR is genuinely useful for contributor form latency (contributors are global), and serverless API routes are cheap for the request/response surface.
- **Long-running workers cannot live on Vercel.** Whisper jobs and brief-package assembly routinely exceed 60s. They live on Railway/Fly where a Node process can run indefinitely.
- **Encoder workers split from main workers.** FFmpeg is CPU-bound and benefits from a dedicated pool with different scaling characteristics (scale on queue depth, not request rate). Keeping AI jobs and encoding jobs in the same pool would cause head-of-line blocking.

**Why Cloudflare R2 is the better choice than S3** for this app: egress is free, and the final video downloads can be large and bursty. R2 + Cloudflare CDN keeps delivery costs predictable.

---

## 5. Technology Decisions

| Layer | Choice | Rationale (the real reason, not the marketing one) |
|---|---|---|
| Web framework | Next.js 15 (App Router) | Server Components for admin dashboard reduce client bundle; Server Actions handle form submissions without writing API routes; single deployable for all three UIs |
| Language | TypeScript everywhere | Workers and web share Prisma types and Zod schemas; the AI prompt outputs are typed end-to-end |
| Database | PostgreSQL | JSON columns for storyboard, FTS for transcripts, transactional integrity for payment + event activation |
| ORM | Prisma | Migration story is mature; works the same in workers and web |
| Object storage | Cloudflare R2 (or S3) | R2 has zero egress fees, important for video delivery |
| Queue | BullMQ on Redis | Job DAGs, retries, priorities, observability dashboard out of the box |
| Auth | NextAuth.js | Magic link email for Organizer; Google OAuth for Admin |
| Email | Resend | Better DX than SendGrid; React email templates |
| WhatsApp | Meta Cloud API direct | Cheaper than Twilio for transactional templates; template approval required |
| Payment | Stripe Checkout | Hosted checkout means we never touch card data; webhooks activate the event |
| Transcription | OpenAI Whisper API | Fastest, most accurate for casual recordings; alternative: self-hosted Whisper if cost grows |
| Reasoning LLM | Claude (claude-sonnet-4-6 default, claude-opus-4-7 for storyboard) | Sonnet for cheap per-submission analysis; Opus for the single-shot, high-stakes storyboard generation per event |
| Video encoding | FFmpeg in workers | Self-hosted is cheaper than MediaConvert for our volumes; revisit if encoder queue depth becomes a problem |
| Search | Postgres FTS | Transcript search inside admin doesn't justify a separate search service |
| Observability | OpenTelemetry → Honeycomb or Axiom | Trace pipeline jobs end-to-end (submission → final video) |

**Two model tiers, deliberately:** Sonnet runs on every submission (potentially hundreds per event); Opus runs once per event for the storyboard. Cost per event is dominated by submission-level work, and Sonnet's reasoning is sufficient for sentiment/quote extraction. The storyboard, by contrast, is the creative crown jewel — Opus's deeper reasoning is worth the extra dollar once.

---

## 6. Key Workflows — Sequence Detail

### 6.1 Event Creation → Activation

```
Organizer                   Web App                Stripe                  DB
   │                          │                      │                     │
   ├─ fill wizard ───────────►│                      │                     │
   │                          ├─ create draft ──────────────────────────►──┤
   │                          │  event_status=DRAFT                        │
   │                          ├─ create checkout session ───►│             │
   │                          │◄─ session_url ───────────────│             │
   │◄── redirect ─────────────│                              │             │
   │                                                         │             │
   ├── pays on Stripe ──────────────────────────────────────►│             │
   │                                                         │             │
   │                          │◄── webhook (checkout.completed) ───────────┤
   │                          │                              │             │
   │                          ├─ activate event ────────────────────────►──┤
   │                          │  event_status=ACTIVE                       │
   │                          │  generate slug, QR, share text             │
   │                          ├─ enqueue: send organizer confirmation ──►──┤
   │                          │                                            │
   │◄── confirmation page ────│                                            │
```

**Critical:** Event activation happens only on Stripe webhook receipt, never on the redirect URL. A user can manipulate the redirect; the webhook is signed.

### 6.2 Contributor Submission

```
Contributor              Web App           S3              DB           Queue
    │                       │               │              │             │
    ├─ load form ──────────►│               │              │             │
    │                       ├─ check deadline ───────────►─┤             │
    │                       │◄──── still open ─────────────┤             │
    │◄─ form rendered ──────│                                            │
    │                                                                    │
    ├─ pick files ──────────►│                                           │
    │                       ├─ presigned POST URLs ────►│                │
    │                       │◄──── URLs ────────────────│                │
    │◄── URLs ───────────────│                                           │
    │                                                                    │
    ├── direct upload ────────────────────►│                             │
    │◄────── 200 ──────────────────────────│                             │
    │                                                                    │
    ├─ submit metadata ─────►│                                           │
    │                       ├─ verify files exist in S3 ►│               │
    │                       │◄─ ok ──────────────────────│               │
    │                       ├─ insert submission ──────────────────►─────┤
    │                       ├─ enqueue pipeline jobs ───────────────────►├──►
    │◄── thank-you page ────│                                            │
```

**Why files go direct to S3:** the API server never proxies bytes. A 500MB video upload would otherwise saturate Vercel's function memory. Presigned POST URLs let the browser PUT directly to R2.

**Why we verify files exist before saving the submission:** prevents orphan DB rows pointing at uploads that the client abandoned.

### 6.3 AI Pipeline (per submission)

The pipeline is a DAG of jobs. Each job is idempotent and can be retried independently.

```
            ┌─────────────────┐
            │ submission.created │
            └────────┬────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
  ┌──────────┐            ┌──────────────┐
  │ quality  │            │ transcribe   │ (skipped if no audio/video)
  │ scoring  │            └──────┬───────┘
  └────┬─────┘                   │
       │                         │
       └──────────┬──────────────┘
                  │
                  ▼
            ┌──────────┐
            │ analyze  │  (Claude Sonnet: sentiment, quotes, tags)
            └─────┬────┘
                  │
                  ▼
            ┌────────────────┐
            │ score complexity │  (recalculate event-level routing)
            └────────────────┘

                  +
                  
            [Event-level, fires at deadline]
                  
                  ▼
            ┌────────────┐
            │ storyboard │  (Claude Opus: order all media coherently)
            └─────┬──────┘
                  │
                  ▼
            ┌────────────┐
            │ narration  │
            │ script     │
            └─────┬──────┘
                  │
                  ▼
            ┌─────────────────┐
            │ intro/outro text │
            └─────┬───────────┘
                  │
                  ▼
            ┌────────────┐
            │ subtitles  │ (align Whisper output to clip cuts)
            └─────┬──────┘
                  │
                  ▼
            ┌────────────────────┐
            │ admin notification │
            │ event_status=IN_REVIEW
            └────────────────────┘
```

**Idempotency keys:** every job uses `{event_id}:{submission_id}:{job_type}` as its idempotency key. Re-running a job on the same input produces the same output (overwrites by key).

**Failure handling:** Transcription failures retry 3x with backoff. If still failing, mark the media item as `transcription_failed` and proceed without it. The admin sees a flag in the dashboard and can request a manual transcript.

### 6.4 Routing Analyzer & Approval Gate

A deterministic, sub-second rule-based analyzer recommends AI or Manual routing. Admin must approve before the path executes. This is the operational lever that lets Swara scale: simple events fast-track through AI; complex events route to the editor pool.

**Why rule-based, not LLM-based (MVP 1):**
- The analyzer runs after every submission (potentially dozens per event). A rule-based engine costs nothing and runs in <50ms. An LLM call would add cost without changing the answer in 95% of cases — the inputs are structured metadata, not free text.
- Rules are explainable to admin without round-tripping through a model.
- MVP 2 may layer an LLM-based "second opinion" for edge cases, but the rule engine remains the primary path.

**Analyzer module:**

```typescript
// /services/routing-analyzer.ts

type Signal = {
  name: string;
  direction: 'AI' | 'MANUAL';   // which way it pushes
  weight: number;               // 0..1
  triggered: boolean;
  message: string;              // human-readable for admin UI
};

type RoutingResult = {
  recommendation: 'AI' | 'MANUAL';
  confidence: number;           // 0..1
  signalsSupporting: Signal[];  // shown as "Why this fits"
  signalsOpposing: Signal[];    // shown as "Why the other might be better"
  computedAt: Date;
};

function analyzeEvent(event: EventWithSubmissions): RoutingResult;
```

The analyzer returns BOTH supporting and opposing signals. The admin UI shows opposing signals deliberately to surface the strongest counter-argument and reduce confirmation bias.

**When it runs:**
- After every submission analysis job completes (live preview).
- One final run at the submission deadline (canonical run).

**On final run at deadline:**
1. Result is persisted to `Event.routingRecommendation`, `routingConfidence`, `routingSignals`.
2. Event status flips from `ACTIVE` (or `DEADLINE_PASSED`) to `AWAITING_ROUTING_APPROVAL`.
3. Admin notification fires (`event.routing_ready`).

**Admin approval is the gate:**

```
event_status: AWAITING_ROUTING_APPROVAL
                    │
        ┌───────────┴───────────┐
   Approve AI            Switch to Manual
        │                       │
        ▼                       ▼
  status=AI_ROUTED        status=MANUAL_ROUTED
        │                       │
        ▼                       ▼
  Pipeline: storyboard    Admin assigns editor
  → script → render       from internal pool
```

Until admin acts, nothing downstream runs. No surprise charges to Claude Opus, no editor brief built, no encoder jobs queued.

**Audit record on every decision:**

```typescript
{
  action: 'routing.approved' | 'routing.switched',
  actorId: <admin_user_id>,
  metadata: {
    recommendation: 'AI' | 'MANUAL',
    confidence: 0.87,
    chosen: 'AI' | 'MANUAL',
    signalsShown: [...],
    timestamp: '2026-05-17T...'
  }
}
```

Override rate is a key product metric. If admins switch to Manual >X% of the time on AI recommendations, the rules need tuning (or the events are genuinely harder than the analyzer thinks).

### 6.5 Manual Editing Workflow

```
Admin                Web App          DB              Worker           Editor
  │                    │               │                │                │
  ├─ trigger manual ──►│                                                 │
  │                    ├─ create EditorAssignment (status=ASSIGNED) ────►│
  │                    ├─ enqueue: build brief ZIP ──────────►│          │
  │                    │                                      │          │
  │                    │                                      ├─ stream  │
  │                    │                                      │  ZIP to  │
  │                    │                                      │  S3      │
  │                    │                                      │          │
  │                    │◄── brief ready ──────────────────────┤          │
  │                    ├─ enqueue: email editor ──────────────┼──────────►
  │                    │                                                  
  │                                                            ┌──────────┘
  │                                                            ▼
  │                                              Editor receives email:
  │                                              - Download link (signed JWT, expires delivery+7d)
  │                                              - Upload link (signed JWT, same expiry)
  │                                              - Brief text inline
  │                                                            │
  │                                                            ▼
  │                                              [Editor works offline]
  │                                                            │
  │                                              ┌─────────────┘
  │                                              ▼
  │                              ┌─ uploads final.mp4 via signed link
  │                              │
  │                    │◄────────┘
  │                    ├─ verify JWT, check expiry, validate MP4 ──►│
  │                    ├─ store in /events/{id}/final/ ─────────────►│
  │                    ├─ update assignment.status=UPLOADED ────────►│
  │                    ├─ enqueue: notify admin ────────────────────►│
  │◄── final ready ────│
  │                                                                 
  ├─ review video ────►│                                            │
  │                                                                 
  ├─ approve ─────────►│                                            │
  │                    ├─ enqueue: encode variants (reel, YT, thumb)
  │                    ├─ generate share page                       │
  │                    ├─ notify organizer                          │
```

**JWT structure for editor links:**
```
{
  "kind": "brief" | "upload",
  "event_id": "evt_xxx",
  "assignment_id": "asg_xxx",
  "exp": <delivery_date + 7d>,
  "iat": <now>
}
```
Signed with `EDITOR_TOKEN_SECRET`. Verified on every request to `/editor-portal/*`. Single-use is not enforced — editors may revisit the brief multiple times during editing.

**Brief assembly is streaming.** The ZIP is built in chunks and uploaded multipart to S3. Holding a 5GB ZIP in memory is not acceptable.

---

## 7. Data Architecture

### 7.1 Database (Prisma schema)

```prisma
model Event {
  id                   String           @id @default(cuid())
  slug                 String           @unique
  organizerId          String
  organizer            User             @relation(fields: [organizerId], references: [id])

  honoreeName          String
  honoreeEmail         String?          // NEVER USED FOR NOTIFICATIONS — see §10
  occasionType         OccasionType
  eventDate            DateTime
  submissionDeadline   DateTime
  deliveryDate         DateTime
  theme                String
  musicMood            String
  expectedContributors Int
  packageId            String

  paymentStatus        PaymentStatus    @default(PENDING)
  stripeSessionId      String?
  status               EventStatus      @default(DRAFT)

  routingRecommendation RoutingDecision?  // analyzer output (AI | MANUAL)
  routingConfidence     Float?
  routingSignals        Json?             // {supporting: [...], opposing: [...]}
  routingDecision       RoutingDecision?  // admin's approved decision (set only after approval gate)
  routingDecidedBy      String?           // admin user_id
  routingDecidedAt      DateTime?

  submissions          Submission[]
  aiArtifact           AiArtifact?
  editorAssignment     EditorAssignment?
  finalVideos          FinalVideo[]
  notifications        NotificationLog[]
  auditLog             AuditLog[]

  createdAt            DateTime         @default(now())
  updatedAt            DateTime         @updatedAt

  @@index([status, submissionDeadline])  // for reminder cron sweeps
}

model Submission {
  id              String           @id @default(cuid())
  eventId         String
  event           Event            @relation(fields: [eventId], references: [id], onDelete: Cascade)

  contributorName String
  relationship    String
  email           String?

  mediaItems      MediaItem[]
  textMessage     String?
  funnyMemory     String?
  advice          String?
  professionalNote String?

  consentGiven    Boolean
  consentAt       DateTime         // recorded separately; never null when consentGiven=true

  overallQualityScore Float?
  status          SubmissionStatus @default(PENDING)
  adminNote       String?

  transcript      String?          @db.Text
  sentiment       String?
  extractedQuotes Json?            // array of strings
  tags            String[]

  submittedAt     DateTime         @default(now())
  ipAddress       String?          // for abuse detection only

  @@unique([eventId, email])       // one submission per email per event
  @@index([eventId, status])
}

model MediaItem {
  id           String      @id @default(cuid())
  submissionId String
  submission   Submission  @relation(fields: [submissionId], references: [id], onDelete: Cascade)

  type         MediaType
  storagePath  String
  originalName String
  sizeBytes    Int
  mimeType     String

  qualityScore Float?
  qualityFlags String[]    // ["low_audio", "blurry", "portrait"]
  duration     Int?        // seconds (audio/video only)
  width        Int?        // pixels (video/photo only)
  height       Int?

  uploadedAt   DateTime    @default(now())
}

model AiArtifact {
  id               String   @id @default(cuid())
  eventId          String   @unique
  event            Event    @relation(fields: [eventId], references: [id], onDelete: Cascade)

  narrationScript  String?  @db.Text
  storyboardJson  Json?
  introText        String?
  outroText        String?
  extractedQuotes  Json?
  sentimentSummary String?

  modelVersions    Json     // {sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-7", whisper: "v3"}
  promptVersions   Json     // {storyboard: "v2", narration: "v1"}

  adminApproved    Boolean  @default(false)
  generatedAt      DateTime @default(now())
}

model EditorAssignment {
  id              String           @id @default(cuid())
  eventId         String           @unique
  event           Event            @relation(fields: [eventId], references: [id], onDelete: Cascade)

  editorName      String
  editorEmail     String

  briefPackagePath String?         // S3 path, null until built
  briefExpiresAt  DateTime
  uploadExpiresAt DateTime

  status          AssignmentStatus @default(ASSIGNED)
  editorNote      String?
  adminFeedback   String?          // revision notes, if any

  finalVideoPath  String?
  uploadedAt      DateTime?

  assignedAt      DateTime         @default(now())
}

model FinalVideo {
  id          String   @id @default(cuid())
  eventId     String
  event       Event    @relation(fields: [eventId], references: [id], onDelete: Cascade)

  source      VideoSource          // AI_GENERATED | EDITOR_UPLOADED
  variant     VideoVariant         // MASTER | REEL | YOUTUBE | THUMBNAIL
  storagePath String
  durationSec Int?
  sizeBytes   Int

  createdAt   DateTime @default(now())
}

model SharePage {
  id           String   @id @default(cuid())
  eventId      String   @unique
  event        Event    @relation(fields: [eventId], references: [id], onDelete: Cascade)

  token        String   @unique     // random 32-byte URL-safe; the share URL
  passwordHash String?              // optional password protection
  expiresAt    DateTime?

  viewCount    Int      @default(0)
  createdAt    DateTime @default(now())
}

model NotificationLog {
  id            String   @id @default(cuid())
  eventId       String?
  event         Event?   @relation(fields: [eventId], references: [id], onDelete: SetNull)

  recipientType String   // organizer | contributor | admin | editor
  recipientEmail String  // logged for audit; redacted in non-prod
  channel       String   // email | whatsapp
  trigger       String   // event.activated | deadline.48h | etc.

  status        String   // sent | failed | suppressed_surprise
  errorMessage  String?

  sentAt        DateTime @default(now())

  @@index([eventId, trigger])
}

model AuditLog {
  id        String   @id @default(cuid())
  eventId   String?
  event     Event?   @relation(fields: [eventId], references: [id], onDelete: SetNull)
  actorId   String?  // user_id; null for system events
  action    String   // routing.override | submission.approved | etc.
  metadata  Json?
  createdAt DateTime @default(now())
}

model User {
  id     String @id @default(cuid())
  email  String @unique
  name   String?
  role   Role   @default(ORGANIZER)
  events Event[]
}

// Enums
enum OccasionType    { GRADUATION BIRTHDAY WEDDING ANNIVERSARY RETIREMENT BUSINESS_EVENT }
enum EventStatus     { DRAFT ACTIVE DEADLINE_PASSED AWAITING_ROUTING_APPROVAL AI_ROUTED MANUAL_ROUTED EDITOR_ASSIGNED EDITING_IN_PROGRESS FINAL_VIDEO_UPLOADED IN_REVIEW DELIVERED }
enum PaymentStatus   { PENDING PAID REFUNDED FAILED }
enum RoutingDecision { AI MANUAL }
enum SubmissionStatus{ PENDING APPROVED REJECTED FLAGGED }
enum AssignmentStatus{ ASSIGNED IN_PROGRESS UPLOADED APPROVED REVISION_REQUESTED }
enum MediaType       { VIDEO VOICE PHOTO }
enum VideoSource     { AI_GENERATED EDITOR_UPLOADED }
enum VideoVariant    { MASTER REEL YOUTUBE THUMBNAIL }
enum Role            { ORGANIZER ADMIN }
```

**Schema decisions worth calling out:**

- `MediaItem` is a separate table, not a JSON column. Each media item has independent quality scoring, gets processed independently, and may be filtered/reordered in the storyboard. JSON would force us to update the whole submission record on every per-media change.
- `consentAt` is separate from `consentGiven` so we have an auditable timestamp. Never null when consent is given.
- `modelVersions` and `promptVersions` on `AiArtifact` are recorded so we can correlate output quality with prompt changes when we tune the prompts.
- `routingOverride` is separate from `routingDecision` — we keep the system's recommendation AND the admin's override, both for analytics.
- `NotificationLog.status` has a `suppressed_surprise` value — if a notification was attempted to a honoree email, we suppress and log it. Belt and braces.
- `SharePage` is its own entity with its own token and optional password. We don't reuse the event slug — share access is a distinct concern.

### 7.2 Object Storage Layout

```
swara-magical/
  events/{event_id}/
    submissions/
      {submission_id}/
        media/
          {media_id}.mp4
          {media_id}.m4a
          {media_id}.jpg
        transcripts/
          {media_id}.json     # Whisper raw output with word timestamps
    artifacts/
      storyboard.json
      script.md
      script.pdf
      subtitles.srt
      thumbnail-candidates/    # AI-picked frame stills
    editor-brief/
      brief_{assignment_id}.zip
    final/
      master.mp4              # Full HD primary
      reel.mp4                # Instagram vertical
      youtube.mp4
      thumbnail.jpg
    share/
      poster.jpg              # OG image for share page (still SAFE for surprise; never honoree's face publicly indexed)
```

**Access patterns:**
- All paths are private ACL.
- Browser uploads use presigned POST (15-minute expiry, single-key scoped).
- Admin downloads use presigned GET (15-minute expiry).
- CDN-served paths (final delivery, share page assets) use signed CloudFront/Cloudflare URLs with 24-hour expiry and rotate.

---

## 8. Async Processing Architecture

### 8.1 Queue Topology

| Queue | Concurrency | Priority | Notes |
|---|---|---|---|
| `transcription` | 8 | High | Whisper API; the longest single job; concurrency capped to respect API rate limits |
| `analysis` | 4 | High | Claude Sonnet; cheap, runs per submission |
| `quality` | 16 | High | FFprobe; fast, CPU-light |
| `storyboard` | 1 | Normal | Claude Opus; one per event; serialized to control cost spikes |
| `script` | 2 | Normal | Claude Sonnet |
| `brief_zip` | 2 | Normal | Streaming ZIP assembly; IO-heavy |
| `encoding` | 2 | Normal | FFmpeg; dedicated encoder workers (see §4) |
| `notifications` | 10 | High | Email + WhatsApp dispatch |
| `reminders` | 1 | Low | Cron-triggered sweep |

**Concurrency tuning principle:** queues that hit external rate-limited APIs get conservative concurrency. Queues that do local work scale with CPU.

### 8.2 Job Idempotency Contract

Every job MUST be safe to retry. The contract:
1. Job inputs include all data needed (no implicit state from "last run").
2. Job outputs are written by deterministic key (`event_id + submission_id + job_type`).
3. Side effects (notification sends, payment captures) check the audit log before emitting; if already sent, no-op.

### 8.3 Reminder Scheduler

A single cron job runs every hour. It queries:

```sql
SELECT id, submission_deadline, expected_contributors,
       (SELECT count(*) FROM submissions WHERE event_id = events.id) AS submitted
FROM events
WHERE status = 'ACTIVE'
  AND submission_deadline > NOW();
```

For each active event, it evaluates reminder triggers:
- Submitted/expected crossed 25/50/75% threshold since last sweep → organizer milestone.
- `submission_deadline - NOW()` is in `[47h, 48h]` or `[23h, 24h]` window → contributor reminders.
- `submission_deadline` just passed → close form, alert admin, notify organizer.

Triggers are recorded in `NotificationLog` so duplicates can't fire.

---

## 9. AI Architecture

### 9.1 Model Tiering

| Use case | Model | Why |
|---|---|---|
| Sentiment, quote extraction, tagging | Claude Sonnet 4.6 | Per-submission, cost-sensitive; Sonnet is more than capable |
| Storyboard generation | Claude Opus 4.7 | Single-shot per event; the creative heart of the output; depth of reasoning matters |
| Narration script | Claude Sonnet 4.6 | Tone-following from quotes; Sonnet handles it |
| Intro/outro text | Claude Sonnet 4.6 | Simple template-driven generation |
| Transcription | Whisper API v3 | Best-in-class accuracy on casual recordings |

### 9.2 Prompt Architecture

Prompts are versioned templates in `/prompts/`. Each prompt is a function that takes typed inputs and returns a typed result. The prompt service handles:
- Template rendering
- Schema validation on output (Zod)
- Retry with backoff on JSON parse failures
- Token usage logging per call
- Model version recording in `AiArtifact.modelVersions`

```typescript
// Example shape
const StoryboardSchema = z.object({
  sequence: z.array(z.object({
    submission_id: z.string(),
    media_item_id: z.string(),
    media_type: z.enum(['video', 'voice', 'photo', 'text']),
    duration_sec: z.number(),
    clip_note: z.string(),       // editor-readable
    transition_in: z.string(),
    caption: z.string().optional()
  })),
  total_duration_sec: z.number(),
  pacing_notes: z.string()
});

async function generateStoryboard(input: StoryboardInput): Promise<z.infer<typeof StoryboardSchema>>;
```

### 9.3 Prompt Caching Strategy

Claude's prompt caching offers massive savings here. The event-level context (occasion type, theme, all approved submissions) is shared across:
- Storyboard generation
- Narration script
- Intro/outro generation

We structure all three prompts with a stable cached prefix (event metadata + all submission summaries) and a variable suffix (the specific task instruction). Result: cache hits on the second and third calls for the same event, ~80% input cost reduction.

### 9.4 Quality Scoring (non-LLM)

Quality is scored without AI to keep it fast and deterministic:

| Media | Signals | Threshold |
|---|---|---|
| Video | FFprobe avg bitrate, resolution, audio peak dB, blur (Laplacian variance on N sampled frames) | composite score 0–100 |
| Voice | FFprobe audio peak/avg dB, sample rate, duration | score 0–100 |
| Photo | Resolution, blur (Laplacian variance), exposure (histogram check) | score 0–100 |

Anything below 40 is flagged. Anything below 20 is auto-rejected with admin notification.

---

## 10. Security & Surprise Integrity

### 10.1 Surprise Integrity Controls

The honoree must never receive a system communication or stumble onto the share page early. Controls:

1. **No honoree contact field is wired to notifications.** `Event.honoreeEmail` exists for reference only and is excluded from every notification dispatcher by a shared filter:
   ```typescript
   if (recipientEmail === event.honoreeEmail) {
     await log.notification({ status: 'suppressed_surprise', ... });
     return; // never send
   }
   ```
2. **Share page is `noindex, nofollow` + no referrer leakage** via meta tags and Referrer-Policy headers.
3. **Share page token is 32-byte cryptographically random** and never appears in server logs (URL is logged only as `/share/[redacted]`).
4. **Optional password** on share page; required when organizer flags the event as `is_surprise=true`.
5. **OG/share preview images are honoree-name-free** by default; opt-in to richer previews after event date.

### 10.2 Auth Model

| Actor | Mechanism |
|---|---|
| Organizer | NextAuth magic-link email |
| Admin | NextAuth Google OAuth, restricted to allowlisted email domains, `role=ADMIN` in DB |
| Contributor | Anonymous; rate-limited per IP; one submission per email per event |
| Editor | Signed JWT in URL; no session |
| Honoree | None — actively excluded |

### 10.3 File Upload Security

- MIME type validated server-side after upload (don't trust browser).
- MP4/MOV/MP3/M4A/JPG/PNG allowlist only.
- ClamAV scan in a background job; quarantine on detection.
- Per-event presigned URLs scoped to `events/{event_id}/...` keys.

### 10.4 Editor Token Security

- HMAC-signed JWT with `kind`, `event_id`, `assignment_id`, `exp`.
- `exp` = `delivery_date + 7 days`.
- Verified on every request; expired tokens return 410 Gone.
- IP and user-agent logged on first use; mismatch warns admin but doesn't block (editors travel).

### 10.5 Threat Model Summary

| Threat | Mitigation |
|---|---|
| Surprise leak via email | Honoree filter in notifications; suppressed log entries |
| Surprise leak via search engine | noindex + referrer policy + unguessable token |
| Spoofed contribution | One per email; rate limit per IP; optional captcha for >100-contributor events |
| Editor token theft | Short expiry; IP logging; admin can revoke assignment |
| Payment fraud | Stripe Radar |
| Spam/abuse uploads | Size limits, type allowlist, ClamAV, rate limits |
| Data leak via misconfigured S3 | Private ACL by default; presigned URLs only; periodic config audit |
| Data retained too long | 30-day scheduled deletion + user-initiated right to delete (see §11.4) |

---

## 11. Reliability & Failure Handling

### 11.1 What can fail and how we cope

| Failure | Response |
|---|---|
| Whisper API timeout | 3 retries with backoff; if all fail, mark media item `transcription_failed`, proceed without transcript, admin sees flag |
| Claude rate limit | Exponential backoff to 5 minutes; if still failing, queue holds; alert admin if hold exceeds 30 min |
| Payment webhook missed | Stripe redelivers; idempotent webhook handler dedupes by `stripe_session_id` |
| Editor doesn't deliver before delivery date | Admin alert at delivery_date − 48h if no upload; admin can reassign |
| Final video upload corrupted | Server-side ffprobe validates on upload; reject with editor notification if invalid |
| Notification dispatch fails | 3 retries; on permanent failure, admin alert, organizer sees status in their dashboard |
| Worker process crash | BullMQ requeues stuck jobs after lock timeout; jobs are idempotent so safe |

### 11.2 SLA Tracking

Each event has an implicit SLA: deliver by `delivery_date`. We track:
- Time remaining vs. work remaining (submissions still in pipeline)
- Hours since editor assignment (manual workflow)
- Risk score: red/amber/green displayed prominently in admin event list

Red events surface at the top of the admin event list, regardless of recency.

### 11.3 Backups

- Postgres: daily snapshot, point-in-time recovery via Neon/Supabase.
- S3/R2: versioning enabled on the `final/` and `submissions/` prefixes; lifecycle rule to expire old versions after 90 days.

### 11.4 Data Retention & Deletion

Two deletion paths: scheduled (30-day post-event) and user-initiated (on demand).

**Scheduled deletion (default lifecycle):**

```
Event date ─── +30 days ─── Reminder sent ─── +7 days ─── Hard delete
                                                          (data destroyed)
```

A daily cron sweep evaluates:
- Events where `event_date + 30 days < NOW()` and `retention_reminder_sent_at IS NULL` → send reminder, set timestamp.
- Events where `retention_reminder_sent_at + 7 days < NOW()` and `retention_extended = false` → hard delete.

**Reminder content (to organizer):** "Your event video will be deleted on {date}. Reply or click the link in your dashboard to download it now or extend retention by 30 more days."

**Extension:** organizer can extend by 30 days, up to 2 times (max 90 days post-event). After that, hard delete is forced.

**User-initiated deletion (right to delete):**

Available to:
- **Organizer** — can delete the entire event and all associated data from their dashboard.
- **Contributor** — can request deletion of their own submission via a self-service link included in their submission confirmation email. Deleting a single submission does not delete the event.

Both flows:
1. Confirmation step (2-click pattern).
2. Soft-delete immediately (rows marked deleted, files moved to `deleted/` prefix in S3).
3. Hard-delete after 72-hour grace period (cron sweep purges DB rows and S3 files).
4. Notification log retains the deletion event (without PII) for audit.

**What hard-delete removes:**
- All `MediaItem` files in S3.
- `Submission`, `MediaItem`, `AiArtifact`, `EditorAssignment`, `FinalVideo`, `SharePage`, `Event` rows.
- Final video files in `events/{event_id}/final/`.

**What is retained (de-identified, for audit):**
- `NotificationLog` entries with email redacted to a hash.
- `AuditLog` entries with PII stripped.
- Stripe payment records (Stripe-side; we retain only `stripe_session_id` reference).

**Schema additions for retention:**

```prisma
model Event {
  // ... existing fields ...
  retentionReminderSentAt DateTime?
  retentionExtendedCount  Int       @default(0)
  retentionDeleteAt       DateTime? // computed: event_date + 30d, extended as needed
  deletedAt               DateTime? // soft-delete timestamp
  hardDeleteAt            DateTime? // when hard delete should fire (soft + 72h)
}

model Submission {
  // ... existing fields ...
  deletionToken           String?   @unique  // self-service deletion link
  deletedAt               DateTime?
  hardDeleteAt            DateTime?
}
```

---

## 12. Scalability Strategy

The system has clear bottlenecks at predictable points. The strategy:

| Bottleneck | When it hits | How we scale |
|---|---|---|
| Whisper API rate limits | Hundreds of submissions in a deadline window | Per-org rate limit pools; consider self-hosted Whisper at scale |
| Claude rate limits | Many events hitting deadline same day | Prompt caching + tiered keys per env |
| FFmpeg encoding throughput | Many events delivered same day | Horizontally scale encoder workers based on queue depth |
| Brief ZIP assembly | Many manual workflows triggered same day | Streaming assembly + horizontal worker scale |
| Database hot writes | High contributor concurrency during deadline windows | Read replicas; writes are already low (single submission insert per contributor) |
| S3 PUT throughput | Many concurrent uploads | S3 scales automatically; client-side concurrency limited to 3 parallel uploads |

**Bimodal workload provisioning:** workers scale on queue depth, not constant baseline. During quiet periods (most days), 1–2 workers per pool. Near deadlines, autoscale to 10+. Done via Railway/Fly autoscaling rules tied to BullMQ queue depth metric.

---

## 13. Observability

| Layer | What we capture | Where |
|---|---|---|
| Web app | Request traces, error rates, page render time | Vercel Analytics + Honeycomb |
| Workers | Job durations, retry counts, success/failure rates, queue depth | OpenTelemetry → Honeycomb |
| AI calls | Model, prompt version, token counts, latency, output validation pass/fail | App-level metrics → Honeycomb |
| Pipeline end-to-end | Trace per submission from form-submit to admin-notification | OTel trace with `event_id` and `submission_id` as span attributes |
| Business metrics | Events created, submissions per event, AI vs manual routing ratio, on-time delivery rate | Daily snapshot to a metrics table |

**Critical alerts (page someone):**
- Stripe webhook failures > 5/hour
- Claude/Whisper sustained 5xx > 10 min
- Any event with `delivery_date < NOW() + 24h` and `status != DELIVERED`
- Any honoree-email suppression event (potential data model bug)
- Worker queue depth > 100 for any high-priority queue

---

## 14. Environments

| Env | Purpose | Data |
|---|---|---|
| `development` | Local dev | Seed data, fake Stripe, no AI calls (or routed to cheap models) |
| `staging` | Pre-prod testing | Anonymized prod data refresh; Stripe test mode |
| `production` | Live | Stripe live mode; real notifications |

**Environment variables:**
```
# Database
DATABASE_URL

# Storage
S3_ENDPOINT                # e.g., R2 endpoint
S3_BUCKET
S3_REGION
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY

# CDN
CDN_DOMAIN                 # e.g., media.swaramagical.com
CDN_SIGNING_KEY

# Auth
NEXTAUTH_SECRET
NEXTAUTH_URL
ADMIN_EMAIL_DOMAINS        # comma-separated allowlist

# Payments
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PUBLISHABLE_KEY

# AI
ANTHROPIC_API_KEY
OPENAI_API_KEY             # Whisper
SONNET_MODEL=claude-sonnet-4-6
OPUS_MODEL=claude-opus-4-7
WHISPER_MODEL=whisper-1

# Notifications
RESEND_API_KEY
RESEND_FROM_ADDRESS
WHATSAPP_API_TOKEN         # optional
WHATSAPP_PHONE_ID          # optional

# Redis / queues
REDIS_URL

# Editor tokens
EDITOR_TOKEN_SECRET        # 64-byte random; rotate annually
EDITOR_TOKEN_EXPIRY_BUFFER_DAYS=7

# App
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_SHARE_DOMAIN   # share pages may live on a different domain
```

---

## 15. Architectural Boundaries (What This Architecture Refuses)

These are not future work — they are intentional refusals to do things badly:

- **No in-browser video editor.** Browser video editing is unreliable and slow. Editing happens in pro tools or via the AI pipeline.
- **No editor portal accounts.** Editors are transient; a portal account model adds cost without value.
- **No real-time collaboration on scripts.** Admin owns the script. Organizer sees the final.
- **No SMS notifications.** Email + optional WhatsApp is enough; SMS adds carrier deliverability headaches.
- **No multi-region active-active.** Single primary region. Recovery time is hours, not minutes — acceptable for this product.
- **No automatic music selection.** Mood is captured as a brief only; music licensing and selection is the editor's responsibility.
- **No editor payment in-app.** Editors are paid offline by Swara Magical. No Stripe Connect, no editor billing schema.
- **No honoree-facing flow.** The app delivers to the organizer. How the organizer reveals the video to the honoree (event playback, share link, etc.) is outside the system.

Each of these is a door we leave closed deliberately. Reopen with care.

---

## 16. Secrets Management Strategy

MVP 1 uses the **standard Next.js tiered model** — no external vault, no extra infrastructure:

| Environment | Storage | Risk profile |
|---|---|---|
| Local development | `.env.development.local` (gitignored) | Never enters version control; lives only on the developer's laptop. Equivalent risk to SSH keys or browser-saved credentials on the same machine. |
| Continuous integration | GitHub Actions Secrets | Encrypted at rest by GitHub; redacted from logs; scoped per workflow. |
| Production (web + workers) | Vercel + Railway/Fly environment variables (encrypted at rest by the host) | Single point of write access (deploy admins); rotated via dashboard. |

**The `src/config/index.ts` module is the single point that reads env vars.** This means a future move to Doppler/Vault/Infisical is a one-file refactor — every other module already reads from the typed `config` object, not from `process.env`.

**Reconsider when:**
- Audit logging of secret access becomes a compliance requirement
- The team grows past ~3 engineers (manual `.env` sharing breaks down)
- A secret rotation event needs to propagate atomically across environments

Until then, the operational overhead of a vault outweighs the marginal security benefit.

---

## 17. Open Questions (Decide Before Build)

1. **MVP 1 package pricing** — Single price not yet set. Stripe SKU created once decided.
2. **Editor SLA terms** — Defined per-assignment or per-editor?

### Resolved

- **MVP 1 ships with one package** — Standard/Classic/Premium tier split deferred to MVP 2. Code must read features from package config, never hardcode by tier name.
- **WhatsApp in MVP 1** — Manual share only via `wa.me` click-to-share links. No WhatsApp Business API, no Meta template approval, no opt-in capture in MVP 1. WhatsApp send capability deferred to MVP 2 behind the same `Channel` interface.
- **Editor compensation** — Paid offline by Swara Magical. Out of scope for the app. No Stripe Connect, no editor billing tables.
- **Editor roster** — Swara Magical maintains an internal pool of editors. Admin assigns from the pool. External-by-email invite remains supported as an edge case but is not the primary flow.
- **Data retention** — 30 days after event date. On day 30, system sends a single reminder notification confirming deletion is imminent. Soft-delete the event and all associated media on day 30 (or day 37 if reminder requires response window — see §11.4). Users (organizer or contributor) may trigger full deletion at any time via dashboard.
- **Music licensing** — Editor's responsibility. App does not provide music. Music mood is captured only as a brief to the editor.
- **Honoree reveal** — Out of scope. Organizer handles delivery to the honoree offline (plays the video at the event, shares the link themselves). The app's responsibility ends at delivery to the organizer.

---

## 18. MVP Roadmap

Graduation season is the launch window. MVP 1 ships first; MVP 2 extends without rewrite.

### MVP 1 — Ship Fast (Single Package)

**In scope:**
- Organizer event creation + Stripe payment (single package)
- Contributor flexible-media upload form (video / voice / photo / text, any combo)
- Full AI pipeline (Whisper transcription, Claude sentiment/quotes/script/storyboard)
- Complexity scoring + routing recommendation
- Admin dashboard: review submissions, approve/reject, view AI artifacts
- AI-routed video output: master HD + Reel + YouTube + auto thumbnail
- Manual editing workflow: brief ZIP, secure email links, editor upload back
- Final video delivery: download link + share page (token-only, no password)
- Email notifications (Resend)
- WhatsApp **manual share** via `wa.me` click-to-share links
- Data retention (30-day default + right to delete)
- Audit log + notification log

**Out of scope for MVP 1 (deferred to MVP 2):**
- Three pricing tiers (Standard / Classic / Premium)
- Password-protected share pages
- WhatsApp API send (reminders, notifications)
- Custom thumbnail upload by admin (auto-extract only in MVP 1)
- Per-tier feature differentiation
- Editor SLA dashboards + reassignment workflows
- Self-hosted Whisper (use API in MVP 1; revisit if costs spike)

### MVP 2 — Extension Points Already Wired

The MVP 1 architecture leaves these seams in place so MVP 2 is additive:

| Feature | MVP 1 seam | MVP 2 work |
|---|---|---|
| Tiered pricing | `Package` entity with `features[]` | Add 2 more package rows + Stripe SKUs + tier-aware UI |
| WhatsApp send | `Channel` interface in NotificationDispatcher | Add `WhatsAppChannel` implementation + opt-in capture |
| Password share | `SharePage.passwordHash` column already in schema | UI for organizer to set password; bcrypt verify on view |
| Custom thumbnail | `FinalVideo` variant table | Admin upload flow + variant insert |
| Editor SLA | `EditorAssignment.assignedAt` + `deliveryDate` | Compute SLA risk; dashboard column; reassignment UI |

**Discipline:** every MVP 1 PR that adds a feature decision (output formats, channels, package features) must read from config or the package's `features[]`. Code that does `if (tier === 'premium')` is rejected in review. The cost of breaking this discipline once is exactly the rewrite we're trying to avoid.
