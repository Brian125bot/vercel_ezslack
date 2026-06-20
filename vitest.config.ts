import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    coverage: {
      reporter: ['text', 'json-summary'],
      include: ['src/server/agent/**/*.ts']
    }
  },
  resolve: {
    alias: {
      '@': '.'
    }
  }
});
