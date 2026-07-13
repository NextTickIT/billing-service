import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import type { DomainEvent } from '@billing-service/shared';
import { Effect, Option } from 'effect';

import type { ErrorDetail } from '@/infra/queue/policy.js';
import type {
  DeliveryStatus,
  EventDeliveryRow,
} from '@/modules/outbox/contracts.js';

/** A delivery joined with the event it carries — everything a sink attempt needs. */
export interface DeliveryWithEvent {
  readonly deliveryId: string;
  readonly sink: string;
  readonly status: DeliveryStatus;
  readonly event: DomainEvent;
}

/**
 * Outbox persistence. `transaction` is exposed so the domain (publish) can make
 * "store the event + fan out its deliveries" atomic while staying decoupled from
 * `SqlClient` — the same seam lets tests inject a fake repo. Same `(sql) => (input)`
 * shape as the auth repo; columns camelCase double-quoted; jsonb via
 * `${JSON.stringify(x)}::jsonb`.
 */
export interface OutboxRepo {
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError.SqlError, R>;
  /** Insert the event; false if `(id)` already existed (idempotent re-publish). */
  readonly insertEvent: (
    event: DomainEvent,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly insertDelivery: (
    eventId: string,
    sink: string,
  ) => Effect.Effect<string, SqlError.SqlError>;
  readonly getDeliveryWithEvent: (
    deliveryId: string,
  ) => Effect.Effect<Option.Option<DeliveryWithEvent>, SqlError.SqlError>;
  readonly markDelivered: (
    deliveryId: string,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly markFailed: (
    deliveryId: string,
    error: ErrorDetail,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly listByStatus: (
    status: DeliveryStatus,
  ) => Effect.Effect<readonly EventDeliveryRow[], SqlError.SqlError>;
}

const requireRow = <A>(rows: readonly A[]): Effect.Effect<A> => {
  const [row] = rows;
  return row === undefined
    ? Effect.dieMessage('expected a RETURNING row')
    : Effect.succeed(row);
};

interface DeliveryEventJoin {
  readonly deliveryId: string;
  readonly sink: string;
  readonly status: DeliveryStatus;
  readonly id: string;
  readonly name: DomainEvent['name'];
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly externalUserId: string | null;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

/** A flat join row back into the nested delivery+event shape. */
const toDeliveryWithEvent = (r: DeliveryEventJoin): DeliveryWithEvent => ({
  deliveryId: r.deliveryId,
  sink: r.sink,
  status: r.status,
  event: {
    id: r.id,
    name: r.name,
    occurredAt: r.occurredAt,
    correlationId: r.correlationId,
    externalUserId: r.externalUserId,
    aggregateId: r.aggregateId,
    payload: r.payload,
  },
});

const insertEvent = (sql: SqlClient.SqlClient) => (event: DomainEvent) =>
  sql<{ readonly id: string }>`
    INSERT INTO domain_events
      (id, name, "occurredAt", "correlationId", "externalUserId", "aggregateId", payload)
    VALUES
      (${event.id}, ${event.name}, ${event.occurredAt}, ${event.correlationId},
       ${event.externalUserId}, ${event.aggregateId}, ${JSON.stringify(event.payload)}::jsonb)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `.pipe(Effect.map((rows) => rows.length > 0));

const insertDelivery =
  (sql: SqlClient.SqlClient) => (eventId: string, sink: string) =>
    sql<{ readonly id: string }>`
      INSERT INTO event_deliveries ("eventId", sink)
      VALUES (${eventId}, ${sink})
      RETURNING id
    `.pipe(
      Effect.flatMap(requireRow),
      Effect.map((row) => row.id),
    );

const getDeliveryWithEvent =
  (sql: SqlClient.SqlClient) => (deliveryId: string) =>
    sql<DeliveryEventJoin>`
      SELECT d.id AS "deliveryId", d.sink, d.status,
             e.id, e.name, e."occurredAt", e."correlationId",
             e."externalUserId", e."aggregateId", e.payload
      FROM event_deliveries d
      JOIN domain_events e ON e.id = d."eventId"
      WHERE d.id = ${deliveryId}
    `.pipe(
      Effect.map((rows) => Option.fromNullable(rows[0])),
      Effect.map(Option.map(toDeliveryWithEvent)),
    );

const markDelivered = (sql: SqlClient.SqlClient) => (deliveryId: string) =>
  sql`
    UPDATE event_deliveries
    SET status = 'delivered', "deliveredAt" = now(), "updatedAt" = now()
    WHERE id = ${deliveryId}
  `.pipe(Effect.asVoid);

const markFailed =
  (sql: SqlClient.SqlClient) => (deliveryId: string, error: ErrorDetail) =>
    sql`
      UPDATE event_deliveries
      SET status = 'failed',
          "attemptCount" = "attemptCount" + 1,
          "lastError" = ${JSON.stringify(error)}::jsonb,
          "updatedAt" = now()
      WHERE id = ${deliveryId}
    `.pipe(Effect.asVoid);

const listByStatus = (sql: SqlClient.SqlClient) => (status: DeliveryStatus) =>
  sql<EventDeliveryRow>`
    SELECT id, "eventId", sink, status, "attemptCount", "deliveredAt", "createdAt"
    FROM event_deliveries
    WHERE status = ${status}
    ORDER BY "createdAt" DESC
    LIMIT 200
  `;

export const makeOutboxRepo = (sql: SqlClient.SqlClient): OutboxRepo => ({
  transaction: (effect) => sql.withTransaction(effect),
  insertEvent: insertEvent(sql),
  insertDelivery: insertDelivery(sql),
  getDeliveryWithEvent: getDeliveryWithEvent(sql),
  markDelivered: markDelivered(sql),
  markFailed: markFailed(sql),
  listByStatus: listByStatus(sql),
});
