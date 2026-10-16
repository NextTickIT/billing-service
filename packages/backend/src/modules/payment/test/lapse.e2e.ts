import { SqlClient } from '@effect/sql';
import { PaymentStatus } from '@billing-service/shared';
import { Effect } from 'effect';

import {
  type EffectScenario,
  expectRows,
  HOUR,
  seedSub,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { lapseNotify } from '@/modules/payment/cancel.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';

/**
 * CR1: the lapse guard is "still due on the date it was enqueued for", never the DB
 * clock. The key `lapse:{id}:{dueMs}` dedupes forever, so a lapse that ran before the DB
 * clock reached the due date (app clock ahead of it) and no-op'd would leave the sub
 * cancel-pending and due for good. Due an hour in the DB's FUTURE here, it still flips;
 * the same message for a due date the row no longer has (a defer moved it) does nothing.
 */
const driveLapse = (externalUserId: string, dueOffsetMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const subs = makePaymentRepo(sql);
    const due = new Date(Date.now() + HOUR);
    const sub = yield* seedSub(subs, { externalUserId, end: due });
    yield* subs.requestCancel(sub.id);
    yield* lapseNotify(
      subs,
      (yield* Outbox).publish,
    )({
      paymentId: sub.id,
      externalUserId,
      dueAt: due.getTime() + dueOffsetMs,
    });
    return sub.id;
  });

const lapseAheadOfDbClock: EffectScenario = {
  name: 'lapse (CR1): a lapse for the enqueued due date flips even before the DB clock reaches it',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const subId = await run(driveLapse('sp:cr1', 0));
      await expectRows(query, [
        [
          `SELECT status FROM payments`,
          String(PaymentStatus.Cancelled),
          'cancelled although nextPaymentDate > now()',
        ],
        [
          `SELECT string_agg(id, ',') FROM domain_events WHERE name = 'renewal_failed'`,
          `evt_${subId}_cancel_lapsed`,
          'exactly one renewal_failed',
        ],
      ]);
    }),
};

const lapseForMovedDueDate: EffectScenario = {
  name: 'lapse (CR1): a lapse for a due date the row no longer has is a no-op',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      await run(driveLapse('sp:cr1-stale', -24 * HOUR));
      await expectRows(query, [
        [
          `SELECT status FROM payments`,
          String(PaymentStatus.Active),
          'still active (cancel-pending)',
        ],
        [`SELECT count(*) FROM domain_events`, '0', 'no event'],
      ]);
    }),
};

export const lapseScenarios: readonly EffectScenario[] = [
  lapseAheadOfDbClock,
  lapseForMovedDueDate,
];
