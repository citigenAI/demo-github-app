import { z } from 'zod';
import { rawEnv } from './env';

const ConfigSchema = z
  .object({
    env: z.enum(['development', 'test', 'production']),
    database: z.object({
      url: z.string().url(),
    }),
    redis: z.object({
      url: z.string().url(),
    }),
    app: z.object({
      publicUrl: z.string().url(),
    }),
    auth: z.object({
      secret: z.string().min(32),
      url: z.string().url(),
      // Parsed now for the seam; enforced in Story 7
      adminEmailDomains: z.array(z.string()),
    }),
    email: z.object({
      smtpHost: z.string().default('localhost'),
      smtpPort: z.coerce.number().default(1025),
      resendApiKey: z.string().optional(),
      fromAddress: z.string(),
    }),
    contributor: z.object({
      rateLimitMax: z.coerce.number().int().positive().default(5),
      rateLimitWindowSec: z.coerce.number().int().positive().default(600),
    }),
    stripe: z.object({
      secretKey: z.string().optional(),
      publishableKey: z.string().optional(),
      webhookSecret: z.string().optional(),
    }),
  })

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse({
    env: rawEnv.NODE_ENV ?? 'development',
    database: { url: rawEnv.DATABASE_URL },
    redis: { url: rawEnv.REDIS_URL },
    app: { publicUrl: rawEnv.NEXT_PUBLIC_APP_URL },
    auth: {
      secret: rawEnv.NEXTAUTH_SECRET,
      url: rawEnv.NEXTAUTH_URL,
      adminEmailDomains: rawEnv.ADMIN_EMAIL_DOMAINS
        ? rawEnv.ADMIN_EMAIL_DOMAINS.split(',').map((d) => d.trim()).filter(Boolean)
        : [],
    },
    email: {
      smtpHost: rawEnv.SMTP_HOST,
      smtpPort: rawEnv.SMTP_PORT,
      resendApiKey: rawEnv.RESEND_API_KEY || undefined,
      fromAddress: rawEnv.RESEND_FROM_ADDRESS,
    },
    contributor: {
      rateLimitMax: rawEnv.CONTRIB_RATELIMIT_MAX,
      rateLimitWindowSec: rawEnv.CONTRIB_RATELIMIT_WINDOW_SEC,
    },
    stripe: {
      secretKey: rawEnv.STRIPE_SECRET_KEY || undefined,
      publishableKey: rawEnv.STRIPE_PUBLISHABLE_KEY || undefined,
      webhookSecret: rawEnv.STRIPE_WEBHOOK_SECRET || undefined,
    },
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration. Check your .env file.\n${issues}\n\n` +
        `See .env.example for the required variables.`,
    );
  }

  return parsed.data;
}

export const config = loadConfig();
