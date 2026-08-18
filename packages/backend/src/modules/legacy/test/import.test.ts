import { it } from '@effect/vitest';
import {
  Currency,
  type Payment,
  PaymentOrigin,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type { SpPayment } from '@/modules/legacy/contracts.js';
import { importTick, type ImportDeps } from '@/modules/legacy/import.js';
import type { ExternalPayment } from '@/modules/payment/data-access.js';

const NOW = new Date('2026-08-01T00:00:00Z');

/** A minimal Payment built from the upsert input — only `id` is read downstream. */
const asPayment = (input: ExternalPayment): Payment => ({
  id: `pay_${input.externalUserId}`,
  externalUserId: input.externalUserId,
  amount: input.amount,
  currency: input.currency,
  method: input.method,
  period: input.period,
  status: input.status,
  origin: PaymentOrigin.External,
  currentPeriodStart: input.currentPeriodStart,
  currentPeriodEnd: input.currentPeriodEnd,
  nextPaymentDate: input.nextPaymentDate,
  recurringTokenRef: null,
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

interface Recorder {
  readonly upserts: ExternalPayment[];
  readonly charges: string[];
  readonly fixations: {
    readonly incomingEventId: string;
    readonly paymentId: string;
  }[];
  readonly watermarks: Date[];
}

interface Opts {
  readonly watermark?: Date;
  readonly failFor?: string;
}

const makeDeps = (payments: readonly SpPayment[], opts: Opts = {}) => {
  const rec: Recorder = {
    upserts: [],
    charges: [],
    fixations: [],
    watermarks: [],
  };
  const deps: ImportDeps = {
    client: { listPayments: () => Effect.succeed(payments) },
    payments: {
      findActiveByExternalUser: () => Effect.succeed(Option.none()),
      upsertExternal: (input) =>
        opts.failFor === input.externalUserId
          ? Effect.die('upsert failed')
          : Effect.sync(() => {
              rec.upserts.push(input);
              return asPayment(input);
            }),
    },
    charges: {
      transaction: (effect) => effect,
      upsertIncomingCharge: (charge) =>
        Effect.sync(() => {
          rec.charges.push(charge.idemKey);
          return `ch_${charge.idemKey}`;
        }),
      setMatchResult: () => Effect.void,
      insertPayment: (input) =>
        Effect.sync(() => {
          rec.fixations.push({
            incomingEventId: input.incomingEventId,
            paymentId: input.paymentId ?? '',
          });
        }),
    },
    state: {
      getWatermark: () =>
        Effect.succeed(
          opts.watermark === undefined
            ? Option.none()
            : Option.some(opts.watermark),
        ),
      upsertWatermark: (_source, watermark) =>
        Effect.sync(() => {
          rec.watermarks.push(watermark);
        }),
    },
  };
  return { deps, rec };
};

const PAYMENTS: readonly SpPayment[] = [
  {
    id: 1,
    contactId: 100,
    status: 200,
    price: { amount: 50, currency: 'USD' },
    paymentMethod: 'Wayforpay',
    createdAt: '2026-07-15T00:00:00Z',
  },
  {
    id: 2,
    contactId: 100,
    status: 200,
    price: { amount: 50, currency: 'USD' },
    paymentMethod: 'Wayforpay',
    createdAt: '2026-06-15T00:00:00Z',
  },
  {
    id: 3,
    contactId: 200,
    status: 200,
    price: { amount: 100, currency: 'UAH' },
    paymentMethod: 'Whitepay',
    createdAt: '2026-07-20T00:00:00Z',
  },
];

const upsertFor = (
  rec: Recorder,
  userId: string,
): ExternalPayment | undefined =>
  rec.upserts.find((u) => u.externalUserId === userId);

it.effect(
  'imports each contact as one external Payment with its full charge history',
  () =>
    Effect.gen(function* () {
      const { deps, rec } = makeDeps(PAYMENTS);

      const result = yield* importTick(deps, NOW);

      expect(result).toEqual({ contacts: 2, imported: 2, skipped: 0 });
      // One Payment per contact, every SendPulse payment fixed as a Charge.
      expect(rec.upserts).toHaveLength(2);
      expect(rec.charges).toEqual(['sp:1', 'sp:2', 'sp:3']);
      expect(rec.fixations).toHaveLength(3);

      const a = upsertFor(rec, 'sendpulse:100');
      expect(a?.amount).toBe(5000); // latest succeeded (id 1), major→minor
      expect(a?.currency).toBe(Currency.USD);
      expect(a?.period).toBe('P1M'); // ~30-day cadence
      expect(a?.status).toBe(PaymentStatus.Active);

      const b = upsertFor(rec, 'sendpulse:200');
      expect(b?.amount).toBe(10000);
      // Watermark advances to the newest createdAt seen.
      expect(rec.watermarks).toHaveLength(1);
      expect(rec.watermarks[0]?.toISOString()).toBe('2026-07-20T00:00:00.000Z');
    }),
);

it.effect(
  'is incremental: a watermark past the newest payment skips every contact',
  () =>
    Effect.gen(function* () {
      const { deps, rec } = makeDeps(PAYMENTS, {
        watermark: new Date('2026-07-21T00:00:00Z'),
      });

      const result = yield* importTick(deps, NOW);

      expect(result).toEqual({ contacts: 2, imported: 0, skipped: 2 });
      expect(rec.upserts).toHaveLength(0);
      expect(rec.charges).toHaveLength(0);
    }),
);

it.effect('tolerates a failing contact and still imports the rest', () =>
  Effect.gen(function* () {
    const { deps, rec } = makeDeps(PAYMENTS, { failFor: 'sendpulse:200' });

    const result = yield* importTick(deps, NOW);

    expect(result).toEqual({ contacts: 2, imported: 1, skipped: 1 });
    expect(rec.upserts).toHaveLength(1);
    expect(upsertFor(rec, 'sendpulse:100')).toBeDefined();
    expect(upsertFor(rec, 'sendpulse:200')).toBeUndefined();
  }),
);
