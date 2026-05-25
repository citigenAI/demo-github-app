import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

// Use the edge-safe config so middleware never imports nodemailer or Prisma.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  if (!req.auth) {
    const loginUrl = new URL('/login', req.url);
    const callbackUrl = req.nextUrl.pathname + req.nextUrl.search;
    if (callbackUrl.startsWith('/')) {
      loginUrl.searchParams.set('callbackUrl', callbackUrl);
    }
    return Response.redirect(loginUrl);
  }
});

export const config = {
  matcher: ['/dashboard/:path*', '/events/:path*', '/admin/:path*'],
};
