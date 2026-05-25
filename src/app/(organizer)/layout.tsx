import Link from 'next/link';
import { SignOutButton } from './events/SignOutButton';

// No SessionProvider: every page in this group authenticates server-side via auth(),
// and nothing uses useSession(). Mounting it only triggered a client /api/auth/session
// fetch on every page. The header gives a consistent logo + sign-out across organizer pages.
export default function OrganizerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-brand-ivory flex flex-col">
      <header className="px-6 h-16 flex items-center justify-between border-b border-brand-ink/5">
        <Link href="/dashboard" className="font-display text-xl font-semibold">
          <span className="text-brand-deep-saffron">Swara</span>
          <span className="text-brand-ink ml-1 font-light">Magical</span>
        </Link>
        <SignOutButton />
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
