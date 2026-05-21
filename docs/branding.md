# Branding: Swara Magical Memories

Brand reference for the Swara Magical Memories product. The parent brand is **Swara Media** (swara.media); this product lives under that umbrella and must respect parent-brand identity. Where the parent brand is explicit, we follow it. Where it is silent, we are creative — and document our choices here so they remain consistent across the app, marketing, and editor briefs.

> **Source note:** The parent-brand pieces in §1 were sourced from swara.media. Everything else is product-side creative direction for Swara Magical Memories that respects the parent. If a parent-brand asset (logo, color palette, typography spec) is later shared, update §1 and re-derive §3–§6 from it.

---

## 1. Parent Brand — From swara.media

These elements come from the parent site and are **fixed**. They must appear correctly in any product material.

| Element | Value |
|---|---|
| Brand name | **Swara Media** |
| Tagline | *Your One-Stop Shop for Digital Services, Entertainment, and Cultural Exchange* |
| Pillars | Digital Services · Entertainment · Cultural Exchange |
| Domain | swara.media |

**Name meaning:** *Swara* (स्वर) is the Sanskrit word for "musical note" — the seven notes of Indian classical music (Sa, Re, Ga, Ma, Pa, Dha, Ni). The name signals harmony, expression, and cultural rootedness. This meaning should inform creative choices but is not always required to be surfaced literally.

---

## 2. Product Brand — Swara Magical Memories

A product under the Swara Media umbrella that creates AI-assisted tribute videos for life milestones: graduations, weddings, anniversaries, birthdays, retirements, and business events.

| Element | Value |
|---|---|
| Product name | **Swara Magical Memories** |
| Short name | Magical Memories |
| Product tagline | *Every wish, every memory, one magical moment.* |
| Lockup with parent | `Swara Magical Memories — by Swara Media` (used on first mention in any new context) |
| Domain (TBD) | swaramagical.com (or subdomain `magical.swara.media`) |

The product sits inside the **Entertainment** and **Cultural Exchange** pillars of the parent brand — it celebrates milestones and gathers community voices into one keepsake.

---

## 3. Voice & Tone

Inherited posture: **approachable, inclusive, warm.** The parent's "One-Stop Shop" phrasing signals accessibility over corporate formality; the product extends this.

| Voice attribute | What it means | What it isn't |
|---|---|---|
| **Warm** | We're invited into people's most personal moments. Write like a thoughtful host. | Saccharine, performatively emotional |
| **Confident** | We know what makes a great tribute. The product makes promises and keeps them. | Salesy, hype-driven |
| **Clear** | Plain words. Short sentences. Anyone can use the product without learning new vocabulary. | Corporate jargon, AI-buzzword bingo |
| **Quietly magical** | The product is called "Magical" — the experience should feel effortless, never the copy. | Heavy use of "magic," "transform," "unleash" |
| **Culturally rooted** | "Swara" is a meaningful name. We respect heritage without leaning on it as a gimmick. | Stereotyping, exoticizing |

**Examples:**

| Context | ❌ Off-brand | ✓ On-brand |
|---|---|---|
| Empty contributor list | "No one has unleashed their magic yet!" | "Invitations sent. Submissions will appear here as friends respond." |
| Deadline reminder | "🚨 URGENT: Time is running out!!!" | "Submissions close tomorrow at 6 PM. We'll send one more reminder in the morning." |
| AI routing recommendation | "Our advanced AI has determined..." | "This event looks straightforward — AI can handle the editing." |
| Delivery email | "Behold your magical creation!" | "Riya's graduation tribute is ready. Watch it, share it, save it." |

---

## 4. Color Palette (Creative — Awaiting Parent Confirmation)

The parent site did not publish hex codes in accessible form. This palette is a proposal grounded in the Swara name's heritage (warm Indian classical music tradition) and the product's emotional register (memory, celebration, tribute). **Subject to revision once the parent palette is shared.**

### Primary

| Token | Hex | Use |
|---|---|---|
| `--brand-deep-saffron` | `#D97706` | Primary accent; CTA backgrounds; brand marks |
| `--brand-ink` | `#1A1530` | Headings, primary text, dark surfaces |
| `--brand-ivory` | `#FAF7F0` | Page background; warmth without being yellow |

### Secondary

| Token | Hex | Use |
|---|---|---|
| `--brand-rose-gold` | `#C97B63` | Secondary buttons; warm highlights |
| `--brand-twilight` | `#3B3169` | Dark mode primary; depth in gradients |
| `--brand-gold-accent` | `#E8C547` | Sparing use — celebrations, completion states |

### Functional

| Token | Hex | Use |
|---|---|---|
| `--success` | `#15803D` | Successful submission, approval |
| `--warning` | `#D97706` | Deadline near, manual review needed |
| `--error` | `#B91C1C` | Validation errors |
| `--neutral-50…900` | Tailwind stone scale | Borders, dividers, body neutrals |

**Gradient (signature):** `linear-gradient(135deg, #D97706 0%, #C97B63 50%, #3B3169 100%)` — used sparingly on hero, share page banner, and final-video delivery moment. Not for everyday UI.

**Contrast:** All text/background pairs must meet WCAG AA. The deep saffron + ink combination meets this; the ivory + ink combination exceeds AAA.

---

## 5. Typography (Creative — Awaiting Parent Confirmation)

If the parent brand later specifies a typeface, replace these. The proposal favors free Google Fonts with strong multilingual support (Devanagari + Latin) given the cultural roots of the name.

