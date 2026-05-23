import { auth } from '@/lib/auth';
import { SignOutButton } from './SignOutButton';

export default async function EventsPage() {
  const session = await auth();

  return (
    <>
      <header className="border-b border-brand-stone/10 bg-brand-ivory px-6 py-4 flex items-center justify-between">
        <div>
          <span className="font-display text-lg font-semibold text-brand-saffron">Swara</span>
          <span className="font-display text-sm font-light text-brand-ink ml-1">Magical Memories</span>
        </div>
        <div className="flex items-center gap-4 text-sm text-brand-stone">
          <span>{session?.user?.email}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="px-6 py-12 max-w-4xl mx-auto">
        <h1 className="font-display text-3xl font-semibold text-brand-ink mb-3">Your events</h1>
        <p className="text-brand-stone">
          No events yet. When you create your first tribute, it will appear here.
        </p>
      </main>
    </>
  );
}
