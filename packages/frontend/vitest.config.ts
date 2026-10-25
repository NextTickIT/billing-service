import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// happy-dom gives component tests a `document`, `localStorage` and `navigator`,
// which `i18n/index.ts` reads at import time. The checkout page's server-render
// tests still pass here: `renderToString` ignores the DOM.
export default defineConfig({
  // Point the plugin at this package's tsconfig: crawling from the workspace root
  // hits a root reference to a missing frontend tsconfig.build.json and logs an error.
  plugins: [vue(), tsconfigPaths({ projects: ['./tsconfig.json'] })],
  // Same explicit alias as vite.config.ts: vite-tsconfig-paths bails on the root
  // tsconfig, so `@/` cannot rely on it alone.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'frontend',
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // Component styles carry no behaviour under test; skip processing them.
    css: false,
  },
});
