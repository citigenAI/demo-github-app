import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('config module', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function stubBase() {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@localhost:5432/swara_dev');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    vi.stubEnv('NEXTAUTH_SECRET', 'a-secret-that-is-long-enough-to-pass-32chars-validation');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    vi.stubEnv('SMTP_HOST', 'localhost');
    vi.stubEnv('SMTP_PORT', '1025');
    vi.stubEnv('RESEND_FROM_ADDRESS', 'noreply@test.com');
  }

  it('parses required env vars into typed config', async () => {
    stubBase();

    const { config } = await import('@/config');
    expect(config.env).toBe('development');
    expect(config.database.url).toBe('postgresql://user:pw@localhost:5432/swara_dev');
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.app.publicUrl).toBe('http://localhost:3000');
  });

  it('throws a descriptive error when DATABASE_URL is missing', async () => {
    stubBase();
    vi.stubEnv('DATABASE_URL', '');

    await expect(import('@/config')).rejects.toThrow(/database\.url/);
  });

  it('throws when DATABASE_URL is not a valid URL', async () => {
    stubBase();
    vi.stubEnv('DATABASE_URL', 'not-a-url');

    await expect(import('@/config')).rejects.toThrow(/database\.url/);
  });
});
