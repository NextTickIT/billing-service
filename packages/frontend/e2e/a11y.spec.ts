import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './fixtures.js';

// The login page fails these axe-core 4.14 rules today (light theme; dark
// fails the same rules with slightly different ratios):
// - color-contrast (serious): the UK/RU switch buttons are 3.14:1, the active
//   EN one 4.27:1, the Login/Password labels 2.76:1 — all below 4.5:1.
// - landmark-one-main, page-has-heading-one, region (moderate): no <main>,
//   no <h1>, the panel title and both fields sit outside any landmark.
// Instead of skipping the test, the known set is the baseline, as rule id plus
// the number of offending nodes: a new rule, one more offending element, or
// one fixed element all turn the test red, which is the prompt to update the
// list. The baseline can only ratchet down. (It does not pin which elements
// offend; a swap of one bad node for another of the same rule passes.)
const KNOWN_VIOLATIONS = [
  { id: 'color-contrast', nodes: 5 },
  { id: 'landmark-one-main', nodes: 1 },
  { id: 'page-has-heading-one', nodes: 1 },
  { id: 'region', nodes: 3 },
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
  const found = violations
    .map((v) => ({ id: v.id, nodes: v.nodes.length }))
    .sort((a, b) => a.id.localeCompare(b.id));
  expect(found).toEqual(KNOWN_VIOLATIONS);
});
