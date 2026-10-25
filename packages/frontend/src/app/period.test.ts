import { formatPeriod } from '@billing-service/shared';
import { describe, expect, it } from 'vitest';

// Tier 1, pure unit: no DOM, no Vue, just input -> output. `formatPeriod` lives in
// the shared package; the frontend tests it because the checkout page is where a
// payer reads the result.
describe('formatPeriod', () => {
  it('renders a single unit in English', () => {
    expect(formatPeriod('P1M', 'en')).toBe('1 month');
    expect(formatPeriod('P2M', 'en')).toBe('2 months');
  });

  // Ukrainian needs three plural forms; these strings are what Node's CLDR data
  // produces, so a hand-rolled rule table would be caught here.
  it.each([
    ['P1M', '1 місяць'],
    ['P2M', '2 місяці'],
    ['P5M', '5 місяців'],
    ['P1Y', '1 рік'],
    ['P30D', '30 днів'],
  ])('renders %s in Ukrainian as %s', (period, expected) => {
    expect(formatPeriod(period, 'uk')).toBe(expected);
  });

  it('joins every non-zero component of a multi-part duration', () => {
    expect(formatPeriod('P1M15D', 'en')).toBe('1 month 15 days');
    expect(formatPeriod('P1M15D', 'uk')).toBe('1 місяць 15 днів');
  });

  it('falls back to the raw string for an all-zero or unparseable period', () => {
    expect(formatPeriod('P0D', 'en')).toBe('P0D');
    expect(formatPeriod('garbage', 'uk')).toBe('garbage');
  });
});
