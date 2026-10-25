import { expect, test } from './fixtures.js';

// Pin everything that changes pixels between runs: language, theme, and the web
// fonts, which are blocked so the baseline never depends on Google's CDN.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en');
    localStorage.setItem('theme', 'dark');
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
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
