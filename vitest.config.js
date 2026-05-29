import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    // 60s first-run grace for the embedded-postgres binary fetch / migration.
    testTimeout: 60000,
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      // server.js is the process entrypoint (calls app.listen + start()); excluded by convention.
      exclude: ['src/server.js'],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
});
