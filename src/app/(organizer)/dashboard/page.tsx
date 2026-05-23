import Link from 'next/link';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listMyEvents } from '../events/actions';
import { occasionNouns } from '@/lib/share';
import { CalendarDays, Users } from 'lucide-react';

const occasionLabels: Record<string, string> = {
  GRADUATION: 'Graduation',
  BIRTHDAY: 'Birthday',
  WEDDING: 'Wedding',
  ANNIVERSARY: 'Anniversary',
  RETIREMENT: 'Retirement',
  BUSINESS_EVENT: 'Business Event',
};

function formatDate(date: Date) {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const result = await listMyEvents();
  if ('error' in result) redirect('/login');

  const { events } = result;

  return (
    <main className="px-6 py-12 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <h1 className="font-display text-3xl font-semibold text-brand-ink">My Events</h1>
        <Link
          href="/events/new"
          className="bg-brand-saffron text-white px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Create event
        </Link>
      </div>

      {events.length === 0 ? (
        <div className="text-center py-24 border border-dashed border-brand-stone/20 rounded-xl">
          <h2 className="font-display text-xl font-semibold text-brand-ink mb-2">No events yet.</h2>
          <p className="text-brand-stone mb-6 text-sm">
            Create your first tribute to start collecting wishes.
          </p>
          <Link
            href="/events/new"
            className="bg-brand-saffron text-white px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Create event
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {events.map((event) => (
            <Link
              key={event.id}
              href={`/events/${event.id}`}
              className="block border border-brand-stone/10 rounded-xl p-5 bg-white hover:border-brand-saffron/30 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-display text-lg font-semibold text-brand-ink leading-tight">
                    {event.honoreeName}
                  </p>
                  <p className="text-brand-stone text-sm mt-0.5">
                    {occasionLabels[event.occasionType] ?? occasionNouns[event.occasionType]}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-medium px-2 py-1 rounded-full bg-brand-saffron/10 text-brand-saffron">
                  Draft
                </span>
              </div>
              <div className="flex items-center gap-6 mt-3 text-xs text-brand-stone">
                <span className="flex items-center gap-1.5">
                  <CalendarDays size={14} />
                  Submissions close {formatDate(event.submissionDeadline)}
                </span>
                <span className="flex items-center gap-1.5">
                  <Users size={14} />
                  {event.expectedContributors} expected
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
