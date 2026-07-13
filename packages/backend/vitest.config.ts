import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    name: 'backend',
    environment: 'node',
    // Unit/integration tests live beside the code they cover, in
    // `src/modules/{name}/test/`; `test/` holds the e2e tier only (run via tsx).
    include: ['src/**/*.test.ts'],
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
