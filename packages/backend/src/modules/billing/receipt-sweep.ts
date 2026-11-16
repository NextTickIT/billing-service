import { SqlClient, type SqlError } from '@effect/sql';
import { Duration, Effect } from 'effect';

import { reviveReceipts } from '@/infra/queue/store.js';

/** How long an approved order may stay unsettled before the sweep re-drives it. */
export const RECEIPT_GRACE_SECONDS = 10 * 60;

/** How often the sweep looks. */
export const RECEIPT_SWEEP_INTERVAL_SECONDS = 5 * 60;

/** How far back the sweep looks: an approval older than this is an operator's case. */
const RECEIPT_SWEEP_WINDOW_DAYS = 7;

/**
 * Scheduled orders whose approval credited a period (the `scheduler.advance` ledger holds
 * a non-null settlement) at least `graceSeconds` ago and whose charge has no fixation
 * yet: money taken and credited, but no success recorded or reported.
 */
export const unsettledApprovals =
  (sql: SqlClient.SqlClient) =>
  (graceSeconds: number): Effect.Effect<readonly string[], SqlError.SqlError> =>
    sql<{ readonly ref: string }>`
      SELECT k."idemKey" AS ref FROM idempotency_keys k
      WHERE k.scope = 'scheduler.advance'
        AND jsonb_typeof(k.response->'settlement') = 'object'
        AND k."createdAt" <= now() - make_interval(secs => ${graceSeconds})
        AND k."createdAt" > now() - make_interval(days => ${RECEIPT_SWEEP_WINDOW_DAYS})
        AND NOT EXISTS (
          SELECT 1 FROM charges c
          JOIN charge_fixations f ON f."incomingEventId" = c.id
          WHERE c."externalRef" = k."idemKey"
        )
      ORDER BY k."createdAt"
    `.pipe(Effect.map((rows) => rows.map((row) => row.ref)));

/**
 * Re-drive the receipts of every unsettled approved order through the ordinary pipeline:
 * its waiting or dead-lettered receipt messages become due again with a fresh budget
 * (`reviveReceipts`), and the settlement they run is the normal one, idempotent on the
 * charge's `matchResult` — so a sweep, a second sweep or two at once never write a
 * second fixation or event. Correctness of a delayed or lost receipt rests here, not on
 * the approval-time revival. An order with no receipt to revive is logged for an
 * operator (`RECEIPT_LOST`).
 */
export const sweepUnsettledReceipts =
  (sql: SqlClient.SqlClient) =>
  (graceSeconds: number): Effect.Effect<number, SqlError.SqlError> =>
    Effect.gen(function* () {
      const refs = yield* unsettledApprovals(sql)(graceSeconds);
      let revived = 0;
      for (const ref of refs) {
        const count = yield* reviveReceipts(sql)(ref);
        revived += count;
        if (count === 0) {
          yield* lostReceipt(sql, ref);
        }
      }
      return revived;
    });

/** Log an approved, unsettled order whose receipt is not waiting to be revived: none at
 * all, or one still being processed (the next sweep looks again). */
const lostReceipt = (sql: SqlClient.SqlClient, ref: string) =>
  Effect.flatMap(
    sql<{ readonly n: number }>`
      SELECT count(*)::int AS n FROM messages
      WHERE "messageType" = 'payment_event_received'
        AND payload->>'externalRef' = ${ref}
    `,
    (rows) =>
      (rows[0]?.n ?? 0) === 0
        ? Effect.logError('RECEIPT_LOST approved order has no receipt').pipe(
            Effect.annotateLogs({ orderReference: ref }),
          )
        : Effect.void,
  );

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
