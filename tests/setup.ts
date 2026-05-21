// Ensure required env vars are set before any module that reads config is imported.
// Individual tests may override these via vi.stubEnv.
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV ??= 'test';
env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/swara_test';
env.REDIS_URL ??= 'redis://localhost:6379';
env.NEXT_PUBLIC_APP_URL ??= 'http://localhost:3000';
