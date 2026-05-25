import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Nodemailer from 'next-auth/providers/nodemailer';
import { randomInt } from 'node:crypto';
import { db } from '@/lib/db';
import { config } from '@/config';
import { logger } from '@/lib/logger';
import { sendVerificationRequest } from '@/lib/email';
import { authConfig } from '@/auth.config';

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(db),
  session: { strategy: 'jwt' as const, maxAge: 30 * 24 * 60 * 60 },
  secret: config.auth.secret,
  providers: [
    Nodemailer({
      server: {
        host: config.email.smtpHost,
        port: config.email.smtpPort,
        auth: undefined,
        secure: false,
      },
      from: config.email.fromAddress,
      // OTP login: the verification token IS a 6-digit code the user types back.
      // Valid for 10 minutes.
      maxAge: 10 * 60,
      generateVerificationToken: () => randomInt(0, 1_000_000).toString().padStart(6, '0'),
      sendVerificationRequest,
    }),
  ],
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
