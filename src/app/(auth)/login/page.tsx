import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { LoginForm } from './LoginForm';

const errorMessages: Record<string, string> = {
  Verification: 'That code is invalid or has expired. Enter your email to get a new one.',
  EmailSignin: "We couldn't send your code just now. Please try again in a moment.",
  Configuration: 'Sign-in is temporarily unavailable. Please try again shortly.',
  AccessDenied: "This email isn't allowed to sign in.",
};

function errorMessage(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return errorMessages[code] ?? 'Something went wrong signing you in. Please try again.';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; error?: string; callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session) redirect('/events');

  const params = await searchParams;
  const isCheckEmail = params.state === 'check-email';
  const error = errorMessage(params.error);
  const callbackUrl = params.callbackUrl ?? '/events';

  return (
    <div className="min-h-screen bg-brand-ivory flex flex-col">
      {/* Minimal nav */}
      <nav className="px-6 h-16 flex items-center justify-between border-b border-brand-ink/5">
        <Link href="/" className="font-display text-xl font-semibold">
          <span className="text-brand-deep-saffron">Swara</span>
          <span className="text-brand-ink ml-1 font-light">Magical</span>
        </Link>
      </nav>

      {/* Form */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          {isCheckEmail ? (
            <CheckEmailPanel />
          ) : (
            <>
              <div className="mb-8">
                <h1 className="font-display text-3xl font-semibold text-brand-ink mb-2">
                  {params.callbackUrl ? 'Sign in to continue' : 'Welcome back'}
                </h1>
                <p className="text-brand-ink/50 text-sm">
                  Enter your email and we&apos;ll send you a sign-in link — no password needed.
                </p>
              </div>
              <LoginForm callbackUrl={callbackUrl} error={error} />
              <p className="mt-8 text-center text-xs text-brand-ink/30">
                New here?{' '}
                <Link href="/login" className="text-brand-deep-saffron hover:underline">
                  Sign up with your email
                </Link>{' '}
                — same flow.
              </p>
            </>
          )}
        </div>
      </main>

      <footer className="py-6 text-center">
        <p className="text-xs text-brand-ink/30 uppercase tracking-widest">by Swara Media</p>
      </footer>
    </div>
  );
}

function CheckEmailPanel() {
  return (
    <div aria-live="polite" className="text-center space-y-5">
      <div className="w-16 h-16 rounded-full bg-brand-deep-saffron/10 flex items-center justify-center mx-auto">
        <svg className="w-7 h-7 text-brand-deep-saffron" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
        </svg>
      </div>
      <div>
        <h2 className="font-display text-2xl font-semibold text-brand-ink mb-2">Check your email</h2>
        <p className="text-brand-ink/50 text-sm leading-relaxed max-w-xs mx-auto">
          We sent a sign-in link to your inbox. Click it to continue — it&apos;s valid for 24 hours.
        </p>
      </div>
      <Link href="/login" className="inline-block text-sm text-brand-deep-saffron hover:underline underline-offset-2">
        Use a different email
      </Link>
    </div>
  );
}
