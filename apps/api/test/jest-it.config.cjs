/**
 * Integration tests — *.it-spec.ts on a real Testcontainers (Postgres + GreenMail)
 * harness. Suites self-skip gracefully when the Docker daemon is unreachable.
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
  // Each suite spins its own Postgres/GreenMail container. Running suites in
  // parallel starves Docker and makes them flake (connection resets); serialize.
  maxWorkers: 1,
};
