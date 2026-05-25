import Link from 'next/link';
import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { getEvent } from '../../actions';
import { autoEventName } from '@/lib/share';
import { EditEventForm } from './EditEventForm';

export default async function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const { id } = await params;
  const result = await getEvent(id);
  if ('error' in result) {
    if (result.error === 'Unauthorized') redirect('/login');
    notFound();
  }

  const { event } = result;

  return (
    <main className="px-6 py-12 max-w-2xl mx-auto">
      <Link href={`/events/${id}`} className="text-xs text-brand-stone/70 hover:text-brand-ink mb-3 inline-block">
        ← Back to event
      </Link>
      <h1 className="font-display text-3xl font-semibold text-brand-ink mb-6">Edit event details</h1>
      <EditEventForm
        event={{
          id: event.id,
          name: event.name ?? autoEventName(event.honoreeName, event.occasionType),
          eventDate: event.eventDate.toISOString().slice(0, 10),
          deliveryDate: event.deliveryDate.toISOString().slice(0, 10),
          submissionDeadline: event.submissionDeadline.toISOString(),
          theme: event.theme,
          musicMood: event.musicMood,
        }}
      />
    </main>
  );
}
