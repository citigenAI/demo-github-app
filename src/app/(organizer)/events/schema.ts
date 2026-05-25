import { z } from 'zod';

export const THEMES = ['Classic', 'Cinematic', 'Vibrant', 'Minimal'] as const;
export const MUSIC_MOODS = ['Emotional', 'Upbeat', 'Inspirational', 'Nostalgic'] as const;
// Mirrors the Prisma OccasionType enum, kept local (not imported from @prisma/client)
// so this schema stays client-safe and can validate in the browser too.
export const OCCASIONS = [
  'GRADUATION',
  'BIRTHDAY',
  'WEDDING',
  'ANNIVERSARY',
  'RETIREMENT',
  'BUSINESS_EVENT',
] as const;

// Plain-language descriptions so organizers know what each curated option means.
export const THEME_DESCRIPTIONS: Record<string, string> = {
  Classic: 'Timeless and elegant, with warm tones and gentle transitions.',
  Cinematic: 'Film-like and dramatic, with rich color and sweeping motion.',
  Vibrant: 'Bright and celebratory, with bold color and energetic pacing.',
  Minimal: 'Clean and understated, letting the moments speak for themselves.',
};

export const MOOD_DESCRIPTIONS: Record<string, string> = {
  Emotional: 'Tender and heartfelt.',
  Upbeat: 'Lively and joyful.',
  Inspirational: 'Uplifting and motivational.',
  Nostalgic: 'Warm and reflective.',
};

// Shared cross-field date rule: now < submissionDeadline <= deliveryDate <= eventDate.
function refineEventDates(
  data: { eventDate: string; submissionDeadline: string; deliveryDate: string },
  ctx: z.RefinementCtx,
) {
  const now = new Date();
  const deadline = new Date(data.submissionDeadline);
  const event = new Date(data.eventDate);

  if (isNaN(event.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['eventDate'], message: 'Please pick a valid event date.' });
  }
  if (isNaN(deadline.getTime()) || deadline <= now) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['submissionDeadline'],
      message: 'The submission deadline must be in the future.',
    });
  }

  // Day-granularity comparisons use YYYY-MM-DD strings (timezone-safe ordering).
  const deadlineDay = data.submissionDeadline.split('T')[0];
  const deliveryDay = data.deliveryDate;
  const eventDay = data.eventDate;

  if (deadlineDay && deliveryDay && deliveryDay < deadlineDay) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryDate'],
      message: 'Delivery can\'t be before the submission deadline.',
    });
  }
  if (deliveryDay && eventDay && deliveryDay > eventDay) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deliveryDate'],
      message: 'Delivery should be on or before the event date.',
    });
  }
  if (deadlineDay && eventDay && deadlineDay > eventDay) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['submissionDeadline'],
      message: 'The submission deadline should be on or before the event date.',
    });
  }
}

export const CreateEventSchema = z
  .object({
    honoreeName: z.string().trim().min(1, 'Please enter the honoree\'s name.').max(120),
    // Organizer's display name, persisted to User.name (per-login profile field).
    organizerName: z.string().trim().min(1, 'Please enter your name.').max(120),
    // Optional event title; blank is auto-filled at creation (see actions.createEvent).
    name: z.string().trim().max(120, 'Event name is too long.').optional(),
    occasionType: z.enum(OCCASIONS, { message: 'Please choose an occasion.' }),
    eventDate: z.string().min(1, 'Please pick the event date.'),
    submissionDeadline: z.string().min(1, 'Please pick a submission deadline.'),
    deliveryDate: z.string().min(1, 'Please pick a delivery date.'),
    theme: z.enum(THEMES, { message: 'Please choose a theme.' }),
    musicMood: z.enum(MUSIC_MOODS, { message: 'Please choose a music mood.' }),
    expectedContributors: z.coerce
      .number({ message: 'Enter how many people you expect (1–500).' })
      .int()
      .min(1, 'Enter how many people you expect (1–500).')
      .max(500, 'Enter how many people you expect (1–500).'),
    packageId: z.string().min(1, 'Please select a package.'),
  })
  .superRefine(refineEventDates);

export type CreateEventInput = z.infer<typeof CreateEventSchema>;

// Edit: only the fields an organizer may change after creation.
// Event name, honoree, occasion, contributors, and package are intentionally not editable.
export const UpdateEventSchema = z
  .object({
    eventDate: z.string().min(1, 'Please pick the event date.'),
    submissionDeadline: z.string().min(1, 'Please pick a submission deadline.'),
    deliveryDate: z.string().min(1, 'Please pick a delivery date.'),
    theme: z.enum(THEMES, { message: 'Please choose a theme.' }),
    musicMood: z.enum(MUSIC_MOODS, { message: 'Please choose a music mood.' }),
  })
  .superRefine(refineEventDates);

export type UpdateEventInput = z.infer<typeof UpdateEventSchema>;
