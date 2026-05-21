// The ONLY file in the codebase allowed to read process.env directly.
// All other code imports the typed `config` from "@/config".
// The no-restricted-syntax rule is disabled for this file in eslint.config.mjs.
// Add a new env var here AND in src/config/index.ts when a story needs it.

export const rawEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
};
