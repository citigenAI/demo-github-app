import { PrismaClient, Role } from '@prisma/client';
import { generateSlug } from '../src/lib/slug';

const db = new PrismaClient();

async function main() {
  // MVP 1 package — seeded in all environments
  const pkg = await db.package.upsert({
    where: { id: 'pkg_mvp1' },
    update: {},
    create: {
      id: 'pkg_mvp1',
      name: 'Magical Memories — Tribute Video',
      priceCents: 9900,
      currency: 'usd',
      features: ['video_master', 'reel', 'youtube', 'auto_thumbnail', 'download', 'share_page'],
      deliverySlaDays: 7,
      includedRevisions: 0,
      active: true,
    },
  });

  // Dev/test users and sample events — skipped in production
  if (process.env.NODE_ENV === 'production') {
    console.log('Seed complete (production — sample data skipped)');
    return;
  }

  const organizer = await db.user.upsert({
    where: { email: 'organizer@example.com' },
    update: {},
    create: { email: 'organizer@example.com', name: 'Dev Organizer', role: Role.ORGANIZER },
  });

  await db.user.upsert({
    where: { email: 'admin@swaramagical.com' },
    update: {},
    create: { email: 'admin@swaramagical.com', name: 'Dev Admin', role: Role.ADMIN },
  });

  const now = new Date();
  const future = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const past = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Sample event 1 — ACTIVE Graduation (collecting submissions)
  const activeEvent = await db.event.upsert({
    where: { slug: 'riyas-graduation' },
    update: { status: 'ACTIVE' },
    create: {
      slug: 'riyas-graduation',
      organizerId: organizer.id,
      honoreeName: 'Riya Sharma',
      occasionType: 'GRADUATION',
      eventDate: future(30),
      submissionDeadline: future(25),
      deliveryDate: future(28),
      theme: 'Classic',
      musicMood: 'Emotional',
      expectedContributors: 20,
      packageId: pkg.id,
      status: 'ACTIVE',
    },
  });

  // Sample submissions for the active event
  const sampleSubmissions = [
    { email: 'priya@example.com', contributorName: 'Priya Sharma', relationship: 'Friend', textMessage: 'So proud of you', funnyMemory: 'That time in the library', advice: null, professionalNote: null, status: 'PENDING' as const },
    { email: 'arjun@example.com', contributorName: 'Arjun Mehta', relationship: 'Cousin', textMessage: null, funnyMemory: null, advice: 'Keep learning every day', professionalNote: null, status: 'APPROVED' as const },
    { email: 'sara@example.com', contributorName: 'Sara Khan', relationship: 'Teacher', textMessage: 'It was a pleasure teaching you', funnyMemory: null, advice: null, professionalNote: null, status: 'REJECTED' as const },
    { email: 'dev@example.com', contributorName: 'Dev Patel', relationship: 'Classmate', textMessage: null, funnyMemory: 'Your presentations were epic', advice: null, professionalNote: null, status: 'FLAGGED' as const },
  ];

  for (const sub of sampleSubmissions) {
    await db.submission.upsert({
      where: { eventId_email: { eventId: activeEvent.id, email: sub.email } },
      update: {},
      create: {
        eventId: activeEvent.id,
        contributorName: sub.contributorName,
        relationship: sub.relationship,
        email: sub.email,
        textMessage: sub.textMessage,
        funnyMemory: sub.funnyMemory,
        advice: sub.advice,
        professionalNote: sub.professionalNote,
        consentGiven: true,
        consentAt: new Date(),
        status: sub.status,
        ipAddress: '127.0.0.1',
      },
    });
  }

  // Sample event 2 — DRAFT Graduation (uses generateSlug to demonstrate randomness)
  const slug2 = generateSlug('Riya Sharma', 'GRADUATION');
  const event2Exists = await db.event.findFirst({ where: { organizerId: organizer.id, status: 'DRAFT', occasionType: 'GRADUATION' }, select: { id: true } });
  if (!event2Exists) {
    await db.event.create({
      data: {
        slug: slug2,
        organizerId: organizer.id,
        honoreeName: 'Riya Sharma',
        occasionType: 'GRADUATION',
        eventDate: future(30),
        submissionDeadline: future(25),
        deliveryDate: future(28),
        theme: 'Classic',
        musicMood: 'Emotional',
        expectedContributors: 20,
        packageId: pkg.id,
        status: 'DRAFT',
      },
    });
  }

  // Sample event 3 — ACTIVE Business event
  const acmeEvent = await db.event.upsert({
    where: { slug: 'acme-25th' },
    update: { status: 'ACTIVE' },
    create: {
      slug: 'acme-25th',
      organizerId: organizer.id,
      honoreeName: 'Acme Corp',
      occasionType: 'BUSINESS_EVENT',
      eventDate: future(60),
      submissionDeadline: future(55),
      deliveryDate: future(58),
      theme: 'Minimal',
      musicMood: 'Inspirational',
      expectedContributors: 50,
      packageId: pkg.id,
      status: 'ACTIVE',
    },
  });

  // Business submission
  await db.submission.upsert({
    where: { eventId_email: { eventId: acmeEvent.id, email: 'ceo@example.com' } },
    update: {},
    create: {
      eventId: acmeEvent.id,
      contributorName: 'John CEO',
      relationship: 'CEO',
      email: 'ceo@example.com',
      textMessage: 'Congratulations on 25 years',
      funnyMemory: null,
      advice: null,
      professionalNote: 'A landmark achievement in our industry',
      consentGiven: true,
      consentAt: new Date(),
      status: 'PENDING',
      ipAddress: '127.0.0.1',
    },
  });

  // Closed event (deadline in the past) for UI testing
  await db.event.upsert({
    where: { slug: 'closed-event-test' },
    update: {},
    create: {
      slug: 'closed-event-test',
      organizerId: organizer.id,
      honoreeName: 'Test Honoree',
      occasionType: 'BIRTHDAY',
      eventDate: past(10),
      submissionDeadline: past(5),
      deliveryDate: past(3),
      theme: 'Vibrant',
      musicMood: 'Upbeat',
      expectedContributors: 10,
      packageId: pkg.id,
      status: 'ACTIVE',
    },
  });

  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
