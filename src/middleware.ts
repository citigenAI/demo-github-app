import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';

export default auth((req) => {
  if (!req.auth) {
    const loginUrl = new URL('/login', req.url);
    const callbackUrl = req.nextUrl.pathname + req.nextUrl.search;
    // Only accept same-origin callbackUrl
    if (callbackUrl.startsWith('/')) {
      loginUrl.searchParams.set('callbackUrl', callbackUrl);
    }
    return NextResponse.redirect(loginUrl);
  }
});

export const config = {
  matcher: ['/dashboard/:path*', '/events/:path*', '/admin/:path*'],
};
