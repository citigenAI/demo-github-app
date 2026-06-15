// The ONLY file in the codebase allowed to read process.env directly.
// All other code imports the typed `config` from "@/config".
// The no-restricted-syntax rule is disabled for this file in eslint.config.mjs.
// Add a new env var here AND in src/config/index.ts when a story needs it.

export const rawEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  // Auth
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  ADMIN_EMAIL_DOMAINS: process.env.ADMIN_EMAIL_DOMAINS,
  // Email
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_ADDRESS: process.env.RESEND_FROM_ADDRESS,
  // Contributor rate limiting
  CONTRIB_RATELIMIT_MAX: process.env.CONTRIB_RATELIMIT_MAX,
  CONTRIB_RATELIMIT_WINDOW_SEC: process.env.CONTRIB_RATELIMIT_WINDOW_SEC,
  // Stripe
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  // Storage (S3-compatible: MinIO dev, R2 prod)
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_REGION: process.env.S3_REGION,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
  // Media upload limits (Story 6)
  MEDIA_MAX_VIDEO_BYTES: process.env.MEDIA_MAX_VIDEO_BYTES,
  MEDIA_MAX_VOICE_BYTES: process.env.MEDIA_MAX_VOICE_BYTES,
  MEDIA_MAX_PHOTO_BYTES: process.env.MEDIA_MAX_PHOTO_BYTES,
  MEDIA_MAX_FILES_PER_SUBMISSION: process.env.MEDIA_MAX_FILES_PER_SUBMISSION,
  MEDIA_MAX_TOTAL_BYTES_PER_SUBMISSION: process.env.MEDIA_MAX_TOTAL_BYTES_PER_SUBMISSION,
};
