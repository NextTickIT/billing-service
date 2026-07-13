import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { Effect } from 'effect';

import type { IncomingPaymentEvent } from '@/modules/payments/contracts.js';

/** How an incoming event resolved, cached on the row for the operator/audit. */
export type MatchOutcome = 'unmatched' | 'matched' | 'quarantined';

export interface NewPayment {
  readonly incomingEventId: string;
  readonly subscriptionId: string;
  readonly externalUserId: string;
  readonly amount: number;
  readonly currency: number;
  readonly source: string;
  readonly occurredAt: Date;
}

/**
 * Payment-pipeline persistence. `upsertIncomingEvent` is idempotent on the source
 * key and always returns the row id (so a retry after partial processing can still
 * finish); `insertPayment`/`upsertQuarantine` are idempotent too, so the whole
 * handler is safe to replay. Same `(sql) => (input)` shape as the other repos.
 */
export interface PaymentsRepo {
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError.SqlError, R>;
  readonly upsertIncomingEvent: (
    event: IncomingPaymentEvent,
  ) => Effect.Effect<string, SqlError.SqlError>;
  readonly setMatchResult: (
    id: string,
    outcome: MatchOutcome,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly insertPayment: (
    input: NewPayment,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly upsertQuarantine: (
    incomingEventId: string,
  ) => Effect.Effect<string, SqlError.SqlError>;
}

const requireRow = <A>(rows: readonly A[]): Effect.Effect<A> => {
  const [row] = rows;
  return row === undefined
    ? Effect.dieMessage('expected a RETURNING row')
    : Effect.succeed(row);
};

const upsertIncomingEvent =
  (sql: SqlClient.SqlClient) => (event: IncomingPaymentEvent) =>
    sql<{ readonly id: string }>`
      INSERT INTO incoming_payment_events
        (source, "idemKey", "externalRef", "externalUserId", amount, currency, status, "occurredAt", payload)
      VALUES
        (${event.source}, ${event.idemKey}, ${event.externalRef}, ${event.externalUserId},
         ${event.amount}, ${event.currency}, ${event.status}, ${event.occurredAt},
         ${JSON.stringify(event.payload)}::jsonb)
      ON CONFLICT ("idemKey") DO UPDATE SET "idemKey" = EXCLUDED."idemKey"
      RETURNING id
    `.pipe(
      Effect.flatMap(requireRow),
      Effect.map((row) => row.id),
    );

const setMatchResult =
  (sql: SqlClient.SqlClient) => (id: string, outcome: MatchOutcome) =>
    sql`
      UPDATE incoming_payment_events SET "matchResult" = ${outcome} WHERE id = ${id}
    `.pipe(Effect.asVoid);

const insertPayment = (sql: SqlClient.SqlClient) => (input: NewPayment) =>
  sql`
    INSERT INTO payments
      ("incomingEventId", "subscriptionId", "externalUserId", amount, currency, source, "occurredAt")
    VALUES
      (${input.incomingEventId}, ${input.subscriptionId}, ${input.externalUserId},
       ${input.amount}, ${input.currency}, ${input.source}, ${input.occurredAt})
    ON CONFLICT ("incomingEventId") DO NOTHING
  `.pipe(Effect.asVoid);

const upsertQuarantine =
  (sql: SqlClient.SqlClient) => (incomingEventId: string) =>
    sql<{ readonly id: string }>`
      INSERT INTO quarantine_records ("incomingEventId")
      VALUES (${incomingEventId})
      ON CONFLICT ("incomingEventId") DO UPDATE SET status = quarantine_records.status
      RETURNING id
    `.pipe(
      Effect.flatMap(requireRow),
      Effect.map((row) => row.id),
    );

export const makePaymentsRepo = (sql: SqlClient.SqlClient): PaymentsRepo => ({
  transaction: (effect) => sql.withTransaction(effect),
  upsertIncomingEvent: upsertIncomingEvent(sql),
  setMatchResult: setMatchResult(sql),
  insertPayment: insertPayment(sql),
  upsertQuarantine: upsertQuarantine(sql),
});
