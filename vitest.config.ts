import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { config } from 'dotenv';

// Load local dev env so integration tests can reach Supabase (swara_test schema).
// setup.ts then swaps swara_dev → swara_test in the DATABASE_URL.
config({ path: '.env.development.local', override: false });

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
