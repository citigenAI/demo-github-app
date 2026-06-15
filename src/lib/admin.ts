import { auth } from '@/lib/auth';
import { config } from '@/config';
import { redirect } from 'next/navigation';

type AdminSession = { id: string; email: string; role: string };

/**
 * Server-side admin guard. A user is an admin when EITHER:
 *  - `User.role = ADMIN` in the DB (set via seed or future admin-promotion flow), OR
 *  - their email's domain is in `ADMIN_EMAIL_DOMAINS` (config seam).
 * Non-admins are redirected to /login. Returns the admin session on success.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.email) {
    redirect('/login?from=/admin');
  }
  // @ts-expect-error role is a custom claim on the session
  const role = user.role as string | undefined;
  const emailDomain = user.email.split('@')[1]?.toLowerCase() ?? '';
  const isAllowlistedDomain = config.auth.adminEmailDomains.includes(emailDomain);
  if (role !== 'ADMIN' && !isAllowlistedDomain) {
    redirect('/dashboard');
  }
  return { id: user.id, email: user.email, role: role ?? 'ADMIN' };
}
