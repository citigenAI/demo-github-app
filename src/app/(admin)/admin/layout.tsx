import { requireAdmin } from '@/lib/admin';
import Link from 'next/link';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  return (
    <div className="min-h-screen bg-brand-ivory">
      <header className="border-b border-brand-stone/10 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/admin" className="font-display text-lg font-semibold text-brand-ink">
              Swara · Admin
            </Link>
            <nav className="flex items-center gap-4 text-sm text-brand-stone">
              <Link href="/admin" className="hover:text-brand-ink">Events</Link>
            </nav>
          </div>
          <div className="text-xs text-brand-stone">{admin.email}</div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}
