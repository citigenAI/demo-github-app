import { PrismaClient, Role } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  // Dev organizer — upsert so re-running is safe
  await db.user.upsert({
    where: { email: 'organizer@example.com' },
    update: {},
    create: { email: 'organizer@example.com', name: 'Dev Organizer', role: Role.ORGANIZER },
  });

  // Dev admin seam — not used by any login flow yet; Story 7 wires admin gating
  await db.user.upsert({
    where: { email: 'admin@swaramagical.com' },
    update: {},
    create: { email: 'admin@swaramagical.com', name: 'Dev Admin', role: Role.ADMIN },
  });

  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
