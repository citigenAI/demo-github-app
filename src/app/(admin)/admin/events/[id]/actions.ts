'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { requireAdmin } from '@/lib/admin';
import { isAllowedTransition } from '@/lib/submission-transitions';

const StatusSchema = z.enum(['APPROVED', 'REJECTED', 'FLAGGED']);

type Result =
  | { ok: true; submissionId: string; newStatus: string }
  | { ok: false; error: string };

export async function setSubmissionStatus(input: {
  submissionId: string;
  newStatus: 'APPROVED' | 'REJECTED' | 'FLAGGED';
  adminNote?: string;
}): Promise<Result> {
  const admin = await requireAdmin();

  const parsed = StatusSchema.safeParse(input.newStatus);
  if (!parsed.success) return { ok: false, error: 'INVALID_STATUS' };

  const submission = await db.submission.findUnique({
    where: { id: input.submissionId },
    select: { id: true, eventId: true, status: true, adminNote: true },
  });
  if (!submission) return { ok: false, error: 'NOT_FOUND' };

  if (!isAllowedTransition(submission.status, input.newStatus)) {
    return { ok: false, error: 'INVALID_TRANSITION' };
  }

  const trimmedNote = input.adminNote?.trim();
  const noteForDb = trimmedNote && trimmedNote.length > 0 ? trimmedNote.slice(0, 2000) : undefined;

  try {
    await db.$transaction(async (tx) => {
      await tx.submission.update({
        where: { id: submission.id },
        data: {
          status: input.newStatus,
          ...(noteForDb !== undefined ? { adminNote: noteForDb } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          eventId: submission.eventId,
          actorId: admin.id,
          action: 'submission.status_changed',
          metadata: {
            submissionId: submission.id,
            from: submission.status,
            to: input.newStatus,
            hasNote: Boolean(noteForDb),
          },
        },
      });
    });
    logger.info(
      {
        eventId: submission.eventId,
        submissionId: submission.id,
        from: submission.status,
        to: input.newStatus,
        actor: admin.email,
      },
      'Submission status changed',
    );
  } catch (err) {
    logger.error({ err, submissionId: submission.id }, 'Failed to change submission status');
    return { ok: false, error: 'SERVER_ERROR' };
  }

  revalidatePath(`/admin/events/${submission.eventId}`);
  return { ok: true, submissionId: submission.id, newStatus: input.newStatus };
}
