import { defineConfig } from 'vitest/config';

// Root Vitest config. Each package contributes its own project config;
// cross-package `@billing-service/*` imports resolve through built `dist`
// (turbo `test` dependsOn `^build`), and per-package `@/` via vite-tsconfig-paths.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
  },
});
