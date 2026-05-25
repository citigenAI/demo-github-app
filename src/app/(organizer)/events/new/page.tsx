import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { CreateEventForm } from './CreateEventForm';

export default async function NewEventPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const [packages, currentUser] = await Promise.all([
    db.package.findMany({
      where: { active: true },
      select: { id: true, name: true, priceCents: true, currency: true, features: true, deliverySlaDays: true, includedRevisions: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.user.findUnique({ where: { id: session.user.id }, select: { name: true } }),
  ]);

  return (
    <main className="px-6 py-12 max-w-2xl mx-auto">
      <h1 className="font-display text-3xl font-semibold text-brand-ink mb-2">Create a tribute</h1>
      <p className="text-brand-stone text-sm mb-8">
        Creating your event is free. You&apos;ll set up payment in the next step.
      </p>
      <CreateEventForm packages={packages} defaultOrganizerName={currentUser?.name ?? ''} />
    </main>
  );
}
