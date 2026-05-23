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
  })
  .superRefine((data, ctx) => {
    if (data.env === 'production' && !data.email.resendApiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['email', 'resendApiKey'],
        message: 'RESEND_API_KEY is required in production',
      });
    }
  });

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
