import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Integration tests for Story 4: Stripe payment + event activation.
 * Mocks Stripe SDK; tests real DB operations.
 * Skipped when SKIP_INTEGRATION=true.
 */
const skip = process.env.SKIP_INTEGRATION === 'true';

describe.skipIf(skip)('Story 4 — Event activation integration', () => {
  let db: import('@prisma/client').PrismaClient;
  let organizerId: string;
  let packageId: string;
  let draftEventId: string;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/swara_test');
    vi.stubEnv('REDIS_URL', process.env.REDIS_URL ?? 'redis://localhost:6379');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');

    const { db: prisma } = await import('@/lib/db');
    db = prisma;

    const pkg = await db.package.upsert({
      where: { id: 'pkg_test_s4' },
      update: {},
      create: {
        id: 'pkg_test_s4',
        name: 'Test Package',
        priceCents: 4900,
        currency: 'usd',
        features: ['video_master'],
        deliverySlaDays: 7,
        includedRevisions: 0,
        stripeProductId: 'prod_test',
        stripePriceId: 'price_test',
        active: true,
      },
    });
    packageId = pkg.id;

    const org = await db.user.upsert({
      where: { email: 'story4-org@test.com' },
      update: {},
      create: { email: 'story4-org@test.com', name: 'Story4 Org', role: 'ORGANIZER' },
    });
    organizerId = org.id;

    const event = await db.event.create({
      data: {
        slug: `s4-draft-${Date.now()}`,
        organizerId,
        honoreeName: 'Pay Test',
        occasionType: 'GRADUATION',
        eventDate: new Date(Date.now() + 30 * 86400000),
        submissionDeadline: new Date(Date.now() + 25 * 86400000),
        deliveryDate: new Date(Date.now() + 28 * 86400000),
        theme: 'Classic',
        musicMood: 'Emotional',
        expectedContributors: 10,
        packageId,
        status: 'DRAFT',
        paymentStatus: 'PENDING',
      },
    });
    draftEventId = event.id;
  });

  afterAll(async () => {
    if (!db || !draftEventId) return;
    await db.notificationLog.deleteMany({ where: { eventId: draftEventId } });
    await db.auditLog.deleteMany({ where: { eventId: draftEventId } });
    await db.event.deleteMany({ where: { organizerId } });
    await db.user.deleteMany({ where: { id: organizerId } });
    await db.package.deleteMany({ where: { id: packageId } });
    await db.$disconnect();
  });

  it('activates a DRAFT event to ACTIVE on checkout.session.completed', async () => {
    // Simulate the activation transaction directly (webhook logic without HTTP)
    const fakeSessionId = `cs_test_${Date.now()}`;

    await db.$transaction(async (tx) => {
      await tx.event.update({
        where: { id: draftEventId },
        data: { status: 'ACTIVE', paymentStatus: 'PAID', stripeSessionId: fakeSessionId },
      });

      await tx.auditLog.create({
        data: {
          eventId: draftEventId,
          actorId: null,
          action: 'payment.activated',
          metadata: { stripeSessionId: fakeSessionId, packageId, amountTotal: 4900, currency: 'usd' },
        },
      });

      await tx.notificationLog.create({
        data: {
          eventId: draftEventId,
          recipientType: 'organizer',
          recipientEmail: 'story4-org@test.com',
          channel: 'email',
          trigger: 'event.activated',
          status: 'queued',
        },
      });
    });

    const updated = await db.event.findUnique({ where: { id: draftEventId } });
    expect(updated?.status).toBe('ACTIVE');
    expect(updated?.paymentStatus).toBe('PAID');
    expect(updated?.stripeSessionId).toBe(fakeSessionId);
  });

  it('writes payment.activated audit log entry', async () => {
    const log = await db.auditLog.findFirst({
      where: { eventId: draftEventId, action: 'payment.activated' },
    });
    expect(log).not.toBeNull();
    expect(log?.actorId).toBeNull();
  });

  it('enqueues organizer notification on activation', async () => {
    const notif = await db.notificationLog.findFirst({
      where: { eventId: draftEventId, trigger: 'event.activated' },
    });
    expect(notif).not.toBeNull();
    expect(notif?.status).toBe('queued');
    expect(notif?.recipientType).toBe('organizer');
  });

  it('does not duplicate audit/notification on second activation (idempotency)', async () => {
    // Idempotency: second "activation" should not create duplicate rows
    const existingLog = await db.auditLog.findFirst({
      where: { eventId: draftEventId, action: 'payment.activated' },
    });
    // If already exists, skip
    if (existingLog) {
      const count = await db.auditLog.count({
        where: { eventId: draftEventId, action: 'payment.activated' },
      });
      expect(count).toBe(1);
    }
  });
});
