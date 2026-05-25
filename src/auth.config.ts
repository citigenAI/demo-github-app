import type { NextAuthConfig } from 'next-auth';

// Edge-safe config — no Node.js-only providers (nodemailer is added in src/lib/auth.ts).
// Used by middleware which runs in the Edge runtime.
// strategy: 'jwt' so middleware can verify sessions without a DB call.
export const authConfig = {
  session: { strategy: 'jwt' as const },
  pages: {
    signIn: '/login',
    verifyRequest: '/login?state=check-email',
    error: '/login',
  },
  callbacks: {
    session({ session, token }) {
      if (token?.sub) session.user.id = token.sub;
      // @ts-expect-error role is a custom claim on the JWT
      if (token?.role) session.user.role = token.role;
      return session;
    },
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      if (user) {
        // @ts-expect-error role added by Prisma adapter
        token.role = user.role;
      }
      return token;
    },
    signIn() {
      return true;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
