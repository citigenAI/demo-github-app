import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { LoginForm } from './LoginForm';

const errorMessages: Record<string, string> = {
  Verification: 'That sign-in link has expired or was already used. Enter your email to get a new one.',
  EmailSignin: "We couldn't send the sign-in link just now. Please try again in a moment.",
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
    <main className="min-h-screen bg-brand-ivory flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <h1 className="font-display text-3xl font-semibold text-brand-saffron leading-tight">
            Swara
          </h1>
          <p className="font-display text-xl font-light text-brand-ink">Magical Memories</p>
        </div>

        {isCheckEmail ? (
          <CheckEmailPanel />
        ) : (
          <LoginForm callbackUrl={callbackUrl} error={error} />
        )}

        <p className="mt-10 text-center text-xs text-brand-stone">by Swara Media</p>
      </div>
    </main>
  );
}

function CheckEmailPanel() {
  return (
    <div aria-live="polite" className="text-center space-y-4">
      <h2 className="font-display text-2xl font-semibold text-brand-ink">Check your email</h2>
      <p className="text-brand-stone text-sm leading-relaxed">
        We sent a sign-in link to your email. Click it to continue. The link is valid for 24 hours.
      </p>
      <a href="/login" className="text-sm text-brand-saffron underline underline-offset-2">
        Use a different email
      </a>
    </div>
  );
}
