# Requirements: Swara Magical Memories

AI-driven web app for creating surprise tribute videos for special events with minimal manual effort.

---

## 1. Overview

**Product:** Swara Magical Memories  
**Purpose:** Collect any mix of videos, photos, voice messages, and text from contributors, then produce a polished tribute video package. AI handles straightforward events automatically. For complex events (e.g., business anniversaries with mixed media requiring creative editing), a manual workflow is triggered: Swara Admin recruits a video editor, editing happens offline, and the final video is uploaded back to the portal.  
**Key constraint:** Contributors should never be forced to submit a specific media type — any combination is valid. The system routes jobs to AI or human editors based on complexity.

---

## 2. User Roles

| Role | Responsibilities |
|---|---|
| **Organizer** | Creates event, configures settings, selects package, pays |
| **Contributor** | Receives invite link, uploads any mix of media, gives consent |
| **Swara Admin** | Reviews submissions, approves/rejects, triggers AI or manual workflow, recruits editors, uploads final video |
| **Video Editor** | Receives offline editing brief and asset package, edits video externally, uploads final video back to portal |

---

## 3. Occasion Types

- Graduation
- Birthday
- Wedding
- Anniversary
- Retirement
- Business Event

---

## 4. Packages

### MVP 1 — Single Package

Ship one package only to compress scope for graduation season. Naming and pricing finalized at launch.

**Default MVP 1 package includes:**
- Full HD tribute video (1920×1080 MP4)
- Instagram Reel version (1080×1920 MP4)
- YouTube version (1920×1080 MP4)
- Auto-generated thumbnail
- Download link
- Private share page (token URL; no password protection in MVP 1)

### MVP 2 — Three Tiers (Standard / Classic / Premium)

Tier structure ships in MVP 2. Per-tier feature breakdown TBD at MVP 2 planning. Likely differentiators: number of output variants, custom thumbnail, password-protected share page, delivery turnaround, included revisions.

### Extensibility Requirement

Even with one package in MVP 1, the system **must not hardcode features**. Packages are a first-class entity with a `features` set; feature checks throughout the app read from the package config, not from constants. Adding tiers in MVP 2 is a data migration plus pricing setup — no business-logic rewrite.

```
Package
  id, name, price_cents, features[], delivery_sla_days, included_revisions
```

`features[]` is a string set like `["video_master", "reel", "youtube", "custom_thumbnail", "password_share"]`. Code checks `package.has("custom_thumbnail")` rather than `package.tier == "premium"`.

---

## 5. Core Workflows

### 5.1 Organizer — Event Creation

**Input fields:**
- Honoree name (the graduate/birthday person/etc.)
- Occasion type (dropdown)
- Event date
- Submission deadline (date + time)
- Delivery date
- Theme preference (e.g., Classic, Cinematic, Vibrant, Minimal)
- Music mood (e.g., Emotional, Upbeat, Inspirational, Nostalgic)
- Expected number of contributors
- Package selection
- Payment (processed at submission)

**On successful payment, system generates:**
- Unique event URL (e.g., `/event/{slug}`)
- Contributor upload form at that URL
- QR code linking to contributor form
- Pre-written WhatsApp share message with event link
- Pre-written email invitation message with event link

---

### 5.2 Contributor — Upload Form

Accessible via unique event URL. No account required.

**Fields:**
- Full name
- Relationship to honoree (e.g., Parent, Friend, Colleague, Team Member, Client)
- Media uploads — all optional, any combination accepted:
  - Video wish (MP4/MOV) — one or more clips
  - Voice message (MP3/M4A) — one or more recordings
  - Photos (JPG/PNG) — multiple allowed, any quantity
  - Text message (free text)
- Additional text fields (all optional):
  - Funny memory
  - Advice or blessing
  - Professional note (shown for business occasion types: Business Event, Anniversary)
- Consent checkbox: "I consent to my submission being used in the tribute video"

**Flexibility rules:**
- At least one media item OR one text field must be filled — the form will not submit completely empty.
- No media type is required. A contributor can submit only photos, only a voice message, only text, or any mix.
- For business events the form labels adapt (e.g., "Relationship to honoree" becomes "Role / Connection", "Funny memory" becomes "Highlight / Achievement").

**Constraints:**
- Consent checkbox is mandatory — form cannot submit without it.
- Contributors can submit only once per event (enforced by email or device fingerprint).
- Deadline enforcement: form closes at submission deadline.

---

### 5.3 Automation Pipeline (triggered per upload)

