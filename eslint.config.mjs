// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.*', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  // LOCKED invariant #1: the raw Drizzle `db` handle may only be imported by the
  // single DB gateway (infra/db/with-actor.ts). Everything else must go through withActor().
  // The trap is installed now, before infra/db/db exists, so the rule is enforced from day one.
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/infra/db/with-actor.ts'],
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
  // i18n: no hard-coded user-facing strings in React JSX (enforced from Epic 11; rule scaffolded here).
  {
    files: ['apps/web/src/**/*.tsx'],
    rules: {
      // Placeholder for eslint-plugin-react no-literal-strings (added in Story 11.2).
    },
  },
);
