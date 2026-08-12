import { it } from '@effect/vitest';
import {
  type CheckoutSession,
  CheckoutSessionKind,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  verifyCardChange,
  type VerifyCardChangeDeps,
} from '@/modules/checkout/domain.js';
import type { WayForPayClient } from '@/modules/wayforpay/client.js';

const cardChangeSession: CheckoutSession = {
  id: 'chk_1',
  externalUserId: 'sp:1',
  amount: 0,
  currency: 0,
  period: 'P1M',
  method: null,
  status: 0,
  kind: CheckoutSessionKind.CardChange,
  paymentId: 'pay_1',
  expiresAt: new Date(0),
  createdAt: new Date(0),
};

const repoWith = (found: CheckoutSession | null): CheckoutRepo => ({
  findById: () =>
    Effect.succeed(found === null ? Option.none() : Option.some(found)),
  insert: () => Effect.void,
  setPending: () => Effect.void,
  markCompleted: () => Effect.void,
});

const client: Pick<WayForPayClient, 'verifyPage'> = {
  verifyPage: () => Effect.succeed('<html><head></head></html>'),
};

const depsWith = (
  over: Partial<VerifyCardChangeDeps>,
): VerifyCardChangeDeps => ({
  repo: repoWith(cardChangeSession),
  client,
  cardVerifyEnabled: true,
  returnUrl: 'https://us/checkout/{orderReference}/return',
  serviceUrl: 'https://us/callback',
  ...over,
});

it.effect('returns the widget HTML for a 0-amount card-change session', () =>
  verifyCardChange(depsWith({}), 'chk_1').pipe(
    Effect.map((html) => {
      expect(html).toContain('<head>');
    }),
  ),
);

it.effect('fails CardChangeUnavailable when the verify feature is off', () =>
  verifyCardChange(depsWith({ cardVerifyEnabled: false }), 'chk_1').pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('CardChangeUnavailable');
    }),
  ),
);

it.effect('fails NotFound for an unknown session', () =>
  verifyCardChange(depsWith({ repo: repoWith(null) }), 'chk_x').pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('NotFound');
    }),
  ),
);

it.effect('fails NotFound for a normal (non-card-change) session', () =>
  verifyCardChange(
    depsWith({
      repo: repoWith({
        ...cardChangeSession,
        kind: CheckoutSessionKind.Checkout,
        amount: 30000,
      }),
    }),
    'chk_1',
  ).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('NotFound');
    }),
  ),
);

it.effect('fails NotFound for a priced (owed) card-change session', () =>
  verifyCardChange(
    depsWith({
      repo: repoWith({ ...cardChangeSession, amount: 30000 }),
    }),
    'chk_1',
  ).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('NotFound');
    }),
  ),
);
