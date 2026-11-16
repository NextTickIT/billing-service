import { SqlClient, type SqlError } from '@effect/sql';
import { Duration, Effect } from 'effect';

import { reviveReceipts } from '@/infra/queue/store.js';

/** How long an approved order may stay unsettled before the sweep re-drives it. */
export const RECEIPT_GRACE_SECONDS = 10 * 60;

/** How often the sweep looks. */
export const RECEIPT_SWEEP_INTERVAL_SECONDS = 5 * 60;

/** How many orders one pass takes, oldest approval first: the bound on a pass's work. */
export const RECEIPT_SWEEP_BATCH = 100;

/** How many times the sweep re-drives one order before it hands it to a person. */
export const RECEIPT_SWEEP_MAX_REVIVALS = 3;

/** The ledger scope the sweep keeps its per-order record under. */
const SWEEP_SCOPE = 'receipt-sweep';

/** What the sweep decides for one unsettled order. */
export type SweepAction = 'revive' | 'wait' | 'alert';

/** The facts the sweep decides on, for one approved order with no fixation. */
export interface UnsettledOrder {
  readonly ref: string;
  /** Receipts the sweep may revive: waiting, or dead-lettered for an ordinary reason. */
  readonly revivable: number;
  /** Receipts a worker will take without the sweep (pending or in progress). */
  readonly live: number;
  /** How many times the sweep has revived this order already. */
  readonly revivals: number;
}

/**
 * One order's next step. A receipt still in a worker's hands is left to it (`wait`). A
 * revivable one is re-driven while the sweep has revived the order fewer than
 * RECEIPT_SWEEP_MAX_REVIVALS times. Anything else — no receipt at all, only receipts
 * that can never decode, or an order that keeps failing — goes to a person (`alert`).
 */
export const sweepAction = (order: UnsettledOrder): SweepAction => {
  if (order.live > 0) return 'wait';
  if (order.revivable > 0 && order.revivals < RECEIPT_SWEEP_MAX_REVIVALS) {
    return 'revive';
  }
  return 'alert';
};

/**
 * Scheduled orders whose approval credited a period (the `scheduler.advance` ledger holds
 * a non-null settlement) at least `graceSeconds` ago, with no fixation yet and not
 * already handed to a person: money taken and credited, but no success recorded. No age
 * limit: oldest first, `limit` per pass, so an old order is never dropped.
 */
export const unsettledOrders =
  (sql: SqlClient.SqlClient) =>
  (
    graceSeconds: number,
    limit: number,
  ): Effect.Effect<readonly UnsettledOrder[], SqlError.SqlError> =>
    sql<UnsettledOrder>`
      SELECT k."idemKey" AS ref,
        (SELECT count(*)::int FROM messages m
          WHERE m."messageType" = 'payment_event_received'
            AND m.payload->>'externalRef' = k."idemKey"
            AND m.status IN ('retry', 'fail')
            AND NOT EXISTS (
              SELECT 1 FROM attempts a
              WHERE a."messageId" = m.id AND a.error->>'code' = 'receipt_undecodable'
            )) AS revivable,
        (SELECT count(*)::int FROM messages m
          WHERE m."messageType" = 'payment_event_received'
            AND m.payload->>'externalRef' = k."idemKey"
            AND m.status IN ('pending', 'in_progress')) AS live,
        coalesce((s.response->>'revivals')::int, 0) AS revivals
      FROM idempotency_keys k
      LEFT JOIN idempotency_keys s ON s.scope = ${SWEEP_SCOPE} AND s."idemKey" = k."idemKey"
      WHERE k.scope = 'scheduler.advance'
        AND jsonb_typeof(k.response->'settlement') = 'object'
        AND k."createdAt" <= now() - make_interval(secs => ${graceSeconds})
        AND coalesce((s.response->>'alerted')::boolean, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM charges c
          JOIN charge_fixations f ON f."incomingEventId" = c.id
          WHERE c."externalRef" = k."idemKey"
        )
      ORDER BY k."createdAt"
      LIMIT ${limit}
    `;

