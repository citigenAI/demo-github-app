'use server';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { generateSlug } from '@/lib/slug';
import { autoEventName } from '@/lib/share';
import { CreateEventSchema, UpdateEventSchema } from './schema';
import type { CreateEventInput, UpdateEventInput } from './schema';
import type { OccasionType } from '@prisma/client';

const MAX_SLUG_RETRIES = 5;

type ActionError = { error: string; fields?: Record<string, string[]> };
type CreateEventResult = { id: string; slug: string } | ActionError;

async function requireOrganizer() {
  const session = await auth();
  if (!session?.user?.id) return null;
  // @ts-expect-error role is added via Prisma adapter
  if (session.user.role !== 'ORGANIZER') return null;
  return session.user as { id: string; email: string };
}

export async function createEvent(input: CreateEventInput): Promise<CreateEventResult> {
  const user = await requireOrganizer();
  if (!user) return { error: 'Unauthorized' };

  const parsed = CreateEventSchema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as string;
      fields[key] = [...(fields[key] ?? []), issue.message];
    }
    return { error: 'Validation failed', fields };
  }

  const data = parsed.data;

  // Verify the package exists and is active
  const pkg = await db.package.findFirst({
    where: { id: data.packageId, active: true },
    select: { id: true },
  });
  if (!pkg) return { error: 'Validation failed', fields: { packageId: ['Please select a package.'] } };

  // Generate unique slug with retry on collision
  let slug = '';
  for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
    const candidate = generateSlug(data.honoreeName, data.occasionType);
    const exists = await db.event.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!exists) {
      slug = candidate;
      break;
    }
    if (attempt > 0) {
      logger.warn({ attempt, organizerId: user.id }, 'Slug collision retry');
    }
  }
  if (!slug) return { error: 'Something went wrong, please try again.' };

  // Save the organizer's display name to their profile (per-login).
  await db.user.update({ where: { id: user.id }, data: { name: data.organizerName } });

  const event = await db.event.create({
    data: {
      slug,
      organizerId: user.id,
      honoreeName: data.honoreeName,
      // Auto-fill the name when blank so it's a single stored source for titles + invites.
      name: data.name?.trim() || autoEventName(data.honoreeName, data.occasionType),
      occasionType: data.occasionType as OccasionType,
      eventDate: new Date(data.eventDate),
      submissionDeadline: new Date(data.submissionDeadline),
      deliveryDate: new Date(data.deliveryDate),
      theme: data.theme,
      musicMood: data.musicMood,
      expectedContributors: data.expectedContributors,
      packageId: data.packageId,
    },
    select: { id: true, slug: true },
  });

  await db.auditLog.create({
    data: {
      eventId: event.id,
      actorId: user.id,
      action: 'event.created',
      metadata: { occasionType: data.occasionType, packageId: data.packageId, slug },
    },
  });

  logger.info({ eventId: event.id, organizerId: user.id }, 'Event created');
  return { id: event.id, slug: event.slug };
}

export async function listMyEvents() {
  const user = await requireOrganizer();
  if (!user) return { error: 'Unauthorized' as const };

  const events = await db.event.findMany({
    where: { organizerId: user.id },
    select: {
      id: true,
      slug: true,
      honoreeName: true,
      name: true,
      occasionType: true,
      status: true,
      eventDate: true,
      submissionDeadline: true,
      deliveryDate: true,
      expectedContributors: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return { events };
}

export async function getEvent(id: string) {
  const user = await requireOrganizer();
  if (!user) return { error: 'Unauthorized' as const };

  const event = await db.event.findUnique({
    where: { id },
    include: { package: true, organizer: { select: { name: true } } },
  });

  if (!event || event.organizerId !== user.id) return { error: 'Not found' as const };

  return { event };
}

export async function updateEvent(
  id: string,
  input: UpdateEventInput,
): Promise<{ id: string } | ActionError> {
  const user = await requireOrganizer();
  if (!user) return { error: 'Unauthorized' };

  const existing = await db.event.findUnique({ where: { id }, select: { organizerId: true } });
  if (!existing || existing.organizerId !== user.id) return { error: 'Not found' };

  const parsed = UpdateEventSchema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as string;
      fields[key] = [...(fields[key] ?? []), issue.message];
    }
    return { error: 'Validation failed', fields };
  }

  const data = parsed.data;

  await db.event.update({
    where: { id },
    data: {
      eventDate: new Date(data.eventDate),
      submissionDeadline: new Date(data.submissionDeadline),
      deliveryDate: new Date(data.deliveryDate),
      theme: data.theme,
      musicMood: data.musicMood,
    },
  });

  await db.auditLog.create({
    data: {
      eventId: id,
      actorId: user.id,
      action: 'event.updated',
      metadata: { theme: data.theme, musicMood: data.musicMood },
    },
  });

  logger.info({ eventId: id, organizerId: user.id }, 'Event updated');
  return { id };
}
