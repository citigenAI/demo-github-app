import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('config module', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('parses required env vars into typed config', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@localhost:5432/swara_dev');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');

    const { config } = await import('@/config');
    expect(config.env).toBe('development');
    expect(config.database.url).toBe('postgresql://user:pw@localhost:5432/swara_dev');
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.app.publicUrl).toBe('http://localhost:3000');
  });

  it('throws a descriptive error when DATABASE_URL is missing', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');

    await expect(import('@/config')).rejects.toThrow(/database\.url/);
  });

  it('throws when DATABASE_URL is not a valid URL', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', 'not-a-url');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');

    await expect(import('@/config')).rejects.toThrow(/database\.url/);
  });
});