All steps run automatically after a contributor submits. Steps apply only to the media types present in each submission (e.g., transcription is skipped if no audio/video was uploaded).

| Step | Action |
|---|---|
| File storage | Store all uploaded files in a per-event folder (e.g., `/events/{event_id}/{contributor_id}/`) |
| Metadata | Save contributor details, file paths, media types present, timestamps to database |
| Transcription | Transcribe audio and video files (speech-to-text); skip if none uploaded |
| Sentiment analysis | Analyze transcribed text and written messages for emotional tone |
| Quote extraction | Extract the most impactful quotes from transcriptions and text |
| Quality detection | Flag poor quality files (blurry video, low audio, corrupt files); log per file |
| Auto-tagging | Tag contributors by relationship type and media mix |
| Complexity scoring | Score the event's editing complexity (see §5.7) after each new submission |
| Storyboard draft | Generate a sequence/order suggestion across all media types |
| Narration script | Generate narration script using all text, transcriptions, and quotes |
| Intro & outro text | Generate opening and closing title card text |
| Captions/subtitles | Generate subtitle files (.srt) for all video/voice segments |

---

### 5.4 Reminder Automation

| Trigger | Action |
|---|---|
| 48 hours before deadline | Send reminder to contributors who haven't submitted |
| 24 hours before deadline | Second reminder to non-submitters |
| Deadline reached | Notify organizer with final submission count |
| Deadline reached | Alert Swara Admin team that event is ready for review |
| Organizer milestones | Notify organizer at 25%, 50%, 75% of expected contributors submitted |

**MVP 1 channel: Email only.**

WhatsApp in MVP 1 is **manual share only** — the system generates a pre-formatted `wa.me/?text=...` link the organizer can click to open WhatsApp with the message pre-filled. No WhatsApp API integration, no Meta template approval, no opt-in flow required. This covers the "share the event invite" use case without the overhead of being a registered WhatsApp Business sender.

**MVP 2:** WhatsApp Business API integration for outbound reminders (requires opt-in capture at submission and Meta template approval).

**Channel abstraction (MVP 1 build requirement):** the notification dispatcher must route through a `Channel` interface with `Email` as the only implementation in MVP 1. Adding `WhatsApp` in MVP 2 is a new implementation, not a rewrite.

---

### 5.5 Admin Dashboard

Accessible only to Swara Admin role (authenticated).

**Event list view:**
- All events with status (Active, Deadline Passed, In Review, Exported)
- Submission count vs. expected count
- Delivery date countdown

**Per-event detail view:**

| Section | Content |
|---|---|
| Contributors | Name, relationship, submission date, files submitted |
| Submission status | Per-contributor: Pending / Submitted / Flagged / Approved / Rejected |
| AI-generated script | Full narration script with editable sections |
| AI-generated storyboard | Sequence of clips/photos with suggested transitions and captions |
| Asset quality scores | Per-file quality rating; flagged files highlighted |
| Approval actions | Approve or reject individual submissions with optional notes |
| Export | Generate organized video package for video editor handoff |

**Export package contents:**
- Approved media files organized by contributor/type
- AI narration script (PDF or DOCX)
- AI storyboard (PDF or structured JSON)
- Subtitle files
- Metadata CSV (contributor names, relationships, consent records)

**Routing & workflow controls (added to Admin dashboard):**
- **Routing Approval Card** — appears when event reaches submission deadline. Shows analyzer recommendation (AI or Manual), confidence, signals supporting and opposing it. Admin clicks `Approve AI Routing` or `Switch to Manual` (see §5.6).
- Live analyzer preview during collection window — admin can see the recommendation trending as submissions arrive, without acting on it.
- "Trigger Manual Workflow" button — also available as a manual override at any time, not just at the deadline gate.
- Editor assignment panel (see §5.7)
- Final video upload panel — accepts the completed video from editor and attaches it to the event
- Status field: `Active` / `Awaiting Routing Approval` / `AI Routed` / `Manual Routed` / `Editor Assigned` / `Editing In Progress` / `Final Video Uploaded` / `Delivered`

---

### 5.6 Routing Analyzer & Admin Approval Gate

A lightweight, rule-based analyzer recommends whether each event should be **AI-routed** (fast, scalable) or **Manual-routed** (human editor for complex jobs). The admin must approve the recommendation before either path executes — the system never auto-routes without human sign-off.

**Why an approval gate, not full automation:** AI routing fast-tracks simple events and lets the business scale. Manual routing handles creative complexity. Putting an admin in the loop at exactly one moment (post-deadline) costs minimal time per event but prevents the expensive failure mode where AI produces a poor video for a complex event and the organizer is unhappy.

