// Ensure required env vars are set before any module that reads config is imported.
// Individual tests may override these via vi.stubEnv.
const env = process.env as Record<string, string | undefined>;
env.NODE_ENV ??= 'test';
env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/swara_test';
// Redirect dev schema → test schema so integration tests are isolated from dev data.
if (env.DATABASE_URL?.includes('schema=swara_dev')) {
  env.DATABASE_URL = env.DATABASE_URL.replace('schema=swara_dev', 'schema=swara_test');
}
if (env.DIRECT_URL?.includes('schema=swara_dev')) {
  env.DIRECT_URL = env.DIRECT_URL.replace('schema=swara_dev', 'schema=swara_test');
}
env.REDIS_URL ??= 'redis://localhost:6379';
env.NEXT_PUBLIC_APP_URL ??= 'http://localhost:3000';
// Auth stubs (Story 2+)
env.NEXTAUTH_SECRET ??= 'test-secret-that-is-long-enough-for-validation-32+chars';
env.NEXTAUTH_URL ??= 'http://localhost:3000';
env.ADMIN_EMAIL_DOMAINS ??= 'example.com';
env.SMTP_HOST ??= 'localhost';
env.SMTP_PORT ??= '1025';
env.RESEND_FROM_ADDRESS ??= 'noreply@test.com';
// Stripe stubs (Story 4+) — empty so optional in dev
env.STRIPE_SECRET_KEY ??= '';
env.STRIPE_PUBLISHABLE_KEY ??= '';
env.STRIPE_WEBHOOK_SECRET ??= '';
