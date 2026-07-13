import { it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { describe, expect, test } from 'vitest';

import type { IncomingPaymentEvent } from '@/modules/payments/contracts.js';
import type { WayForPayClient } from '@/modules/wayforpay/client.js';
import type { W4pTransaction } from '@/modules/wayforpay/contracts.js';
import type { PollerStateRepo } from '@/modules/wayforpay/poller-state.js';
import {
  backfill,
  computeWindow,
  pollTick,
  type PollerConfig,
} from '@/modules/wayforpay/poller.js';

const config: PollerConfig = {
  account: 'acc',
  pollIntervalSeconds: 120,
  windowOverlapSeconds: 900,
  maxWindowSeconds: 21600,
};

describe('computeWindow', () => {
  test('with no watermark, bootstraps 24h back with overlap', () => {
    const now = 1_000_000;
    const w = computeWindow(null, now, config);
    expect(w.dateBegin).toBe(now - 86400 - 900);
    // 24h back is within maxWindow of now, so dateEnd is capped at start+maxWindow.
    expect(w.dateEnd).toBe(now - 86400 + 21600);
  });

  test('a watermark near now yields a window ending at now', () => {
    const now = 1_000_500;
    const w = computeWindow(1_000_000, now, config);
    expect(w.dateBegin).toBe(1_000_000 - 900);
    expect(w.dateEnd).toBe(now);
  });

  test('a far-behind watermark advances by at most maxWindow (bounded catch-up)', () => {
    const w = computeWindow(0, 10_000_000, config);
    expect(w.dateEnd).toBe(0 + 21600);
  });
});

const tx = (type: string, ref: string): W4pTransaction => ({
  transactionType: type,
  orderReference: ref,
  createdDate: '1',
  amount: '1',
  currency: 'UAH',
  transactionStatus: 'Approved',
});

const fakeClient = (batches: readonly (readonly W4pTransaction[])[]) => {
  let call = 0;
  const client: Pick<WayForPayClient, 'transactionList'> = {
    transactionList: () =>
      Effect.sync(() => {
        const batch = batches[call] ?? [];
        call += 1;
        return batch;
      }),
  };
  return { client, callCount: () => call };
};

const fakeState = () => {
  let watermark: number | null = null;
  const repo: PollerStateRepo = {
    getWatermark: () => Effect.succeed(Option.fromNullable(watermark)),
    upsertWatermark: (_account, value) =>
      Effect.sync(() => {
        watermark = value;
      }),
  };
  return { repo, get: () => watermark };
};

it.effect(
  'pollTick ingests payment rows, skips others, advances the watermark',
  () =>
    Effect.gen(function* () {
      const ingested: IncomingPaymentEvent[] = [];
      const { client } = fakeClient([
        [tx('PURCHASE', 'o1'), tx('SETTLE', 'o2'), tx('CHARGE', 'o3')],
      ]);
      const state = fakeState();

      const result = yield* pollTick(
        {
          client,
          ingest: (event) =>
            Effect.sync(() => {
              ingested.push(event);
            }),
          state: state.repo,
        },
        config,
      );

      expect(result.ingested).toBe(2);
      expect(result.skipped).toBe(1);
      expect(ingested.map((e) => e.externalRef)).toEqual(['o1', 'o3']);
      expect(state.get()).not.toBeNull();
    }),
);

it.effect('backfill walks newest-first and stops after N empty chunks', () =>
  Effect.gen(function* () {
    // 150 days ⇒ 5 chunks; only the newest has rows, so it must stop early.
    const { client, callCount } = fakeClient([[tx('PURCHASE', 'o1')]]);
    const ingested: IncomingPaymentEvent[] = [];
    const day = 24 * 60 * 60;

    const result = yield* backfill(
      {
        client,
        ingest: (event) =>
          Effect.sync(() => {
            ingested.push(event);
          }),
        state: fakeState().repo,
      },
      0,
      150 * day,
      2,
    );

    expect(result.ingested).toBe(1);
    // rows chunk + 2 empty chunks → stops at call 3, leaving 2 of 5 chunks unscanned.
    expect(callCount()).toBe(3);
  }),
);
