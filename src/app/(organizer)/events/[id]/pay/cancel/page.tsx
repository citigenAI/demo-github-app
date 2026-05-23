import Link from 'next/link';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function PayCancelPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const { id } = await params;

  return (
    <main className="min-h-screen bg-brand-ivory flex items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="font-display text-3xl font-semibold text-brand-ink mb-4">
          Payment canceled.
        </h1>
        <p className="text-brand-stone text-sm mb-6">
          Your draft is saved. Pay anytime to activate.
        </p>
        <Link
          href={`/events/${id}`}
          className="bg-brand-saffron text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Try again
        </Link>
      </div>
    </main>
  );
}
