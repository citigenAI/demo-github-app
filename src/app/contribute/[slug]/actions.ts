'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { checkContributorRateLimit } from '@/lib/ratelimit';
import { SubmitContributionSchema, COLLECTING_STATUSES } from './schema';
import type { SubmitContributionInput } from './schema';

type FieldErrors = Record<string, string>;
type SubmitResult = { ok: false; formError?: string; fieldErrors?: FieldErrors };

async function resolveIp(): Promise<string> {
  const hdrs = await headers();
  const forwarded = hdrs.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return hdrs.get('x-real-ip') ?? '127.0.0.1';
}

export async function submitContribution(input: SubmitContributionInput): Promise<SubmitResult> {
  // Validate schema
  const parsed = SubmitContributionSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: FieldErrors = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as string;
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const data = parsed.data;

  // Resolve event by slug
  const event = await db.event.findUnique({
    where: { slug: data.slug },
    select: { id: true, status: true, submissionDeadline: true, honoreeName: true, occasionType: true },
  });
  if (!event) return { ok: false, formError: 'This link isn\'t valid.' };

  // Status gate
  if (!COLLECTING_STATUSES.has(event.status)) {
    return { ok: false, formError: 'This tribute isn\'t collecting submissions right now.' };
  }

  // Deadline gate
  if (new Date() >= event.submissionDeadline) {
    return { ok: false, formError: 'Submissions have closed.' };
  }

  // Rate limit
  const ip = await resolveIp();
  const { allowed } = await checkContributorRateLimit(ip);
  if (!allowed) {
    return { ok: false, formError: 'You\'ve tried a few times — please wait a moment and try again.' };
  }

  // Insert submission
  try {
    await db.submission.create({
      data: {
        eventId: event.id,
        contributorName: data.contributorName.trim(),
        relationship: data.relationship.trim(),
        email: data.email,
        textMessage: data.textMessage.trim() || null,
        funnyMemory: data.funnyMemory.trim() || null,
        advice: data.advice.trim() || null,
        professionalNote: data.isBusiness ? (data.professionalNote.trim() || null) : null,
        consentGiven: true,
        consentAt: new Date(),
        ipAddress: ip,
      },
    });
  } catch (err: unknown) {
    // P2002 = unique constraint violation (duplicate email for this event)
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      logger.info({ eventId: event.id }, 'Duplicate submission email');
      return { ok: false, formError: 'It looks like you\'ve already submitted for this event.' };
    }
    logger.error({ err, eventId: event.id }, 'Unexpected error on submission insert');
    return { ok: false, formError: 'Something went wrong on our end. Please try again.' };
  }

  logger.info({ eventId: event.id }, 'Contribution submitted');
  redirect(`/contribute/${data.slug}/thank-you`);
}
