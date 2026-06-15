import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import {
  buildMediaKey,
  canonicalExtension,
  createPresignedUpload,
  isStorageConfigured,
} from '@/lib/storage';
import { checkContributorRateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { MEDIA_ALLOWLIST, sizeLimitFor } from '@/lib/media';

const PresignBody = z.object({
  fileType: z.enum(['VIDEO', 'VOICE', 'PHOTO']),
  mimeType: z.string().min(1),
  originalName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  draftSubmissionId: z.string().min(8).max(40),
});

async function resolveIp(): Promise<string> {
  const hdrs = await headers();
  const forwarded = hdrs.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return hdrs.get('x-real-ip') ?? '127.0.0.1';
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (!isStorageConfigured()) {
    return NextResponse.json({ error: 'STORAGE_NOT_CONFIGURED' }, { status: 503 });
  }

  const ip = await resolveIp();
  const { allowed } = await checkContributorRateLimit(ip);
  if (!allowed) {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
  }

  const { slug } = await params;

  let body: z.infer<typeof PresignBody>;
  try {
    body = PresignBody.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const allowed_types = MEDIA_ALLOWLIST[body.fileType];
  if (!allowed_types.contentTypes.includes(body.mimeType)) {
    return NextResponse.json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, { status: 415 });
  }
  const ext = canonicalExtension(body.mimeType);
  if (!ext) {
    return NextResponse.json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, { status: 415 });
  }

  const limit = sizeLimitFor(body.fileType);
  if (body.sizeBytes > limit) {
    return NextResponse.json({ error: 'FILE_TOO_LARGE', limitBytes: limit }, { status: 413 });
  }

  const event = await db.event.findUnique({
    where: { slug },
    select: { id: true, status: true, submissionDeadline: true },
  });
  if (!event) {
    return NextResponse.json({ error: 'EVENT_NOT_FOUND' }, { status: 404 });
  }
  if (event.status !== 'ACTIVE') {
    return NextResponse.json({ error: 'EVENT_NOT_ACCEPTING' }, { status: 403 });
  }
  if (new Date() >= event.submissionDeadline) {
    return NextResponse.json({ error: 'DEADLINE_PASSED' }, { status: 403 });
  }

  const mediaId = randomUUID().replace(/-/g, '');
  const storageKey = buildMediaKey({
    eventId: event.id,
    submissionId: body.draftSubmissionId,
    mediaId,
    ext,
  });

  const upload = await createPresignedUpload({
    key: storageKey,
    contentType: body.mimeType,
    expiresInSeconds: 900,
  });

  logger.info(
    { eventId: event.id, mediaId, fileType: body.fileType, sizeBytes: body.sizeBytes },
    'Presigned upload issued',
  );

  return NextResponse.json({
    mediaId,
    storageKey,
    upload,
    expiresInSeconds: 900,
  });
}
