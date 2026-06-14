/** Unit tests (co-located *.spec.ts). Integration uses test/jest-it.config.cjs. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  setupFiles: ['<rootDir>/../test/unit-env.cjs'],
  moduleNameMapper: {
    '^@hris/shared$': '<rootDir>/../../../packages/shared/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
};
