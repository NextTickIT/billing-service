import { it } from '@effect/vitest';
import type { DomainEvent } from '@billing-service/shared';
import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  externalUserIdChanged,
  externalUserIdChangedNotify,
} from '@/modules/identity/domain.js';

describe('externalUserIdChanged', () => {
  test('targets the new id and carries the old id + counts (docs/31)', () => {
    const event = externalUserIdChanged(
      { from: 'sp:old', to: 'sp:new', movedPayments: 2, movedSessions: 1 },
      new Date(0),
    );
    expect(event.name).toBe('external_user_id_changed');
    // The go-forward contact is the NEW id; the payload names the old one.
    expect(event.externalUserId).toBe('sp:new');
    expect(event.payload).toEqual({
      from: 'sp:old',
      to: 'sp:new',
      movedPayments: 2,
      movedSessions: 1,
    });
    // Deterministic id so a redelivered notify dedupes in the outbox.
    expect(event.id).toBe('evt_euidchg_sp:old_sp:new');
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

it.effect(
  'externalUserIdChangedNotify decodes the payload and publishes the event',
  () =>
    Effect.gen(function* () {
      const pub = recordingPublish();

      yield* externalUserIdChangedNotify(pub.publish)({
        from: 'sp:old',
        to: 'sp:new',
        movedPayments: 3,
        movedSessions: 0,
      });

      expect(pub.events).toHaveLength(1);
      expect(pub.events[0]?.name).toBe('external_user_id_changed');
      expect(pub.events[0]?.externalUserId).toBe('sp:new');
    }),
);
