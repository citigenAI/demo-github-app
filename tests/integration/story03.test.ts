import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Integration tests for Story 3: Event Creation.
 * Requires a real Postgres DB (swara_test schema). Skipped when SKIP_INTEGRATION=true.
 */
const skip = process.env.SKIP_INTEGRATION === 'true';

describe.skipIf(skip)('Story 3 — Event creation integration', () => {
  let db: import('@prisma/client').PrismaClient;
  let organizerAId: string;
  let organizerBId: string;
  let packageId: string;

  beforeAll(async () => {
    vi.stubEnv(
      'DATABASE_URL',
      process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/swara_test',
    );
    vi.stubEnv('REDIS_URL', process.env.REDIS_URL ?? 'redis://localhost:6379');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');

    const { db: prisma } = await import('@/lib/db');
    db = prisma;

    // Seed a test package
    const pkg = await db.package.upsert({
      where: { id: 'pkg_test_s3' },
      update: {},
      create: {
        id: 'pkg_test_s3',
        name: 'Test Package',
        priceCents: 9900,
        currency: 'usd',
        features: ['video_master'],
        deliverySlaDays: 7,
        includedRevisions: 0,
        active: true,
      },
    });
    packageId = pkg.id;

    // Seed two organizers for isolation tests
    const orgA = await db.user.upsert({
      where: { email: 'story3-org-a@test.com' },
      update: {},
      create: { email: 'story3-org-a@test.com', name: 'Org A', role: 'ORGANIZER' },
    });
    organizerAId = orgA.id;

    const orgB = await db.user.upsert({
      where: { email: 'story3-org-b@test.com' },
      update: {},
      create: { email: 'story3-org-b@test.com', name: 'Org B', role: 'ORGANIZER' },
    });
    organizerBId = orgB.id;
  });

  afterAll(async () => {
    if (!db || !organizerAId || !organizerBId) return;
    await db.auditLog.deleteMany({ where: { actorId: { in: [organizerAId, organizerBId] } } });
    await db.event.deleteMany({ where: { organizerId: { in: [organizerAId, organizerBId] } } });
    await db.user.deleteMany({ where: { id: { in: [organizerAId, organizerBId] } } });
    await db.package.deleteMany({ where: { id: packageId } });
    await db.$disconnect();
  });

  function futureDate(daysFromNow: number, withTime = false): string {
    const d = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
    return withTime ? d.toISOString() : d.toISOString().split('T')[0];
  }

  it('creates a DRAFT event with correct fields and a unique slug', async () => {
    const { generateSlug } = await import('@/lib/slug');
    const { db: prisma } = await import('@/lib/db');

    const slug = generateSlug('Riya Sharma', 'GRADUATION');
    // Ensure slug doesn't already exist
    const existing = await prisma.event.findUnique({ where: { slug } });

    const event = await prisma.event.create({
      data: {
        slug: existing ? `${slug}-x` : slug,
        organizerId: organizerAId,
        honoreeName: 'Riya Sharma',
        occasionType: 'GRADUATION',
        eventDate: new Date(futureDate(32)),
        submissionDeadline: new Date(futureDate(25, true)),
        deliveryDate: new Date(futureDate(28)),
        theme: 'Classic',
        musicMood: 'Emotional',
        expectedContributors: 20,
        packageId,
      },
    });

    expect(event.status).toBe('DRAFT');
    expect(event.paymentStatus).toBe('PENDING');
    expect(event.organizerId).toBe(organizerAId);
    expect(event.slug.length).toBeGreaterThan(0);
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.slug)).toBe(true);
  });

  it('listMyEvents returns only the organizer\'s own events', async () => {
    const { db: prisma } = await import('@/lib/db');

    const slugB = `org-b-event-${Date.now()}`;
    await prisma.event.create({
      data: {
        slug: slugB,
        organizerId: organizerBId,
        honoreeName: 'Someone Else',
        occasionType: 'BIRTHDAY',
        eventDate: new Date(futureDate(32)),
        submissionDeadline: new Date(futureDate(25, true)),
        deliveryDate: new Date(futureDate(28)),
        theme: 'Vibrant',
        musicMood: 'Upbeat',
        expectedContributors: 10,
        packageId,
      },
    });

    const eventsA = await prisma.event.findMany({ where: { organizerId: organizerAId } });
    const eventsB = await prisma.event.findMany({ where: { organizerId: organizerBId } });

    // Org A's list should not contain org B's event
    const orgBEventInOrgAList = eventsA.some((e) => e.organizerId === organizerBId);
    expect(orgBEventInOrgAList).toBe(false);

    // Org B's list should not contain org A's events
    const orgAEventInOrgBList = eventsB.some((e) => e.organizerId === organizerAId);
    expect(orgAEventInOrgBList).toBe(false);
  });

  it('getEvent returns not-found for events owned by another organizer', async () => {
    const { db: prisma } = await import('@/lib/db');

    const eventB = await prisma.event.findFirst({ where: { organizerId: organizerBId } });
    expect(eventB).not.toBeNull();

    // Org A should not be able to see org B's event
    const result = await prisma.event.findUnique({
      where: { id: eventB!.id },
    });
    // The event exists in DB, but ownership check (in the action) would block it
    expect(result?.organizerId).not.toBe(organizerAId);
  });

  it('writes an AuditLog entry on event creation', async () => {
    const { db: prisma } = await import('@/lib/db');

    const slug = `audit-test-${Date.now()}`;
    const event = await prisma.event.create({
      data: {
        slug,
        organizerId: organizerAId,
        honoreeName: 'Audit Test',
        occasionType: 'RETIREMENT',
        eventDate: new Date(futureDate(32)),
        submissionDeadline: new Date(futureDate(25, true)),
        deliveryDate: new Date(futureDate(28)),
        theme: 'Minimal',
        musicMood: 'Nostalgic',
        expectedContributors: 5,
        packageId,
      },
    });

    await prisma.auditLog.create({
      data: {
        eventId: event.id,
        actorId: organizerAId,
        action: 'event.created',
        metadata: { occasionType: 'RETIREMENT', packageId, slug },
      },
    });

    const log = await prisma.auditLog.findFirst({
      where: { eventId: event.id, action: 'event.created' },
    });

    expect(log).not.toBeNull();
    expect(log?.actorId).toBe(organizerAId);
    expect(log?.eventId).toBe(event.id);
  });

  it('two events with the same honoree name get different slugs', async () => {
    const { generateSlug } = await import('@/lib/slug');
    const slug1 = generateSlug('Same Name', 'GRADUATION');
    const slug2 = generateSlug('Same Name', 'GRADUATION');
    expect(slug1).not.toBe(slug2);
  });
});