/** Record the sweep's state for an order (its revivals, and whether a person was told). */
const recordSweep = (
  sql: SqlClient.SqlClient,
  ref: string,
  state: { readonly revivals: number; readonly alerted: boolean },
) =>
  sql`
    INSERT INTO idempotency_keys (scope, "idemKey", response)
    VALUES (${SWEEP_SCOPE}, ${ref}, ${JSON.stringify(state)}::jsonb)
    ON CONFLICT (scope, "idemKey") DO UPDATE SET response = EXCLUDED.response
  `.pipe(Effect.asVoid);

/**
 * Tell a person, once per order: the watchdog (billing-service-deploy `watchdog/watch.sh`)
 * tails the logs and pages Telegram on `SETTLEMENT_ANOMALY` — money taken and credited,
 * but its success not recorded or reported. The record written in the same transaction
 * keeps a later pass from paging again and from selecting the order.
 */
const alertOnce = (sql: SqlClient.SqlClient, order: UnsettledOrder) =>
  sql.withTransaction(
    recordSweep(sql, order.ref, {
      revivals: order.revivals,
      alerted: true,
    }).pipe(
      Effect.andThen(
        Effect.logError(
          'SETTLEMENT_ANOMALY receipt sweep: approved order cannot be settled',
        ).pipe(
          Effect.annotateLogs({
            orderReference: order.ref,
            revivals: order.revivals,
            receipts: order.revivable,
          }),
        ),
      ),
    ),
  );

/** Re-drive one order: record the revival and make its receipts due, together. */
const reviveOnce = (sql: SqlClient.SqlClient, order: UnsettledOrder) =>
  sql.withTransaction(
    recordSweep(sql, order.ref, {
      revivals: order.revivals + 1,
      alerted: false,
    }).pipe(Effect.andThen(reviveReceipts(sql)(order.ref))),
  );

/**
 * One pass. Each unsettled order is re-driven through the ordinary, idempotent pipeline
 * (its waiting or dead-lettered receipts become due again with a fresh budget,
 * `reviveReceipts`), so a pass, a second pass or two at once never write a second
 * fixation or event; or, when it cannot be, handed to a person once (`alertOnce`). The
 * correctness of a late or lost receipt rests here, not on the approval-time revival.
 * Returns how many receipts it revived.
 */
export const sweepUnsettledReceipts =
  (sql: SqlClient.SqlClient) =>
  (
    graceSeconds: number,
    limit = RECEIPT_SWEEP_BATCH,
  ): Effect.Effect<number, SqlError.SqlError> =>
    Effect.gen(function* () {
      const orders = yield* unsettledOrders(sql)(graceSeconds, limit);
      let revived = 0;
      for (const order of orders) {
        const action = sweepAction(order);
        if (action === 'revive') {
          revived += yield* reviveOnce(sql, order);
        } else if (action === 'alert') {
          yield* alertOnce(sql, order);
        }
      }
      return revived;
    });

/** The sweep, forever, every `intervalSeconds`; a failed pass is logged and the next
 * one runs. */
export const runReceiptSweep = (
  sql: SqlClient.SqlClient,
  config: {
    readonly intervalSeconds: number;
    readonly graceSeconds: number;
  },
): Effect.Effect<never> =>
  sweepUnsettledReceipts(sql)(config.graceSeconds).pipe(
    Effect.tap((revived) =>
      revived > 0
        ? Effect.logWarning('RECEIPT_SWEEP revived unsettled receipts').pipe(
            Effect.annotateLogs({ revived }),
          )
        : Effect.void,
    ),
    Effect.catchAllCause((cause) =>
      Effect.logError('receipt sweep failed').pipe(
        Effect.annotateLogs('cause', String(cause)),
      ),
    ),
    Effect.andThen(Effect.sleep(Duration.seconds(config.intervalSeconds))),
    Effect.forever,
  );
