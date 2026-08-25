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
    // Vercel AI SDK and provider packages ship as ESM — compile them to CJS for Jest.
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
  // Do not exclude AI SDK packages from Jest transformation (they ship as ESM).
  // pnpm stores packages under node_modules/.pnpm/, and the AI SDK + its transitive
  // dependencies all ship as ESM — transform every .js file in node_modules.
  transformIgnorePatterns: [],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 30000,
  maxWorkers: '50%',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/tests/**/*.test.ts'],
  // Compile-time suites are enforced by `tsc --noEmit`, not the Jest runner.
  // E2E lives under tests/e2e and is run via jest.e2e.config.cjs.
  testPathIgnorePatterns: ['\\.compile\\.test\\.ts$', '<rootDir>/tests/e2e/'],
};
