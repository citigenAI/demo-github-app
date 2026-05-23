import { SessionProvider } from 'next-auth/react';

export default function OrganizerLayout({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
