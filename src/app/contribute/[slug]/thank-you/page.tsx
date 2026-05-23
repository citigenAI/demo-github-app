import type { Metadata } from 'next';
import { db } from '@/lib/db';
import { occasionNouns } from '@/lib/share';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function ThankYouPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const event = await db.event.findUnique({
    where: { slug },
    select: { honoreeName: true, occasionType: true },
  });

  const honoreeName = event?.honoreeName ?? 'their tribute';
  const noun = event ? (occasionNouns[event.occasionType] ?? 'tribute') : 'tribute';

  return (
    <div className="min-h-screen bg-brand-ivory">
      <main className="max-w-xl mx-auto px-6 py-24 text-center">
        <h1 className="font-display text-3xl font-semibold text-brand-ink mb-4">
          Your message for {honoreeName}&apos;s {noun} is in.
        </h1>
        <p className="text-brand-stone text-sm leading-relaxed">
          Thank you for taking the time — these are the moments that make a tribute feel like home.
        </p>
        <p className="text-brand-stone/60 text-xs mt-6">
          You can submit only once per event.
        </p>
      </main>
      <footer className="text-center py-8 text-xs text-brand-stone/60">
        <p>by Swara Media</p>
      </footer>
    </div>
  );
}
