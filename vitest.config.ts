import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 15_000,
    include: [
      'packages/**/*.{test,spec}.ts',
      'tests/smoke/**/*.{test,spec}.ts',
      'tests/integration/**/*.{test,spec}.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'packages/domain/src/**/*.ts',
        'packages/database/src/**/*.ts',
        'packages/contracts/src/**/*.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
