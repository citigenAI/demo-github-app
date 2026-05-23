import { z } from 'zod';

export const BUSINESS_OCCASIONS = new Set(['BUSINESS_EVENT', 'ANNIVERSARY']);
export const COLLECTING_STATUSES = new Set(['ACTIVE']);

export function isBusiness(occasionType: string): boolean {
  return BUSINESS_OCCASIONS.has(occasionType);
}

export const SubmitContributionSchema = z
  .object({
    slug: z.string().min(1),
    contributorName: z.string().trim().min(1, 'Please add your name.').max(120),
    relationship: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email('Please enter a valid email.').max(254),
    textMessage: z.string().max(5000, 'Keep this under 5000 characters.').optional().default(''),
    funnyMemory: z.string().max(5000, 'Keep this under 5000 characters.').optional().default(''),
    advice: z.string().max(5000, 'Keep this under 5000 characters.').optional().default(''),
    professionalNote: z.string().max(5000, 'Keep this under 5000 characters.').optional().default(''),
    isBusiness: z.boolean(),
    consentGiven: z.literal(true, { errorMap: () => ({ message: 'Consent is required to include your submission.' }) }),
  })
  .superRefine((data, ctx) => {
    const hasContent =
      data.textMessage.trim().length > 0 ||
      data.funnyMemory.trim().length > 0 ||
      data.advice.trim().length > 0 ||
      (data.isBusiness && data.professionalNote.trim().length > 0);

    if (!hasContent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['textMessage'],
        message: 'Add at least one message before submitting.',
      });
    }
  });

export type SubmitContributionInput = z.infer<typeof SubmitContributionSchema>;
