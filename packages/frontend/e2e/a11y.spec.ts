import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './fixtures.js';

// The login page fails these axe-core 4.14 rules today (light theme; dark
// fails the same rules with slightly different ratios):
// - color-contrast (serious): the UK/RU switch buttons are 3.14:1, the active
//   EN one 4.27:1, the Login/Password labels 2.76:1 — all below 4.5:1.
// - landmark-one-main, page-has-heading-one, region (moderate): no <main>,
//   no <h1>, the panel title and both fields sit outside any landmark.
// Instead of skipping the test, the known set is the baseline: a new rule
// failing turns the test red, and fixing one of these does too, which is the
// prompt to shrink the list. The baseline can only ratchet down.
const KNOWN_VIOLATIONS = [
  'color-contrast',
  'landmark-one-main',
  'page-has-heading-one',
  'region',
];

test('the login page introduces no accessibility violation beyond the known baseline', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en');
    localStorage.setItem('theme', 'light');
  });
  await page.goto('/operator/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => v.id).sort()).toEqual(KNOWN_VIOLATIONS);
});
