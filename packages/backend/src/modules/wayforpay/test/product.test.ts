import { describe, expect, test } from 'vitest';

import {
  productNameFor,
  SUBSCRIPTION_PRODUCT_NAME,
} from '@/modules/wayforpay/product.js';

describe('productNameFor', () => {
  test.each(['P1M', 'P4W', 'P2W', 'P1Y', 'P30D'])(
    'a subscription is the community subscription whatever its period (%s)',
    (period) => {
      expect(productNameFor({ recurring: true, period })).toBe(
        SUBSCRIPTION_PRODUCT_NAME,
      );
    },
  );

  test('the name says monthly and names the community', () => {
    expect(SUBSCRIPTION_PRODUCT_NAME).toBe(
      'Monthly subscription to the NextTick Guild community',
    );
  });

  test('a one-time purchase keeps its period-stamped label', () => {
    expect(productNameFor({ recurring: false, period: 'P0D' })).toBe(
      'Payment P0D',
    );
  });
});
