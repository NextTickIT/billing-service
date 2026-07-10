import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: 'backend',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // @fastify/autoload dynamically import()s the plugin/module files from
    // disk. Inlining it routes those imports through Vitest's transform so the
    // `@/` alias resolves there too (production uses tsc-alias, dev uses tsx).
    server: {
      deps: {
        inline: ['@fastify/autoload'],
      },
    },
  },
});
