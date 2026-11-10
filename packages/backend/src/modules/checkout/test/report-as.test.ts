import { CreateCheckoutSession } from '@billing-service/shared';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { callerOrigin } from '@/modules/checkout/routes.js';

/** What `createSession` stores as `origin` for a create body, decoded as the route does. */
const originOf = (reportAs?: string) =>
  callerOrigin(
    Schema.decodeUnknownSync(CreateCheckoutSession)({
      externalUserId: '1001',
      amount: 5000,
      currency: 1,
      period: 'P1M',
      ...(reportAs === undefined ? {} : { reportAs }),
    }).reportAs,
  );

describe('createSession origin from reportAs', () => {
  it('"initial" stores no origin, like an absent field', () => {
    expect(originOf('initial')).toBeNull();
    expect(originOf()).toBeNull();
  });

  it('"renewal" stores origin migration', () => {
    expect(originOf('renewal')).toBe('migration');
  });
});
