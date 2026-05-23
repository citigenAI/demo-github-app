// Ensure required env vars are set before any module that reads config is imported.
// Individual tests may override these via vi.stubEnv.
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV ??= 'test';
env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/swara_test';
env.REDIS_URL ??= 'redis://localhost:6379';
env.NEXT_PUBLIC_APP_URL ??= 'http://localhost:3000';
// Auth stubs (Story 2+)
env.NEXTAUTH_SECRET ??= 'test-secret-that-is-long-enough-for-validation-32+chars';
env.NEXTAUTH_URL ??= 'http://localhost:3000';
env.ADMIN_EMAIL_DOMAINS ??= 'example.com';
env.SMTP_HOST ??= 'localhost';
env.SMTP_PORT ??= '1025';
env.RESEND_FROM_ADDRESS ??= 'noreply@test.com';
