import { defineConfig } from 'vitest/config';

// Root Vitest config. Each package contributes its own project config;
// cross-package `@billing-service/*` imports resolve through built `dist`
// (turbo `test` dependsOn `^build`), and per-package `@/` via vite-tsconfig-paths.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
    // Reported, never enforced: a threshold would turn the teaching metric into a
    // gate that rewards tests written for the number rather than the behaviour.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/test/**',
        '**/*.test.ts',
        '**/*.e2e.ts',
        '**/migrations/**',
        '**/main.ts',
        '**/worker.ts',
        '**/db-migrate.ts',
      ],
    },
  },
});
