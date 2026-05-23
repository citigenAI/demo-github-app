import { z } from 'zod';
import { OccasionType } from '@prisma/client';

export const THEMES = ['Classic', 'Cinematic', 'Vibrant', 'Minimal'] as const;
export const MUSIC_MOODS = ['Emotional', 'Upbeat', 'Inspirational', 'Nostalgic'] as const;

export const CreateEventSchema = z
  .object({
    honoreeName: z.string().trim().min(1, 'Please enter the honoree\'s name.').max(120),
    occasionType: z.nativeEnum(OccasionType, { message: 'Please choose an occasion.' }),
    eventDate: z.string().min(1, 'Please pick the event date.'),
    submissionDeadline: z.string().min(1, 'The submission deadline must be in the future.'),
    deliveryDate: z.string().min(1, 'Delivery can\'t be before the submission deadline.'),
    theme: z.enum(THEMES, { message: 'Please choose a theme.' }),
    musicMood: z.enum(MUSIC_MOODS, { message: 'Please choose a music mood.' }),
    expectedContributors: z.coerce
      .number({ message: 'Enter how many people you expect (1–500).' })
      .int()
      .min(1, 'Enter how many people you expect (1–500).')
      .max(500, 'Enter how many people you expect (1–500).'),
    packageId: z.string().min(1, 'Please select a package.'),
  })
  .superRefine((data, ctx) => {
    const now = new Date();
    const deadline = new Date(data.submissionDeadline);
    const delivery = new Date(data.deliveryDate);

    if (isNaN(deadline.getTime()) || deadline <= now) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['submissionDeadline'],
        message: 'The submission deadline must be in the future.',
      });
    }

    if (!isNaN(deadline.getTime()) && !isNaN(delivery.getTime())) {
      if (delivery < new Date(data.submissionDeadline.split('T')[0])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deliveryDate'],
          message: 'Delivery can\'t be before the submission deadline.',
        });
      }
    }
  });

export type CreateEventInput = z.infer<typeof CreateEventSchema>;
