/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
      },
    ],
    '^.+\\.js$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'ecmascript' },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  transformIgnorePatterns: [],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 60_000,
  maxWorkers: 1,
  roots: ['<rootDir>/tests/e2e'],
  testMatch: ['<rootDir>/tests/e2e/**/*.test.ts'],
};
