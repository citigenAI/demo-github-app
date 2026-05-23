'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';

interface Props {
  callbackUrl: string;
  error?: string;
}

export function LoginForm({ callbackUrl, error: initialError }: Props) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;

    setLoading(true);
    setError(undefined);

    const result = await signIn('nodemailer', {
      email: trimmed,
      redirect: false,
      callbackUrl: callbackUrl.startsWith('/') ? callbackUrl : '/events',
    });

    if (result?.error) {
      setError('Something went wrong signing you in. Please try again.');
      setLoading(false);
    } else {
      window.location.href = '/login?state=check-email';
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <div className="space-y-2">
        <label htmlFor="email" className="block text-sm font-medium text-brand-ink">
          Email address
        </label>
        <input
          id="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          aria-describedby={error ? 'email-error' : undefined}
          className="w-full rounded-md border border-brand-stone/30 bg-white px-4 py-3 text-brand-ink placeholder:text-brand-stone/50 focus:outline-none focus:ring-2 focus:ring-brand-saffron disabled:opacity-50"
          placeholder="you@example.com"
        />
        {error && (
          <p id="email-error" role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={loading || !email.trim()}
        aria-busy={loading}
        className="w-full rounded-md bg-brand-saffron px-4 py-3 text-brand-ivory font-semibold text-sm transition-opacity disabled:opacity-50"
      >
        {loading ? 'Sending…' : 'Send sign-in link'}
      </button>
    </form>
  );
}
