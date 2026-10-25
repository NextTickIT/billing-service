import { expect, test } from './fixtures.js';

// Pin everything that changes pixels between runs: language and theme; the
// fixture already blocks the web fonts, so the baseline never depends on a CDN.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en');
    localStorage.setItem('theme', 'dark');
  });
});

test('the login page looks the same as the approved baseline', async ({
  page,
}) => {
  await page.goto('/operator/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveScreenshot('login-page.png', {
    fullPage: true,
    maxDiffPixelRatio: 0.01,
  });
});
