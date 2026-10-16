import type { DomainEvent } from '@billing-service/shared';
import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';

import { lapseNotify } from '@/modules/payment/cancel.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';

/**
 * CR1: the lapse handler hands the enqueued due date to the guarded flip, so the SQL can
 * compare against it instead of the DB clock (the real guard runs in `lapse.e2e.ts`).
 */
const run = (payload: unknown, flips: boolean) => {
  const calls: { id: string; dueAtMs: number | undefined }[] = [];
  const published: DomainEvent[] = [];
  const repo = {
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    markCancelledLapsed: (id: string, dueAtMs?: number) =>
      Effect.sync(() => {
        calls.push({ id, dueAtMs });
        return flips;
      }),
  } as unknown as PaymentRepo;
  Effect.runSync(
    lapseNotify(repo, (event) =>
      Effect.sync(() => {
        published.push(event);
      }),
    )(payload),
  );
  return { calls, published };
};

describe('lapseNotify', () => {
  test('passes the enqueued dueAt to the guarded flip and emits on a flip', () => {
    const { calls, published } = run(
      { paymentId: 'pay_1', externalUserId: 'sp:1', dueAt: 1_790_000_000_000 },
      true,
    );
    expect(calls).toEqual([{ id: 'pay_1', dueAtMs: 1_790_000_000_000 }]);
    expect(published.map((e) => e.name)).toEqual(['renewal_failed']);
  });

  test('an old message without dueAt falls back to the clock guard', () => {
    const { calls } = run({ paymentId: 'pay_1', externalUserId: 'sp:1' }, true);
    expect(calls).toEqual([{ id: 'pay_1', dueAtMs: undefined }]);
  });

  test('a stale lapse (no flip) emits nothing', () => {
    const { published } = run(
      { paymentId: 'pay_1', externalUserId: 'sp:1', dueAt: 1 },
      false,
    );
    expect(published).toEqual([]);
  });
});