| Role | Font | Why |
|---|---|---|
| Display / Headings | **Fraunces** | Warm, slightly literary serif; carries celebration tone without being formal |
| Body | **Inter** | Best-in-class legibility for UI; broad weight range |
| Accent / Marks | **Mukta** (Devanagari + Latin) | Used when the word "Swara" appears in its native script alongside Latin |
| Monospace | **JetBrains Mono** | Code, IDs, technical surfaces |

**Type scale (modular, base 16px):**
```
xs   12px / 1rem
sm   14px / 1.25rem
base 16px / 1.5rem
lg   18px / 1.75rem
xl   20px / 2rem
2xl  24px / 2.25rem
3xl  30px / 2.5rem
4xl  36px / 2.75rem
5xl  48px / 3.5rem   — hero only
```

---

## 6. Logo & Marks (Creative — Awaiting Parent Asset)

Until the parent brand shares a logo file, the product uses a **wordmark-only treatment**:

```
Swara
Magical Memories
```

- "Swara" in Fraunces, semibold, `--brand-deep-saffron`.
- "Magical Memories" below in Fraunces, light weight, `--brand-ink`.
- Spacing: "Magical Memories" sits at 60% of "Swara" cap-height, baseline-aligned to "Swara" baseline + 0.4em.

**Co-brand lockup with parent:**

```
Swara Magical Memories
        by Swara Media
```

The "by Swara Media" line is set in Inter, tracked +50, 60% opacity of `--brand-ink`. Used in: footer of all transactional emails, About page, share page, organizer dashboard header on first login.

**Favicon / app icon:** until a parent mark is available, use a stylized **"स"** (Devanagari letter "sa," the first swara) in `--brand-deep-saffron` on `--brand-ivory`. Rounded square, 24px corner radius at 512px export.

---

## 7. Imagery Direction

### What we use

- **Real people in candid moments.** Hugging, laughing, listening, raising a glass, holding a phone showing a video. Diversity of age, culture, background, ability.
- **Hand-held informality.** The product is built on phone-recorded video — imagery should feel close, not staged.
- **Warm light.** Golden hour, soft window light, candlelight. Reinforces the saffron/ivory palette without feeling kitsch.
- **Detail shots that imply story:** a graduation cap on a table, a phone screen with a video playing, a hand pressing record.

### What we avoid

- Stock photography of business meetings, generic "happy diverse team" stock, abstract tech imagery (circuits, glowing networks, robots).
- Heavy color grading, Instagram filters, vignettes.
- Imagery that puts the technology in the foreground — the product is invisible, the people are the story.

---

## 8. Iconography

- **Style:** outline icons, 1.5px stroke, rounded caps and joins. Lucide icon set as the working library.
- **Filled variants** only for selected/active states, not as the default.
- **Color:** inherit text color by default; brand colors only when the icon is the focal point of a card or CTA.
- **Size scale:** 16, 20, 24, 32, 48px. Default inline icon is 20px aligned with body text.

---

## 9. Motion

- **Quietly purposeful.** Transitions confirm an action; they never demand attention.
- **Durations:** micro (100ms) for hover, standard (200ms) for state changes, deliberate (400ms) only for reveals (final video, completed event).
- **Easing:** `cubic-bezier(0.4, 0, 0.2, 1)` (Material standard) for almost everything.
- **One signature moment:** when the final video is ready and presented to the organizer, a gentle fade-up plus a subtle gold sparkle (≤700ms, never on repeat). This is the only place we earn the "Magical" in the product name.

---

## 10. Editorial & Content Rules

- **Honoree's name is sacred.** Spell it exactly as the organizer enters it. Never auto-capitalize, never auto-correct, never abbreviate.
- **Occasion-aware language.** "Graduation tribute" not "your video." "Anniversary memory" not "your project." The interface knows what event this is.
- **No exclamation marks in transactional copy.** The system is calm and competent.
- **Em dashes are fine.** Title case for headings, sentence case for buttons and labels.
- **Dates in long form** when celebratory ("Saturday, May 17, 2026"); short form when functional ("Submissions close May 17, 6:00 PM").

---

## 11. Examples in Context

### Transactional email — submission received

> Hi Priya,
>
> Your message for **Arjun's graduation** is in. Thank you for taking the time — these are the moments that make a tribute feel like home.
>
> If you need to update anything before submissions close on **May 14**, use the link below.
>
> — Swara Magical Memories
> *by Swara Media*

### Delivery email — video ready

> **Riya's graduation tribute is ready.**
>
> 14 people. 47 photos. 9 video wishes. One keepsake.
>
> [Watch] [Download]
>
> Save it somewhere safe — the link stays live for 30 days.
>
> — Swara Magical Memories

### Empty state — admin dashboard with no events yet

> No events yet.
> When organizers create their first tribute, it'll appear here.

---

## 12. Open Items

Resolve when the parent brand shares its formal guide:

- [ ] Confirm or replace proposed color palette (§4) with parent's official hex codes.
- [ ] Confirm or replace proposed typefaces (§5).
- [ ] Receive parent logo files (SVG, lockup variants, monochrome, on-dark, on-light).
- [ ] Confirm co-brand lockup format (§6) — "by Swara Media" wording and placement.
- [ ] Receive parent brand voice guide if one exists; reconcile with §3.
- [ ] Confirm domain decision: `swaramagical.com` standalone vs `magical.swara.media` subdomain.
