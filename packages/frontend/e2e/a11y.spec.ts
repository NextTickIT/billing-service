import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './fixtures.js';

// FIXME, the real page fails axe-core 4.14 today (light theme, the headless
// default; dark fails the same rules with slightly different ratios):
// - color-contrast (serious): "Ensure the contrast between foreground and
//   background colors meets WCAG 2 AA minimum contrast ratio thresholds". The
//   UK/RU switch buttons are 3.14:1, the active EN one 4.27:1, and the
//   Login/Password labels 2.76:1, all below 4.5:1.
// - landmark-one-main (moderate): "Ensure the document has a main landmark".
// - page-has-heading-one (moderate): "Ensure that the page, or at least one of
//   its frames contains a level-one heading".
// - region (moderate): "Ensure all page content is contained by landmarks". The
//   panel title and both form fields sit outside any landmark.
// The assertion stays strict on purpose. Fix the page, then drop `.fixme`.
test.fixme('the login page has no detectable accessibility violations', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en');
    localStorage.setItem('theme', 'light');
  });
  await page.goto('/operator/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});
