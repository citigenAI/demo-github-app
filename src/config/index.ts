import { z } from 'zod';
import { rawEnv } from './env';

const ConfigSchema = z.object({
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
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse({
    env: rawEnv.NODE_ENV ?? 'development',
    database: { url: rawEnv.DATABASE_URL },
    redis: { url: rawEnv.REDIS_URL },
    app: { publicUrl: rawEnv.NEXT_PUBLIC_APP_URL },
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
