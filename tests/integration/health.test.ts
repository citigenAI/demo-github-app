import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Integration test for /api/health against real Supabase swara_test DB.
 * Redis check is lenient — locally Redis may not be running (fail-open).
 * Skipped when SKIP_INTEGRATION=true (CI without infra).
 */
const skip = process.env.SKIP_INTEGRATION === 'true';

describe.skipIf(skip)('GET /api/health', () => {
  beforeAll(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
  });

  it('reports db connected (redis may be disconnected locally)', async () => {
    const { GET } = await import('@/app/api/health/route');
    const response = await GET();
    const body = await response.json();

    // DB must be reachable; Redis may be down locally (fail-open)
    expect(body.db).toBe('connected');
    expect(['connected', 'disconnected', 'down']).toContain(body.redis);
    // Status is ok only when both are up; accept degraded locally
    expect(['ok', 'degraded']).toContain(body.status);
    expect([200, 503]).toContain(response.status);
  });
});
