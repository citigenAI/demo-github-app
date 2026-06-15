import type { Metadata } from 'next';
import { db } from '@/lib/db';
import { isBusiness, COLLECTING_STATUSES } from './schema';
import { occasionNouns } from '@/lib/share';
import { ContributorForm } from './ContributorForm';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

function formatDeadlineLong(date: Date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-brand-ivory">
      <main className="max-w-2xl mx-auto px-6 py-16 md:py-20">
        {children}
      </main>
      <footer className="text-center pb-10 text-xs text-brand-stone/60">
        by Swara Media
      </footer>
    </div>
  );
}

export default async function ContributePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const event = await db.event.findUnique({
    where: { slug },
    select: {
      id: true,
      honoreeName: true,
      occasionType: true,
      status: true,
      submissionDeadline: true,
      organizer: { select: { name: true } },
    },
  });

  if (!event) {
    return (
      <Shell>
        <div className="bg-white border border-brand-ink/8 rounded-2xl p-8 md:p-12 text-center shadow-sm">
          <h1 className="font-display text-2xl font-semibold text-brand-ink mb-3">
            This link isn&apos;t valid.
          </h1>
          <p className="text-brand-stone text-sm">
            Double-check the link from your invitation, or ask the organizer to resend it.
          </p>
        </div>
      </Shell>
    );
  }

  const noun = occasionNouns[event.occasionType] ?? 'tribute';

  if (new Date() >= event.submissionDeadline) {
    return (
      <Shell>
        <div className="bg-white border border-brand-ink/8 rounded-2xl p-8 md:p-12 text-center shadow-sm">
          <h1 className="font-display text-2xl font-semibold text-brand-ink mb-3">
            Submissions for {event.honoreeName}&apos;s {noun} have closed.
          </h1>
          <p className="text-brand-stone text-sm">
            Thank you for wanting to take part. The collection window ended on{' '}
            {formatDeadlineLong(event.submissionDeadline)}.
          </p>
        </div>
      </Shell>
    );
  }

  if (!COLLECTING_STATUSES.has(event.status)) {
    return (
      <Shell>
        <div className="bg-white border border-brand-ink/8 rounded-2xl p-8 md:p-12 text-center shadow-sm">
          <h1 className="font-display text-2xl font-semibold text-brand-ink mb-3">
            This tribute isn&apos;t collecting submissions right now.
          </h1>
          <p className="text-brand-stone text-sm">
            If you have the link from the organizer, check back soon.
          </p>
        </div>
      </Shell>
    );
  }

  const business = isBusiness(event.occasionType);

  return (
    <Shell>
      <header className="text-center mb-8">
        <p className="text-xs uppercase tracking-[0.2em] text-brand-deep-saffron font-medium mb-3">
          Contributor invitation
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-semibold text-brand-ink leading-tight mb-3">
          Add to {event.honoreeName}&apos;s {noun} tribute
        </h1>
        <p className="text-brand-stone text-sm">
          Submissions close {formatDeadlineLong(event.submissionDeadline)}
        </p>
        {event.organizer?.name && (
          <p className="text-xs text-brand-deep-saffron mt-2 font-medium">
            Organized by {event.organizer.name}
          </p>
        )}
      </header>

      <section className="bg-white border border-brand-ink/8 rounded-2xl shadow-sm p-6 md:p-10">
        <ContributorForm slug={slug} honoreeName={event.honoreeName} isBusiness={business} />
      </section>
    </Shell>
  );
}
