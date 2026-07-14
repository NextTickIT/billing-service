import type { SqlError } from '@effect/sql';
import type {
  DomainEvent,
  SubscriptionCancelledEvent,
} from '@billing-service/shared';
import { Clock, Effect, Schema } from 'effect';

import {
  CancelNotify,
  SUBSCRIPTION_CANCEL,
} from '@/modules/subscription/contracts.js';

/** subscription_cancelled envelope (docs/07); deterministic id so replays dedupe. */
export const subscriptionCancelled = (
  notify: CancelNotify,
  now: Date,
): SubscriptionCancelledEvent => ({
  id: `evt_sub_${notify.subscriptionId}_cancelled`,
  name: 'subscription_cancelled',
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
            publish(subscriptionCancelled(notify, new Date(ms))),
          ),
        ),
      ),
      Effect.catchTag('ParseError', (error) =>
        Effect.die(`invalid ${SUBSCRIPTION_CANCEL} payload: ${error.message}`),
      ),
    );
