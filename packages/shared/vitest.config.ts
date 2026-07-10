import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: 'shared',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
