import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// The checkout page is rendered to a string (Vue's server renderer) in plain node, so
// its tests need no browser environment.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'frontend',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
