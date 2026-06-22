import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // CI/sandbox robustness: bind the internal API server to a literal IP so
    // test startup never depends on a 'localhost' DNS entry being present.
    api: { host: '127.0.0.1', port: 0 },
    pool: 'forks',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
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
