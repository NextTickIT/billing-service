import { describe, expect, test } from 'vitest';

import { retryConfigFor } from '@/infra/queue/dispatcher.js';
import {
  decideOutcome,
  defaultRetryConfig,
  deliveryRetryConfig,
} from '@/infra/queue/policy.js';
import { DELIVER_EVENT } from '@/modules/outbox/contracts.js';

// The same wiring worker-boot passes to the queue.
const options = {
  retry: defaultRetryConfig,
  retryByType: { [DELIVER_EVENT]: deliveryRetryConfig },
};

describe('retryConfigFor', () => {
  test('a deliver_event failure at attempt 5 retries instead of dead-lettering', () => {
    const outcome = decideOutcome(
      { failed: true, attemptCount: 5 },
      0,
      retryConfigFor(options, DELIVER_EVENT),
    );
    expect(outcome.status).toBe('retry');
  });

  test('every other message type keeps the default and fails at 5', () => {
    for (const type of ['payment_event_received', 'payment_lapse']) {
      expect(retryConfigFor(options, type)).toBe(defaultRetryConfig);
      expect(
        decideOutcome(
          { failed: true, attemptCount: 5 },
          0,
          retryConfigFor(options, type),
        ).status,
      ).toBe('fail');
    }
  });

  test('no overrides at all falls back to the default', () => {
    expect(retryConfigFor({ retry: defaultRetryConfig }, DELIVER_EVENT)).toBe(
      defaultRetryConfig,
    );
  });
});
