import Link from 'next/link';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listMyEvents } from '../events/actions';
import { occasionNouns } from '@/lib/share';
import { CalendarDays, Users, Plus } from 'lucide-react';

const occasionLabels: Record<string, string> = {
  GRADUATION: 'Graduation',
  BIRTHDAY: 'Birthday',
  WEDDING: 'Wedding',
  ANNIVERSARY: 'Anniversary',
  RETIREMENT: 'Retirement',
  BUSINESS_EVENT: 'Business Event',
};

function formatDate(date: Date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const result = await listMyEvents();
  if ('error' in result) redirect('/login');

  const { events } = result;

  return (
    <main className="px-6 md:px-10 py-12 max-w-5xl mx-auto">
      {/* Page header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-12">
        <h1 className="font-display text-3xl md:text-4xl font-semibold text-brand-ink leading-tight">
          My events
        </h1>
        <Link
          href="/events/new"
          className="inline-flex items-center gap-2 bg-brand-deep-saffron text-white text-sm font-medium px-6 py-2.5 rounded-full hover:opacity-90 transition-all shadow-sm active:scale-95"
        >
          <Plus size={16} strokeWidth={2.25} />
          Create event
        </Link>
      </header>

      {events.length === 0 ? (
        // Empty state
        <section className="bg-white border border-brand-ink/8 rounded-2xl px-8 py-12 md:px-16 md:py-16 text-center max-w-3xl mx-auto shadow-sm">
          <h2 className="font-display text-2xl md:text-3xl font-semibold text-brand-ink mb-3">
            Welcome to Swara Magical Memories
          </h2>
          <p className="text-brand-stone text-base mb-10 max-w-md mx-auto">
            Let&apos;s create your first tribute to start collecting wishes.
          </p>

          <ol className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12 max-w-2xl mx-auto">
            {[
              { title: 'Create your event', body: 'Tell us about the occasion in under a minute.' },
              { title: 'Share the link', body: 'Friends and family submit video, voice, photo, or text.' },
              { title: 'We make the video', body: 'A polished tribute lands before the big day.' },
            ].map((step, i) => (
              <li key={i} className="flex flex-col items-center">
                <div className="w-11 h-11 bg-brand-deep-saffron text-white rounded-full flex items-center justify-center font-display text-base font-semibold mb-4 shadow-sm">
                  {i + 1}
                </div>
                <p className="font-medium text-brand-ink text-sm leading-tight">{step.title}</p>
                <p className="text-brand-stone text-xs mt-1 leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>

          <Link
            href="/events/new"
            className="inline-block bg-brand-deep-saffron text-white text-sm font-medium px-10 py-3.5 rounded-full hover:opacity-90 transition-all shadow-md active:scale-95"
          >
            Create event
          </Link>
        </section>
      ) : (
        // List state
        <section>
          <p className="text-xs uppercase tracking-widest text-brand-stone mb-5 font-medium">
            Your tributes ({events.length})
          </p>
          <div className="space-y-4">
            {events.map((event) => {
              const occasionLabel = occasionLabels[event.occasionType] ?? occasionNouns[event.occasionType];
              const isActive = event.status === 'ACTIVE';
              return (
                <Link
                  key={event.id}
                  href={`/events/${event.id}`}
                  className="group block bg-white border border-brand-ink/8 rounded-2xl p-6 hover:shadow-lg hover:border-brand-deep-saffron/20 transition-all duration-300"
                >
                  <div className="flex justify-between items-start gap-4 mb-4">
                    <div className="flex flex-col gap-2 min-w-0">
                      <h4 className="font-display text-xl font-semibold text-brand-ink leading-tight group-hover:text-brand-deep-saffron transition-colors">
                        {event.name ?? event.honoreeName}
                      </h4>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-brand-gold-accent/20 text-brand-twilight text-[10px] uppercase tracking-wider font-semibold w-fit">
                        {occasionLabel}
                      </span>
                    </div>
                    <span
                      className={`shrink-0 inline-flex items-center px-3 py-1 rounded-full text-[10px] uppercase tracking-wider font-semibold ${
                        isActive
                          ? 'bg-green-100 text-green-800'
                          : 'bg-brand-deep-saffron/10 text-brand-deep-saffron'
                      }`}
                    >
                      {isActive ? 'Active' : 'Draft'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-brand-stone">
                    <div className="flex items-center gap-2">
                      <CalendarDays size={16} className="text-brand-deep-saffron" strokeWidth={1.75} />
                      <span>Submissions close {formatDate(event.submissionDeadline)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Users size={16} className="text-brand-deep-saffron" strokeWidth={1.75} />
                      <span>{event.expectedContributors} expected</span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
