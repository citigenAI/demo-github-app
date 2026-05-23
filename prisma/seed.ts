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

  // Sample event 1 — Graduation
  const slug1 = generateSlug('Riya Sharma', 'GRADUATION');
  const event1Exists = await db.event.findFirst({ where: { organizerId: organizer.id, occasionType: 'GRADUATION' }, select: { id: true } });
  if (!event1Exists) {
    await db.event.create({
      data: {
        slug: slug1,
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
      },
    });
  }

  // Sample event 2 — Business Event
  const slug2 = generateSlug('Acme Corp', 'BUSINESS_EVENT');
  const event2Exists = await db.event.findFirst({ where: { organizerId: organizer.id, occasionType: 'BUSINESS_EVENT' }, select: { id: true } });
  if (!event2Exists) {
    await db.event.create({
      data: {
        slug: slug2,
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
      },
    });
  }

  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
