import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'node_modules/**', 'src/generated/**', 'prisma/migrations/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Do not read process.env directly. Use the typed config: import { config } from "@/config". Raw env reads belong only in src/config/env.ts.',
        },
      ],
    },
  },
  {
    // The single file allowed to read process.env
    files: ['src/config/env.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Tests need to mutate process.env to validate config behavior
    files: ['tests/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];

export default eslintConfig;
