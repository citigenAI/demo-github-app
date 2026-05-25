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
      <main className="max-w-xl mx-auto px-6 py-12">
        {children}
      </main>
      <footer className="text-center py-8 text-xs text-brand-stone/60">
        <p>by Swara Media</p>
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

  // Not found
  if (!event) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-brand-ink mb-3">
          This link isn&apos;t valid.
        </h1>
        <p className="text-brand-stone text-sm">
          Double-check the link from your invitation, or ask the organizer to resend it.
        </p>
      </Shell>
    );
  }

  const noun = occasionNouns[event.occasionType] ?? 'tribute';

  // Deadline closed
  if (new Date() >= event.submissionDeadline) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-brand-ink mb-3">
          Submissions for {event.honoreeName}&apos;s {noun} have closed.
        </h1>
        <p className="text-brand-stone text-sm">
          Thank you for wanting to take part. The collection window ended on{' '}
          {formatDeadlineLong(event.submissionDeadline)}.
        </p>
      </Shell>
    );
  }

  // Not collecting
  if (!COLLECTING_STATUSES.has(event.status)) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-brand-ink mb-3">
          This tribute isn&apos;t collecting submissions right now.
        </h1>
        <p className="text-brand-stone text-sm">
          If you have the link from the organizer, check back soon.
        </p>
      </Shell>
    );
  }

  const business = isBusiness(event.occasionType);

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="font-display text-2xl font-semibold text-brand-ink mb-1">
          Add to {event.honoreeName}&apos;s {noun} tribute
        </h1>
        <p className="text-brand-stone text-sm">
          Submissions close {formatDeadlineLong(event.submissionDeadline)}.
        </p>
        {event.organizer?.name && (
          <p className="text-brand-stone text-sm mt-1">Organized by {event.organizer.name}</p>
        )}
      </div>
      <ContributorForm slug={slug} honoreeName={event.honoreeName} isBusiness={business} />
    </Shell>
  );
}
