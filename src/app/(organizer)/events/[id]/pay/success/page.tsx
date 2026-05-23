'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function PaySuccessPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [status, setStatus] = useState<'pending' | 'active' | 'error'>('pending');
  const [eventId, setEventId] = useState('');

  useEffect(() => {
    params.then(({ id }) => {
      setEventId(id);
      // Poll event status up to ~30s
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        try {
          const res = await fetch(`/api/events/${id}/status`);
          if (res.ok) {
            const data = await res.json();
            if (data.status === 'ACTIVE') {
              setStatus('active');
              clearInterval(interval);
            }
          }
        } catch {
          // silently ignore fetch errors
        }
        if (attempts >= 15) clearInterval(interval);
      }, 2000);

      return () => clearInterval(interval);
    });
  }, [params, router]);

  if (status === 'active') {
    return (
      <main className="min-h-screen bg-brand-ivory flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="font-display text-3xl font-semibold text-brand-ink mb-4">
            Payment received. Your event is active.
          </h1>
          <p className="text-brand-stone text-sm mb-6">
            Share the link with contributors to start collecting wishes.
          </p>
          <Link
            href={`/events/${eventId}`}
            className="bg-brand-saffron text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            View your event
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-brand-ivory flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="font-display text-3xl font-semibold text-brand-ink mb-4">
          Payment received — we&apos;re finalizing your event.
        </h1>
        <p className="text-brand-stone text-sm mb-6">
          This updates automatically. It usually takes just a moment.
        </p>
        <div className="inline-block w-5 h-5 border-2 border-brand-saffron/30 border-t-brand-saffron rounded-full animate-spin" />
      </div>
    </main>
  );
}