#### Analyzer Behavior

**Runs:**
- After each contributor submission (live preview for admin during collection window).
- Final run at submission deadline. At that moment, event status moves to `AWAITING_ROUTING_APPROVAL` and admin is notified.

**Implementation (MVP 1):**
- Pure deterministic rules. No LLM call. Sub-second execution.
- Inputs: counts and metadata only (media mix, orientations, quality flags, occasion type, contributor count). No model inference required.
- Returns: `{recommendation: AI | MANUAL, confidence: 0–1, signals: [{name, value, impact, message}]}`.

**Signals (MVP 1 ruleset):**

| Signal | Triggers when | Impact |
|---|---|---|
| Consistent media type | ≥80% of contributors uploaded the same media type | Pushes toward AI |
| All-video submissions | Every contributor uploaded at least one video | Pushes toward AI |
| Consistent orientation | All videos same orientation (landscape OR portrait) | Pushes toward AI |
| Low contributor count | ≤15 contributors | Pushes toward AI |
| Clean quality | <10% of files have quality flags | Pushes toward AI |
| Mixed media event | Submissions include 3+ media types across contributors | Pushes toward Manual |
| Mixed orientations | Both portrait and landscape videos in same event | Pushes toward Manual |
| Business event | `occasion_type = BUSINESS_EVENT` | Pushes toward Manual |
| High quality flag rate | ≥25% of files flagged | Pushes toward Manual |
| High contributor count | >40 contributors | Pushes toward Manual |

A score above the AI threshold → recommendation: `AI`. Otherwise → `MANUAL`. Exact thresholds tuned in production based on admin override rates.

#### Admin Approval Gate

When event hits `AWAITING_ROUTING_APPROVAL`, the admin dashboard shows a clear approval card:

```
┌─────────────────────────────────────────────────────┐
│ Event: Riya's Graduation                            │
│ Status: Awaiting Routing Approval                   │
│                                                     │
│ ► Recommended: AI Routing  (confidence: 87%)        │
│                                                     │
│ Why AI fits this event:                             │
│   ✓ 12 of 14 contributors uploaded video clips      │
│   ✓ All videos in landscape orientation             │
│   ✓ No quality flags raised                         │
│   ✓ Small contributor count (14)                    │
│                                                     │
│ Why a human editor might be better:                 │
│   • 2 contributors uploaded photos only             │
│                                                     │
│ [ Approve AI Routing ]   [ Switch to Manual ]       │
│                                                     │
│ Decision will be recorded with your name + time.    │
└─────────────────────────────────────────────────────┘
```

**Both options show their pros AND cons** — admin sees the strongest counter-argument to the recommendation, not just supporting reasons. This avoids confirmation bias.

**On approval:**
- `Approve AI Routing` → status: `AI_ROUTED`. The AI generation pipeline (storyboard → narration → video assembly) fires.
- `Switch to Manual` → status: `MANUAL_ROUTED`. Manual workflow trigger appears (§5.7).

**Audit:** Every routing decision (recommendation + admin choice + reasons shown) is written to the audit log.

#### Why this scales the business

| Event type | Likely path | Admin time per event |
|---|---|---|
| 14 friends sending video graduation wishes | AI-routed (approve in ~30 sec) | minimal |
| Business 25th anniversary with mixed media | Manual-routed → assign editor | 2–3 min routing + assignment |
| Small birthday with photos only | AI-routed | ~30 sec |
| Wedding montage with 60 contributors, mixed orientations | Manual-routed | 2–3 min |

The analyzer surfaces complexity early and routes Swara Admin's attention only where it matters.

---

### 5.7 Manual Editing Workflow

Triggered by Swara Admin when the event is too complex for AI or when Admin chooses manual quality control.

**Steps:**

1. **Admin triggers manual workflow** from the event dashboard.
2. **System prepares editor brief:**
   - All approved media files (organized by contributor and type)
   - AI-generated storyboard as a starting reference
   - AI-generated narration script
   - Subtitle files
   - Event metadata (occasion type, theme, music mood, delivery date)
   - Metadata CSV
3. **Admin assigns a video editor:**
   - Select from Swara Magical's internal editor pool (primary flow).
   - External-by-email assignment supported as fallback for overflow / specialty work.
   - Editor receives a secure, time-limited download link to the brief package.
   - Editor receives deadline and delivery instructions.
   - Editor compensation is handled offline by Swara Magical — no in-app billing.
