'use client';

import { signOut } from 'next-auth/react';

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: '/login' })}
      className="text-sm text-brand-stone underline underline-offset-2 hover:text-brand-ink transition-colors"
    >
      Sign out
    </button>
  );
}
