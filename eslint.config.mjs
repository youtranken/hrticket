// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import i18next from 'eslint-plugin-i18next';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.*', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // CommonJS Node scripts (.cjs configs, test env setup) — provide node globals.
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
      },
    },
  },
  // LOCKED invariant #1: the raw Drizzle `db` handle may only be imported by the
  // single DB gateway (infra/db/with-actor.ts). Everything else must go through withActor().
  // The trap is installed now, before infra/db/db exists, so the rule is enforced from day one.
  {
    files: ['apps/api/src/**/*.ts'],
    // with-actor is THE gateway; cli/* are out-of-band host scripts (break-glass).
    ignores: ['apps/api/src/infra/db/with-actor.ts', 'apps/api/src/cli/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infra/db/db', '**/infra/db/db.js', '**/infra/db/client'],
              message:
                'Do not import the raw `db` handle. All DB access must go through withActor() in infra/db/with-actor.ts (architecture invariant — see CLAUDE.md #1).',
            },
          ],
        },
      ],
    },
  },
  // i18n (Story 11.2): no hard-coded user-facing text in React JSX. `jsx-text-only`
  // mode flags rendered text nodes (e.g. `<Button>Lưu</Button>`) while leaving props,
  // object keys, classNames, and aria-labels alone — so adding a literal label is a
  // lint error, but the machinery strings stay quiet.
  {
    files: ['apps/web/src/**/*.tsx'],
    ignores: ['apps/web/src/**/*.{test,spec}.tsx'],
    plugins: { i18next },
    rules: {
      // `words.exclude` lets through decorative, language-neutral glyph-only nodes
      // (e.g. a dropdown caret ▾ or a ⋮ overflow trigger) — any node containing a
      // letter still needs a t() key.
      'i18next/no-literal-string': ['error', { mode: 'jsx-text-only', words: { exclude: ['^\\W*$'] } }],
    },
  },
);
