'use client';

import { useState, useTransition } from 'react';

export function PayButton({ eventId }: { eventId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState('');

  function handlePay() {
    setError('');
    startTransition(async () => {
      const res = await fetch(`/api/events/${eventId}/checkout`, { method: 'POST' });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error ?? 'Something went wrong. Please try again.');
      }
    });
  }

  return (
    <div>
      <button
        onClick={handlePay}
        disabled={isPending}
        className="bg-brand-saffron text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {isPending ? 'Redirecting to payment...' : 'Pay and activate'}
      </button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
