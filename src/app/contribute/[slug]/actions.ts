'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { checkContributorRateLimit } from '@/lib/ratelimit';
import { SubmitContributionSchema, COLLECTING_STATUSES, type MediaItemRef } from './schema';
import type { SubmitContributionInput } from './schema';
import { headObject, buildMediaKey, canonicalExtension, isStorageConfigured } from '@/lib/storage';
import { isMediaTypeAllowed, sizeLimitFor } from '@/lib/media';

type FieldErrors = Record<string, string>;
type SubmitResult = { ok: false; formError?: string; fieldErrors?: FieldErrors };

async function resolveIp(): Promise<string> {
  const hdrs = await headers();
  const forwarded = hdrs.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return hdrs.get('x-real-ip') ?? '127.0.0.1';
}

async function verifyMediaItem(
  item: MediaItemRef,
  eventId: string,
  draftSubmissionId: string,
): Promise<{ ok: true; contentType: string; contentLength: number } | { ok: false; reason: string }> {
  // Key shape check
  const ext = canonicalExtension(item.mimeType);
  if (!ext) return { ok: false, reason: 'unknown_mime' };
  const expectedKey = buildMediaKey({
    eventId,
    submissionId: draftSubmissionId,
    mediaId: item.mediaId,
    ext,
  });
  if (item.storageKey !== expectedKey) return { ok: false, reason: 'key_mismatch' };

  // MIME allowlist re-check
  if (!isMediaTypeAllowed(item.type, item.mimeType)) {
    return { ok: false, reason: 'type_mismatch' };
  }

  // Existence + storage-reported metadata
  const head = await headObject(item.storageKey);
  if (!head.exists) return { ok: false, reason: 'not_found' };

  const limit = sizeLimitFor(item.type);
  if (head.contentLength !== undefined && head.contentLength > limit) {
    return { ok: false, reason: 'too_large' };
  }
  if (
    head.contentType &&
    !isMediaTypeAllowed(item.type, head.contentType)
  ) {
    return { ok: false, reason: 'storage_type_mismatch' };
  }

  return {
    ok: true,
    contentType: head.contentType ?? item.mimeType,
    contentLength: head.contentLength ?? item.sizeBytes,
  };
}

export async function submitContribution(input: SubmitContributionInput): Promise<SubmitResult> {
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

  const event = await db.event.findUnique({
    where: { slug: data.slug },
    select: { id: true, status: true, submissionDeadline: true, honoreeName: true, occasionType: true },
  });
  if (!event) return { ok: false, formError: "This link isn't valid." };

  if (!COLLECTING_STATUSES.has(event.status)) {
    return { ok: false, formError: "This tribute isn't collecting submissions right now." };
  }

  if (new Date() >= event.submissionDeadline) {
    return { ok: false, formError: 'Submissions have closed.' };
  }

  const ip = await resolveIp();
  const { allowed } = await checkContributorRateLimit(ip);
  if (!allowed) {
    return { ok: false, formError: "You've tried a few times — please wait a moment and try again." };
  }

  // If the submission references media but storage isn't configured, fail clearly
  // rather than crashing the action. Text-only submissions still go through.
  if (data.mediaItems.length > 0 && !isStorageConfigured()) {
    return {
      ok: false,
      formError:
        'Media uploads are temporarily unavailable. Please remove any attached files and try again.',
    };
  }

  // Verify-before-save: every media item must exist in storage with allowed type/size.
  const verifiedMedia: Array<{
    mediaId: string;
    storageKey: string;
    type: 'VIDEO' | 'VOICE' | 'PHOTO';
    originalName: string;
    contentLength: number;
    contentType: string;
  }> = [];

  for (const item of data.mediaItems) {
    const result = await verifyMediaItem(item, event.id, data.draftSubmissionId);
    if (!result.ok) {
      logger.warn(
        { eventId: event.id, mediaId: item.mediaId, reason: result.reason },
        'Media verify-before-save rejected',
      );
      return {
        ok: false,
        formError:
          result.reason === 'not_found'
            ? "One of your files didn't finish uploading. Please try again."
            : 'One of your files could not be accepted. Please remove it and try again.',
      };
    }
    verifiedMedia.push({
      mediaId: item.mediaId,
      storageKey: item.storageKey,
      type: item.type,
      originalName: item.originalName,
      contentType: result.contentType,
      contentLength: result.contentLength,
    });
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.submission.create({
        data: {
          id: data.draftSubmissionId,
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

      if (verifiedMedia.length > 0) {
        await tx.mediaItem.createMany({
          data: verifiedMedia.map((m) => ({
            id: m.mediaId,
            submissionId: data.draftSubmissionId,
            type: m.type,
            storagePath: m.storageKey,
            originalName: m.originalName,
            sizeBytes: m.contentLength,
            mimeType: m.contentType,
          })),
        });
      }
    });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      logger.info({ eventId: event.id }, 'Duplicate submission email');
      return { ok: false, formError: "It looks like you've already submitted for this event." };
    }
    logger.error({ err, eventId: event.id }, 'Unexpected error on submission insert');
    return { ok: false, formError: 'Something went wrong on our end. Please try again.' };
  }

  logger.info(
    { eventId: event.id, mediaCount: verifiedMedia.length },
    'Contribution submitted',
  );
  redirect(`/contribute/${data.slug}/thank-you`);
}