4. **Editor works offline** — no portal dependency during editing.
5. **Editor uploads final video** via a secure upload URL provided in their assignment email.
   - Upload form accepts MP4 only.
   - Editor can add a note/handover message.
6. **Admin reviews uploaded video** in the portal.
   - Approve: video is attached to event and delivery workflow proceeds.
   - Request revision: Admin sends notes back to editor; editor re-uploads.
7. **Delivery proceeds** as normal (download link, private share page sent to organizer).

**Editor access:**
- Editors do not have a portal login.
- All editor interaction happens via secure email links (download brief, upload final video).
- Upload links expire after delivery date + 7 days.

---

### 5.8 Video Output

Applies whether the final video was AI-generated or produced by a human editor and uploaded back to the portal.

| Output | Format | Notes |
|---|---|---|
| Full HD tribute video | 1920×1080, MP4 | Primary deliverable |
| Instagram Reel version | 1080×1920, MP4, ≤90s | Vertical crop |
| YouTube version | 1920×1080, MP4 | Optimized for YouTube upload |
| Thumbnail | JPG, 1280×720 | For YouTube and share page |
| Download link | Secure time-limited URL | Sent to organizer |
| Private share page | `/share/{token}` | Password-optional viewing page |

---

## 6. Data Model (Logical)

### Event
```
event_id, organizer_id, honoree_name, occasion_type, event_date,
submission_deadline, delivery_date, theme, music_mood,
expected_contributors, package_id, payment_status, status, slug, created_at
```

### Contributor Submission
```
submission_id, event_id, contributor_name, relationship, email,
media_items[],          -- array of {type: video|voice|photo, path, quality_score}
text_message, funny_memory, advice, professional_note,
consent_given, submitted_at, overall_quality_score, status
```

### AI Artifacts (per event)
```
artifact_id, event_id, narration_script, storyboard_json,
intro_text, outro_text, extracted_quotes[], sentiment_summary,
complexity_score, routing_decision (ai|manual),
generated_at, admin_approved
```

### Editor Assignment
```
assignment_id, event_id, editor_name, editor_email,
brief_package_url, brief_expires_at,
upload_token, upload_expires_at,
status (assigned|in_progress|uploaded|approved|revision_requested),
editor_note, assigned_at, final_video_path, uploaded_at
```

### Notification Log
```
log_id, event_id, recipient_type (organizer|contributor|admin|editor),
channel (email|whatsapp), trigger, sent_at, status
```

---

## 7. AI Integration Points

| Feature | AI Capability Required |
|---|---|
| Transcription | Speech-to-text (e.g., Whisper or equivalent) |
| Sentiment analysis | NLP classification (positive/emotional/humorous) |
| Quote extraction | Summarization + ranking |
| Quality detection | Video/audio quality scoring (blur, noise, volume) |
| Storyboard generation | Sequence ordering based on relationship + sentiment |
| Narration script | LLM text generation using all submission content |
| Intro/outro text | LLM text generation from event metadata |
| Captions/subtitles | Aligned speech-to-text with timestamps |

---

## 8. Non-Functional Requirements

| Area | Requirement |
|---|---|
| File storage | Cloud storage (S3-compatible); files isolated per event |
| Access control | Contributor form: public (no login). Admin: authenticated only. Organizer: authenticated. |
| Consent records | Must be stored and exportable for compliance |
| Deadline enforcement | Contributor form hard-closes at deadline — no late submissions |
| Payment | Payment gateway integration required before event activation |
| File size limits | Define max per file type before build (video, audio, image) |
| Notifications | Email is required; WhatsApp via API is optional but preferred |
| Data retention | Default: keep all event data for 30 days after event date, then send reminder, then hard-delete 7 days later. Organizer can extend up to 2 times (30 days each). |
| Right to delete | Organizer can delete entire event data at any time from dashboard. Contributors can delete their own submission via self-service link in confirmation email. |
| Share page security | Private share page must support optional password protection |

---

## 9. Out of Scope (for v1)

- In-browser video rendering or editing tools (video assembly happens offline by editor or via AI pipeline)
- Editor portal login — editors interact only via secure email links
- **Editor payment / billing** — editors are paid offline by Swara Magical; no in-app compensation flow
- **Music licensing** — editor handles music selection and licensing; app captures music mood only as a brief
- **Honoree-facing flow** — organizer handles reveal to honoree offline (event playback, share link); app workflow ends at delivery to organizer
- Contributor accounts or returning contributor history
- Multi-language UI
- Mobile app (web-responsive only)
- Real-time collaboration on script editing between Admin and Organizer
