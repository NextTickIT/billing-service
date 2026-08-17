import type { SqlError } from '@effect/sql';
import type {
  DomainEvent,
  PaymentCancelledEvent,
  PaymentDeferredEvent,
  PaymentReactivatedEvent,
  RenewalFailedEvent,
} from '@billing-service/shared';
import { Clock, Effect, Schema } from 'effect';

import type { PaymentRepo } from '@/modules/payment/data-access.js';
import {
  CancelNotify,
  DeferNotify,
  LapseNotify,
  PAYMENT_CANCEL,
  PAYMENT_DEFER,
  PAYMENT_LAPSE,
  PAYMENT_REACTIVATE,
  ReactivateNotify,
} from '@/modules/payment/contracts.js';

/**
 * Payment lifecycle notify handlers (docs/23): each decodes its queue payload,
 * (optionally persists state first,) then emits the outgoing domain event with a
 * deterministic id so a redelivered message dedupes. The outbox lives only in the
 * worker runtime, so these run there — the operator/scheduler side only enqueues.
 */

/** payment_cancelled envelope (docs/07); deterministic id so replays dedupe. */
export const paymentCancelled = (
  notify: CancelNotify,
  now: Date,
): PaymentCancelledEvent => ({
  id: `evt_sub_${notify.subscriptionId}_cancelled`,
  name: 'payment_cancelled',
  occurredAt: now,
  correlationId: notify.subscriptionId,
  externalUserId: notify.externalUserId,
  aggregateId: notify.subscriptionId,
  payload: { reason: notify.reason },
});

/** payment_reactivated envelope: a cancel reversed within the grace window. */
export const paymentReactivated = (
  notify: ReactivateNotify,
  now: Date,
): PaymentReactivatedEvent => ({
  id: `evt_${notify.paymentId}_reactivated_${notify.at.toString()}`,
  name: 'payment_reactivated',
  occurredAt: now,
  correlationId: notify.paymentId,
  externalUserId: notify.externalUserId,
  aggregateId: notify.paymentId,
  payload: {},
});

/** payment_deferred envelope: N free days granted; carries the new period end. */
export const paymentDeferred = (
  notify: DeferNotify,
  now: Date,
): PaymentDeferredEvent => ({
  id: `evt_${notify.paymentId}_deferred_${notify.at.toString()}`,
  name: 'payment_deferred',
  occurredAt: now,
  correlationId: notify.paymentId,
  externalUserId: notify.externalUserId,
  aggregateId: notify.paymentId,
  payload: { newPeriodEnd: notify.newPeriodEnd, days: notify.days },
});

/**
 * The soft-cancel due-date lapse reuses the terminal `renewal_failed` (reason
 * `cancelled`) — SendPulse already treats it as a lapse, so no new sink flow is
 * needed (docs/23). One event id per payment: the lapse fires exactly once.
 */
export const cancelLapsed = (
  notify: LapseNotify,
  now: Date,
): RenewalFailedEvent => ({
  id: `evt_${notify.paymentId}_cancel_lapsed`,
  name: 'renewal_failed',
  occurredAt: now,
  correlationId: notify.paymentId,
  externalUserId: notify.externalUserId,
  aggregateId: notify.paymentId,
  payload: { reason: 'cancelled' },
});

/** The `payment_cancel` handler: decode the payload, then emit the event. */
export const cancelNotify =
  (publish: (event: DomainEvent) => Effect.Effect<void, SqlError.SqlError>) =>
  (payload: unknown): Effect.Effect<void, SqlError.SqlError> =>
    Schema.decodeUnknown(CancelNotify)(payload).pipe(
      Effect.flatMap((notify) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((ms) =>
            publish(paymentCancelled(notify, new Date(ms))),
          ),
        ),
      ),
      Effect.catchTag('ParseError', (error) =>
        Effect.die(`invalid ${PAYMENT_CANCEL} payload: ${error.message}`),
      ),
    );

/** The `payment_reactivate` handler: decode the payload, then emit the event. */
export const reactivateNotify =
  (publish: (event: DomainEvent) => Effect.Effect<void, SqlError.SqlError>) =>
  (payload: unknown): Effect.Effect<void, SqlError.SqlError> =>
    Schema.decodeUnknown(ReactivateNotify)(payload).pipe(
      Effect.flatMap((notify) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((ms) =>
            publish(paymentReactivated(notify, new Date(ms))),
          ),
        ),
      ),
      Effect.catchTag('ParseError', (error) =>
        Effect.die(`invalid ${PAYMENT_REACTIVATE} payload: ${error.message}`),
      ),
    );

/** The `payment_defer` handler: decode the payload, then emit the event. */
export const deferNotify =
  (publish: (event: DomainEvent) => Effect.Effect<void, SqlError.SqlError>) =>
  (payload: unknown): Effect.Effect<void, SqlError.SqlError> =>
    Schema.decodeUnknown(DeferNotify)(payload).pipe(
      Effect.flatMap((notify) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((ms) =>
            publish(paymentDeferred(notify, new Date(ms))),
          ),
        ),
      ),
      Effect.catchTag('ParseError', (error) =>
        Effect.die(`invalid ${PAYMENT_DEFER} payload: ${error.message}`),
      ),
    );

/**
 * The `payment_lapse` handler: the cancel-pending payment reached its due date.
 * Flip it to `cancelled` (state before the event, CLAUDE.md §5), then emit the
 * terminal `renewal_failed`. Both steps are idempotent for a redelivered message.
 */
export const lapseNotify =
  (
    repo: PaymentRepo,
    publish: (event: DomainEvent) => Effect.Effect<void, SqlError.SqlError>,
  ) =>
  (payload: unknown): Effect.Effect<void, SqlError.SqlError> =>
    Schema.decodeUnknown(LapseNotify)(payload).pipe(
      Effect.flatMap((notify) =>
        repo.markCancelledLapsed(notify.paymentId).pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.flatMap((ms) => publish(cancelLapsed(notify, new Date(ms)))),
        ),
      ),
      Effect.catchTag('ParseError', (error) =>
        Effect.die(`invalid ${PAYMENT_LAPSE} payload: ${error.message}`),
      ),
    );
