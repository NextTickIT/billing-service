import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import {
  CheckoutSessionKind,
  type CheckoutOrigin,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect } from 'effect';

import type { AppConfig } from '@/config.js';
import {
  ledgerClaimAdvance,
  scheduleTick,
} from '@/modules/billing/scheduler.js';
import {
  captureLogs,
  DAY,
  type EffectScenario,
  expectRows,
  HOUR,
  seedSub,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { manualCheckoutMinter } from '@/worker-boot.js';

/**
 * The manual minter reuses its cycle's session by the key `manual:{subId}:{anchorMs}`.
 * The key itself proves ownership, so a reused session whose contact was remapped (docs/31
 * renames only open sessions) or that the 0021 backfill left unlabelled is still sent.
 * A row under the key that renews another sub, for another purpose, is never sent, and
 * the alert fires; either way the ladder advances, so dunning never stalls.
 */
interface Holder {
  readonly externalUserId: string;
  readonly origin: CheckoutOrigin | null;
  readonly renewalOf: string | null;
}

const driveTick = (config: AppConfig, holder: Holder) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const subs = makePaymentRepo(sql);
    // PastDue, mid-ladder (attempt 1 of the cycle that started a day ago), due now.
    const anchor = new Date(Date.now() - DAY);
    const sub = yield* seedSub(subs, {
      externalUserId: 'sp:minter',
      end: anchor,
      status: PaymentStatus.PastDue,
      token: null,
      firstFailureAt: anchor,
      retryAttempt: 1,
      nextPaymentDate: new Date(Date.now() - HOUR),
    });
    yield* makeCheckoutRepo(sql).insert({
      id: 'chk_held',
      externalUserId: holder.externalUserId,
      amount: 30000,
      currency: 0,
      period: 'P4W',
      method: 1,
      email: '',
      kind: CheckoutSessionKind.Checkout,
      recurring: true,
      paymentId: null,
      successUrl: null,
      failureUrl: null,
      promo: null,
      renewal: null,
      origin: holder.origin,
      renewalOf: holder.renewalOf,
      idempotencyKey: `manual:${sub.id}:${anchor.getTime().toString()}`,
      expiresAt: new Date(Date.now() + DAY),
    });
    const die = () => Effect.die('unused on a manual renewal');
    yield* scheduleTick(
      {
        subs,
        client: { charge: die },
        ingest: die,
        publish: (yield* Outbox).publish,
        lapse: die,
        upstreamCancelled: () => Effect.succeed(false),
        cancelUpstream: die,
        claimAdvance: ledgerClaimAdvance(sql),
        createManualCheckout: manualCheckoutMinter(sql, config),
      },
      { intervalSeconds: 60, batchSize: 10, upcomingChargeNoticeDays: [] },
    );
  });

const ladderAdvanced = [
  `SELECT "retryAttempt"::text FROM payments`,
  '2',
  'the ladder advanced to the next attempt',
] as const;

const remappedContactStillPrompted: EffectScenario = {
  name: 'manual minter: a reused session of a remapped contact (no origin) is still sent; the ladder advances',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      await run(
        driveTick(config, {
          externalUserId: 'sp:minter-before-remap',
          origin: null,
          renewalOf: null,
        }),
      );
      await expectRows(query, [
        [
          `SELECT (payload->>'checkoutUrl' LIKE '%/checkout/chk_held')::text
             FROM domain_events WHERE name = 'payment_manual_required'`,
          'true',
          'the prompt carries the reused session link',
        ],
        ladderAdvanced,
      ]);
    }),
};

const foreignHolderWithheld: EffectScenario = {
  name: 'manual minter: a foreign session under the key is never sent, the ladder still advances, and it alerts',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const logs = captureLogs();
      await run(
        driveTick(config, {
          externalUserId: 'sp:someone-else',
          origin: 'prolong',
          renewalOf: 'pay_other',
        }).pipe(Effect.provide(logs.layer)),
      );
      await expectRows(query, [
        [
          `SELECT count(*) FROM domain_events WHERE name = 'payment_manual_required'`,
          '0',
          'no prompt with the foreign link',
        ],
        ladderAdvanced,
      ]);
      assert.ok(
        logs.lines.some((line) =>
          line.includes(
            'SETTLEMENT_ANOMALY manual checkout: idempotency key held by a foreign session',
          ),
        ),
        'the watchdog marker is logged',
      );
    }),
};

export const manualMinterScenarios: readonly EffectScenario[] = [
  remappedContactStillPrompted,
  foreignHolderWithheld,
];
