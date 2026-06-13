/**
 * Integration tests — *.it-spec.ts. Real Testcontainers (Postgres + GreenMail)
 * harness lands in Story 1.3; for now this config runs the smoke it-spec so the
 * `test:it` script and CI wiring are exercised end-to-end.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  setupFiles: ['<rootDir>/it-env.cjs'],
  testRegex: '.*\\.it-spec\\.ts$',
  moduleNameMapper: {
    '^@hris/shared$': '<rootDir>/../../../packages/shared/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  testTimeout: 60000,
};
