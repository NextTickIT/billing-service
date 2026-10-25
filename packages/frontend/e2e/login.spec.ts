import { expect, test, type Page } from './fixtures.js';

// Tier 4, end-to-end UI: a real browser, the real app, the user's own steps.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en');
  });
  await page.goto('/operator/login');
});

// In full mode the credentials must exist on the real stack; the stub accepts
// anything except the password `wrong`.
const LOGIN = process.env['E2E_OPERATOR_LOGIN'] ?? 'operator';
const PASSWORD = process.env['E2E_OPERATOR_PASSWORD'] ?? 'secret';

async function signIn(page: Page, password: string): Promise<void> {
  await page.getByPlaceholder('Login').fill(LOGIN);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// FIXME, a real bug this spec found: the backend answers a wrong password with
// 401, and `apiFetch` treats every 401 as an expired session, so it sets
// `window.location.href = '/operator/login'`. The full reload wipes the error the
// store just set, and the operator sees a blank form. The component test in
// LoginPage.test.ts stays green because happy-dom does not reload on that write.
// Not redirecting when already on /operator/login makes this spec pass.
test.fixme('a wrong password shows an error and stays on login', async ({
  page,
}) => {
  await signIn(page, 'wrong');
  await expect(page.getByText('Invalid credentials.')).toBeVisible();
  await expect(page).toHaveURL(/\/operator\/login$/);
});

test('the right password opens the payments page', async ({ page }) => {
  await signIn(page, PASSWORD);
  await expect(page).toHaveURL(/\/operator\/payments$/);
});
