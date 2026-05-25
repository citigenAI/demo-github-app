'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';

interface Props {
  callbackUrl: string;
  error?: string;
}

export function LoginForm({ callbackUrl, error: initialError }: Props) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError);

  const safeCallback = callbackUrl.startsWith('/') ? callbackUrl : '/events';

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;

    setLoading(true);
    setError(undefined);

    // Triggers the email provider to generate + email a 6-digit code.
    const result = await signIn('nodemailer', {
      email: trimmed,
      redirect: false,
      callbackUrl: safeCallback,
    });

    setLoading(false);
    if (result?.error) {
      setError('Something went wrong sending your code. Please try again.');
    } else {
      setEmail(trimmed);
      setCode('');
      setStep('code');
    }
  }

  function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    const trimmedCode = code.trim();
    if (trimmedCode.length < 6) return;
    setLoading(true);
    // The email provider's GET callback verifies the code (= verification token),
    // sets the session cookie, then redirects to callbackUrl. A wrong/expired code
    // redirects back to /login?error=Verification.
    const params = new URLSearchParams({
      token: trimmedCode,
      email,
      callbackUrl: safeCallback,
    });
    window.location.href = `/api/auth/callback/nodemailer?${params.toString()}`;
  }

  if (step === 'code') {
    return (
      <form onSubmit={verifyCode} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <label htmlFor="code" className="block text-sm font-medium text-brand-ink">
            Enter the 6-digit code
          </label>
          <p className="text-sm text-brand-ink/50">
            We sent a code to <span className="font-medium text-brand-ink">{email}</span>.
          </p>
          <input
            id="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            disabled={loading}
            className="w-full rounded-xl border border-brand-ink/15 bg-white px-4 py-3 text-center text-2xl tracking-[0.5em] font-semibold text-brand-ink focus:outline-none focus:ring-2 focus:ring-brand-deep-saffron/40 focus:border-brand-deep-saffron disabled:opacity-50 transition-colors"
            placeholder="······"
          />
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={loading || code.trim().length < 6}
          aria-busy={loading}
          className="w-full rounded-xl bg-brand-deep-saffron px-4 py-3 text-white font-semibold text-sm hover:bg-amber-600 transition-colors disabled:opacity-40"
        >
          {loading ? 'Verifying…' : 'Sign in'}
        </button>

        <button
          type="button"
          onClick={() => {
            setStep('email');
            setError(undefined);
          }}
          className="w-full text-center text-sm text-brand-deep-saffron hover:underline underline-offset-2"
        >
          Use a different email
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={sendCode} className="space-y-4" noValidate>
      <div className="space-y-1.5">
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
          className="w-full rounded-xl border border-brand-ink/15 bg-white px-4 py-3 text-brand-ink placeholder:text-brand-ink/30 focus:outline-none focus:ring-2 focus:ring-brand-deep-saffron/40 focus:border-brand-deep-saffron disabled:opacity-50 transition-colors"
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
        className="w-full rounded-xl bg-brand-deep-saffron px-4 py-3 text-white font-semibold text-sm hover:bg-amber-600 transition-colors disabled:opacity-40"
      >
        {loading ? 'Sending code…' : 'Email me a sign-in code'}
      </button>
    </form>
  );
}
