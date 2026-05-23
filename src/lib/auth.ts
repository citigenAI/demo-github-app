import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Nodemailer from 'next-auth/providers/nodemailer';
import { db } from '@/lib/db';
import { config } from '@/config';
import { logger } from '@/lib/logger';
import { sendVerificationRequest } from '@/lib/email';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: 'database', maxAge: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
  secret: config.auth.secret,
  pages: {
    signIn: '/login',
    verifyRequest: '/login?state=check-email',
    error: '/login',
  },
  providers: [
    Nodemailer({
      server: {
        host: config.email.smtpHost,
        port: config.email.smtpPort,
        auth: undefined,
        secure: false,
      },
      from: config.email.fromAddress,
      maxAge: 24 * 60 * 60,
      sendVerificationRequest,
    }),
  ],
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      // @ts-expect-error role is added via Prisma adapter
      session.user.role = user.role;
      return session;
    },
    // Seam: Story 7 adds admin domain enforcement here for the Google provider.
    // For now all email sign-ins are allowed.
    signIn() {
      return true;
    },
  },
  events: {
    signIn({ user }) {
      logger.info({ userId: user.id, event: 'auth.signin' }, 'User signed in');
    },
    signOut(message) {
      if ('session' in message && message.session) {
        logger.info({ userId: message.session.userId, event: 'auth.signout' }, 'User signed out');
      }
    },
  },
});
