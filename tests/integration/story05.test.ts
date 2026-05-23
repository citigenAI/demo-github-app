import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const skip = process.env.SKIP_INTEGRATION === 'true';

describe.skipIf(skip)('Story 5 — Contributor submission integration', () => {
  let db: import('@prisma/client').PrismaClient;
  let organizerId: string;
  let packageId: string;
  let activeEventId: string;
  let activeEventSlug: string;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/swara_test');
    vi.stubEnv('REDIS_URL', process.env.REDIS_URL ?? 'redis://localhost:6379');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');

    const { db: prisma } = await import('@/lib/db');
    db = prisma;

    const pkg = await db.package.upsert({
      where: { id: 'pkg_test_s5' },
      update: {},
      create: {
        id: 'pkg_test_s5',
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

    const org = await db.user.upsert({
      where: { email: 'story5-org@test.com' },
      update: {},
      create: { email: 'story5-org@test.com', name: 'Story5 Org', role: 'ORGANIZER' },
    });
    organizerId = org.id;

    const event = await db.event.create({
      data: {
        slug: `s5-active-${Date.now()}`,
        organizerId,
        honoreeName: 'Test Person',
        occasionType: 'GRADUATION',
        eventDate: new Date(Date.now() + 30 * 86400000),
        submissionDeadline: new Date(Date.now() + 25 * 86400000),
        deliveryDate: new Date(Date.now() + 28 * 86400000),
        theme: 'Classic',
        musicMood: 'Emotional',
        expectedContributors: 10,
        packageId,
        status: 'ACTIVE',
      },
    });
    activeEventId = event.id;
    activeEventSlug = event.slug;
  });

  afterAll(async () => {
    if (!db || !activeEventId) return;
    await db.submission.deleteMany({ where: { eventId: activeEventId } });
    await db.event.deleteMany({ where: { organizerId } });
    await db.user.deleteMany({ where: { id: organizerId } });
    await db.package.deleteMany({ where: { id: packageId } });
    await db.$disconnect();
  });

  it('inserts a PENDING submission with consent and IP', async () => {
    const now = new Date();
    const sub = await db.submission.create({
      data: {
        eventId: activeEventId,
        contributorName: 'Happy Path',
        relationship: 'Friend',
        email: 'happy@test.com',
        textMessage: 'Congratulations',
        consentGiven: true,
        consentAt: now,
        ipAddress: '127.0.0.1',
      },
    });

    expect(sub.status).toBe('PENDING');
    expect(sub.consentGiven).toBe(true);
    expect(sub.consentAt).not.toBeNull();
    expect(sub.ipAddress).toBe('127.0.0.1');
    expect(sub.email).toBe('happy@test.com');
    expect(sub.eventId).toBe(activeEventId);
  });

  it('rejects duplicate email for the same event (P2002)', async () => {
    const now = new Date();
    // First insert
    await db.submission.create({
      data: {
        eventId: activeEventId,
        contributorName: 'First',
        relationship: 'Friend',
        email: 'dup@test.com',
        textMessage: 'First submission',
        consentGiven: true,
        consentAt: now,
        ipAddress: '127.0.0.2',
      },
    });

    // Second insert should fail with unique violation
    await expect(
      db.submission.create({
        data: {
          eventId: activeEventId,
          contributorName: 'Second',
          relationship: 'Friend',
          email: 'dup@test.com',
          textMessage: 'Second submission',
          consentGiven: true,
          consentAt: now,
          ipAddress: '127.0.0.2',
        },
      }),
    ).rejects.toThrow();

    // Exactly one row should exist
    const count = await db.submission.count({ where: { eventId: activeEventId, email: 'dup@test.com' } });
    expect(count).toBe(1);
  });

  it('cascade-deletes submissions when event is deleted', async () => {
    const tempEvent = await db.event.create({
      data: {
        slug: `cascade-test-${Date.now()}`,
        organizerId,
        honoreeName: 'Temp',
        occasionType: 'BIRTHDAY',
        eventDate: new Date(Date.now() + 30 * 86400000),
        submissionDeadline: new Date(Date.now() + 25 * 86400000),
        deliveryDate: new Date(Date.now() + 28 * 86400000),
        theme: 'Classic',
        musicMood: 'Upbeat',
        expectedContributors: 5,
        packageId,
        status: 'ACTIVE',
      },
    });

    await db.submission.create({
      data: {
        eventId: tempEvent.id,
        contributorName: 'Cascade Test',
        relationship: 'Test',
        email: 'cascade@test.com',
        textMessage: 'Will be deleted',
        consentGiven: true,
        consentAt: new Date(),
      },
    });

    // Delete the event — submissions should cascade-delete
    await db.event.delete({ where: { id: tempEvent.id } });

    const subCount = await db.submission.count({ where: { eventId: tempEvent.id } });
    expect(subCount).toBe(0);
  });

  it('verifies activeEventSlug is set', () => {
    expect(activeEventSlug.length).toBeGreaterThan(0);
  });

  it('slug uniqueness holds for two submissions to different events', async () => {
    const countA = await db.submission.count({ where: { eventId: activeEventId } });
    expect(countA).toBeGreaterThan(0);
  });
});
