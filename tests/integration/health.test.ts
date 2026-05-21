import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * This integration test exercises the /api/health route against a real Redis
 * (from docker-compose) and a real Supabase swara_test database.
 *
 * Skipped automatically when SKIP_INTEGRATION=true (used in environments
 * without infra), so CI can run unit tests in isolation.
 */
const skip = process.env.SKIP_INTEGRATION === 'true';

describe.skipIf(skip)('GET /api/health', () => {
  beforeAll(() => {
    vi.stubEnv(
      'DATABASE_URL',
      process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/swara_test',
    );
    vi.stubEnv('REDIS_URL', process.env.REDIS_URL ?? 'redis://localhost:6379');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
  });

  it('returns 200 with db + redis connected when both are reachable', async () => {
    const { GET } = await import('@/app/api/health/route');
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
    expect(body.redis).toBe('connected');
  });
});
