import type { SqlError } from '@effect/sql';
import type {
  DomainEvent,
  PaymentCancelledEvent,
} from '@billing-service/shared';
import { Clock, Effect, Schema } from 'effect';

import {
  CancelNotify,
  SUBSCRIPTION_CANCEL,
} from '@/modules/payment/contracts.js';

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

/** The `subscription_cancel` handler: decode the payload, then emit the event. */
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
        Effect.die(`invalid ${SUBSCRIPTION_CANCEL} payload: ${error.message}`),
      ),
    );
