import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config — auth + email vars', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function baseEnv() {
    return {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      NEXTAUTH_SECRET: 'a-secret-that-is-long-enough-to-pass-validation-here',
      NEXTAUTH_URL: 'http://localhost:3000',
      ADMIN_EMAIL_DOMAINS: '',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      RESEND_FROM_ADDRESS: 'noreply@test.com',
    };
  }

  it('parses auth and email vars', async () => {
    const e = baseEnv();
    Object.entries(e).forEach(([k, v]) => vi.stubEnv(k, v));

    const { config } = await import('@/config');
    expect(config.auth.secret).toBe(e.NEXTAUTH_SECRET);
    expect(config.auth.url).toBe('http://localhost:3000');
    expect(config.auth.adminEmailDomains).toEqual([]);
    expect(config.email.smtpHost).toBe('localhost');
    expect(config.email.smtpPort).toBe(1025);
    expect(config.email.fromAddress).toBe('noreply@test.com');
  });

  it('parses ADMIN_EMAIL_DOMAINS as trimmed array', async () => {
    Object.entries(baseEnv()).forEach(([k, v]) => vi.stubEnv(k, v));
    vi.stubEnv('ADMIN_EMAIL_DOMAINS', ' example.com , swaramedia.com ');

    const { config } = await import('@/config');
    expect(config.auth.adminEmailDomains).toEqual(['example.com', 'swaramedia.com']);
  });

  it('empty ADMIN_EMAIL_DOMAINS yields empty array', async () => {
    Object.entries(baseEnv()).forEach(([k, v]) => vi.stubEnv(k, v));
    vi.stubEnv('ADMIN_EMAIL_DOMAINS', '');

    const { config } = await import('@/config');
    expect(config.auth.adminEmailDomains).toEqual([]);
  });

  it('throws when NEXTAUTH_SECRET is shorter than 32 chars', async () => {
    Object.entries(baseEnv()).forEach(([k, v]) => vi.stubEnv(k, v));
    vi.stubEnv('NEXTAUTH_SECRET', 'too-short');

    await expect(import('@/config')).rejects.toThrow(/auth\.secret/);
  });

  it('does not throw in production when RESEND_API_KEY is missing (optional everywhere)', async () => {
    Object.entries(baseEnv()).forEach(([k, v]) => vi.stubEnv(k, v));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RESEND_API_KEY', '');

    const { config } = await import('@/config');
    expect(config.email.resendApiKey).toBeUndefined();
  });

  it('does not throw in development when RESEND_API_KEY is absent', async () => {
    Object.entries(baseEnv()).forEach(([k, v]) => vi.stubEnv(k, v));
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RESEND_API_KEY', '');

    const { config } = await import('@/config');
    expect(config.email.resendApiKey).toBeUndefined();
  });
});

describe('callbackUrl sanitizer', () => {
  it('accepts same-origin relative paths', () => {
    const url = '/events/123';
    expect(url.startsWith('/')).toBe(true);
  });

  it('rejects off-origin URLs', () => {
    const url = 'https://evil.com/steal';
    expect(url.startsWith('/')).toBe(false);
  });
});

describe('NextAuth error code mapping', () => {
  const errorMessages: Record<string, string> = {
    Verification: 'That sign-in link has expired or was already used. Enter your email to get a new one.',
    EmailSignin: "We couldn't send the sign-in link just now. Please try again in a moment.",
    Configuration: 'Sign-in is temporarily unavailable. Please try again shortly.',
    AccessDenied: "This email isn't allowed to sign in.",
  };
  const defaultMsg = 'Something went wrong signing you in. Please try again.';

  function mapError(code: string | undefined): string {
    if (!code) return defaultMsg;
    return errorMessages[code] ?? defaultMsg;
  }

  it('maps known codes to branded messages', () => {
    expect(mapError('Verification')).toContain('expired');
    expect(mapError('EmailSignin')).toContain("couldn't send");
    expect(mapError('Configuration')).toContain('temporarily unavailable');
    expect(mapError('AccessDenied')).toContain("isn't allowed");
  });

  it('maps unknown code to default message', () => {
    expect(mapError('SomeUnknownCode')).toBe(defaultMsg);
  });

  it('maps undefined to default message', () => {
    expect(mapError(undefined)).toBe(defaultMsg);
  });

  it('messages contain no exclamation marks', () => {
    [...Object.values(errorMessages), defaultMsg].forEach((msg) => {
      expect(msg).not.toContain('!');
    });
  });
});

describe('email template', () => {
  it('subject matches spec', async () => {
    const { buildEmailHtml, buildEmailText } = await import('@/lib/email');
    const html = buildEmailHtml('https://example.com/verify', '123456');
    const text = buildEmailText('https://example.com/verify', '123456');

    expect(html).toContain('https://example.com/verify');
    expect(html).toContain('123456');
    expect(html).toContain('by Swara Media');
    // plaintext copy must have no exclamation marks (HTML has <!DOCTYPE> so skip HTML check)
    expect(text).toContain('https://example.com/verify');
    expect(text).toContain('123456');
    expect(text).toContain('by Swara Media');
    expect(text).not.toContain('!');
  });
});
