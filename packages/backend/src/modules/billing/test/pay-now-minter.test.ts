import {
  type CheckoutSession,
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type NewCheckoutSession,
  type Payment,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { describe, expect, test } from 'vitest';

import type { AppConfig } from '@/config.js';
import { NO_PAY_NOW } from '@/modules/billing/events.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import { payNowMinter } from '@/worker-boot.js';

const DUE = new Date('2026-12-09T09:00:00Z');
const BASE_URL = 'https://pay.example.com';

const die = () => Effect.die('unexpected repo call');

/** An in-memory repo with the real key semantics: a held key refuses the insert and keeps
 * the first row. Only `insert` and `findByIdempotencyKey` are used by the minter. */
const fakeRepo = (planted: CheckoutSession[] = []) => {
  const rows = new Map<string, CheckoutSession>();
  const inserts: NewCheckoutSession[] = [];
  for (const row of planted) {
    if (row.idempotencyKey !== null) rows.set(row.idempotencyKey, row);
  }
  const repo = {
    insert: (input: NewCheckoutSession) =>
      Effect.sync(() => {
        if (input.idempotencyKey !== null && rows.has(input.idempotencyKey)) {
          return false;
        }
        inserts.push(input);
        if (input.idempotencyKey !== null) {
          rows.set(input.idempotencyKey, {
            ...input,
            status: CheckoutSessionStatus.Created,
            createdAt: DUE,
          } as CheckoutSession);
        }
        return true;
      }),
    findByIdempotencyKey: (key: string) =>
      Effect.sync(() => Option.fromNullable(rows.get(key))),
    findById: die,
    reissueLapsed: die,
    claimForPayment: die,
    releasePending: die,
    completeIfOpen: die,
    renameOpenSessionsExternalUser: die,
  } as unknown as CheckoutRepo;
  return { repo, inserts, rows };
};

type MinterConfig = Pick<AppConfig, 'checkoutBaseUrl'> & {
  whitepay: Pick<AppConfig['whitepay'], 'enabled'>;
  scheduler: Pick<AppConfig['scheduler'], 'manualRenewalCycleOptions'>;
};

const configOf = (
  cycles: readonly number[],
  whitepayEnabled = true,
): AppConfig =>
  ({
    checkoutBaseUrl: BASE_URL,
    whitepay: { enabled: whitepayEnabled },
    scheduler: { manualRenewalCycleOptions: cycles },
  }) satisfies MinterConfig as unknown as AppConfig;

const sub = (over: Partial<Payment> = {}): Payment => ({
  id: 'pay_1',
  externalUserId: 'sp:1',
  amount: 5000,
  currency: 1,
  method: PaymentMethod.Card,
  period: 'P1M',
  status: PaymentStatus.Active,
  recurring: true,
  currentPeriodStart: new Date('2026-11-09T09:00:00Z'),
  currentPeriodEnd: DUE,
  nextPaymentDate: DUE,
  recurringTokenRef: 'tok',
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  metadata: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const mint = (repo: CheckoutRepo, config: AppConfig, row: Payment) =>
  Effect.runSync(payNowMinter(repo, config)(row));

/** A session planted under the sub's key by something other than its own pay-now mint. */
const foreignSession = (key: string): CheckoutSession => ({
  id: 'chk_foreign',
  externalUserId: 'sp:2',
  amount: 1,
  currency: 1,
  period: 'P1M',
  method: PaymentMethod.Card,
  status: CheckoutSessionStatus.Created,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  origin: null,
  renewalOf: 'pay_other',
  options: null,
  idempotencyKey: key,
  email: '',
  metadata: null,
  expiresAt: DUE,
  createdAt: DUE,
});

describe('payNowMinter', () => {
  test('(i) one link per (sub, due date): the second call reuses the row and its stored cycles', () => {
    const { repo, inserts } = fakeRepo();
    const first = mint(repo, configOf([1, 3, 6]), sub());
    // The knob changed between the two notices: the stored row still decides.
    const second = mint(repo, configOf([1]), sub());

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      idempotencyKey: `paynow:pay_1:${DUE.getTime().toString()}`,
      origin: 'prolong',
      renewalOf: 'pay_1',
      kind: CheckoutSessionKind.Checkout,
      expiresAt: DUE,
    });
    expect(first.checkoutUrl).toMatch(/^https:\/\/pay\.example\.com\//);
    expect(second.checkoutUrl).toBe(first.checkoutUrl);
    expect(first.cycleOptions).toEqual([1, 3, 6]);
    expect(second.cycleOptions).toEqual([1, 3, 6]);
  });

  test('(ii) a moved due date gets a second key and a second row', () => {
    const { repo, inserts } = fakeRepo();
    const moved = new Date('2027-01-09T09:00:00Z');
    const first = mint(repo, configOf([1, 3, 6]), sub());
    const second = mint(
      repo,
      configOf([1, 3, 6]),
      sub({ nextPaymentDate: moved, currentPeriodEnd: moved }),
    );

    expect(inserts.map((i) => i.idempotencyKey)).toEqual([
      `paynow:pay_1:${DUE.getTime().toString()}`,
      `paynow:pay_1:${moved.getTime().toString()}`,
    ]);
    expect(inserts[1]?.expiresAt).toEqual(moved);
    expect(second.checkoutUrl).not.toBe(first.checkoutUrl);
  });

  test('(iii) the knob decides the stored options', () => {
    const single = fakeRepo();
    const one = mint(single.repo, configOf([1]), sub());
    expect(single.inserts[0]?.options).toBeNull();
    expect(one.cycleOptions).toEqual([1]);

    const triple = fakeRepo();
    const three = mint(triple.repo, configOf([1, 3, 6]), sub());
    expect(triple.inserts[0]?.options).toHaveLength(3);
    expect(three.cycleOptions).toEqual([1, 3, 6]);
  });
});

describe('payNowMinter refusals', () => {
  test('(iv) a crypto sub gets no link while WhitePay is off, a card sub still does', () => {
    const { repo, inserts } = fakeRepo();
    const config = configOf([1, 3, 6], false);

    const crypto = mint(
      repo,
      config,
      sub({ id: 'pay_c', method: PaymentMethod.Crypto }),
    );
    expect(crypto).toEqual(NO_PAY_NOW);
    expect(inserts).toHaveLength(0);

    const card = mint(repo, config, sub());
    expect(card.checkoutUrl).not.toBeNull();
    expect(inserts).toHaveLength(1);
  });

  test('(v) a foreign row under the key yields no link, no throw and no second insert', () => {
    const key = `paynow:pay_1:${DUE.getTime().toString()}`;
    const foreign = foreignSession(key);
    const { repo, inserts, rows } = fakeRepo([foreign]);

    const link = mint(repo, configOf([1, 3, 6]), sub());

    expect(link).toEqual(NO_PAY_NOW);
    expect(inserts).toHaveLength(0);
    expect(rows.get(key)).toBe(foreign);
  });
});
