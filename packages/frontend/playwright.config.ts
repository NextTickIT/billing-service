import { defineConfig, devices } from '@playwright/test';

// Two modes. Stubbed (default): Playwright starts Vite and e2e/fixtures.ts fakes
// every /api call, so the specs need no backend. Full: E2E_BASE_URL points at a
// running stack and the same specs talk to the real API.
const externalBaseUrl = process.env['E2E_BASE_URL'];
// 5174 is avoided on purpose: it is the next free Vite port, so another project's
// dev server often holds it and `reuseExistingServer` would test that app instead.
const localPort = 5179;
const localBaseUrl = `http://127.0.0.1:${String(localPort)}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  // One baseline per test file, without the per-OS suffix: the showcase keeps a
  // single PNG and accepts that another OS may need `--update-snapshots`.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: {
    baseURL: externalBaseUrl ?? localBaseUrl,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(externalBaseUrl === undefined && {
    webServer: {
      // Bind the exact host the URL names: plain `localhost` may resolve to ::1 only.
      command: `npm run dev -- --host 127.0.0.1 --port ${String(localPort)} --strictPort`,
      url: localBaseUrl,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
  }),
});
