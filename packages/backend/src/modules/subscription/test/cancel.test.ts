import { it } from '@effect/vitest';
import type { DomainEvent } from '@billing-service/shared';
import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  cancelNotify,
  subscriptionCancelled,
} from '@/modules/subscription/cancel.js';

describe('subscriptionCancelled', () => {
  test('carries the reason and the external user (docs/07)', () => {
    const event = subscriptionCancelled(
      { subscriptionId: 'sub_1', externalUserId: 'sp:1', reason: 'operator' },
      new Date(0),
    );
    expect(event.name).toBe('subscription_cancelled');
    expect(event.externalUserId).toBe('sp:1');
    expect(event.aggregateId).toBe('sub_1');
    expect(event.payload.reason).toBe('operator');
  });
});

const recordingPublish = () => {
  const events: DomainEvent[] = [];
  const publish = (event: DomainEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      events.push(event);
    });
  return { events, publish };
};

it.effect('cancelNotify decodes the payload and publishes the event', () =>
  Effect.gen(function* () {
    const pub = recordingPublish();

    yield* cancelNotify(pub.publish)({
      subscriptionId: 'sub_1',
      externalUserId: 'sp:1',
      reason: 'operator',
    });

    expect(pub.events).toHaveLength(1);
    expect(pub.events[0]?.name).toBe('subscription_cancelled');
  }),
);
