import { describe, expect, test } from 'vitest';

import {
  backoffMillis,
  decideOutcome,
  defaultRetryConfig,
  deliveryRetryConfig,
  describeError,
  isPermanentFailure,
  type RetryConfig,
  scheduledRetryConfig,
} from '@/infra/queue/policy.js';

const config: RetryConfig = {
  maxAttempts: 5,
  baseMillis: 1_000,
  maxMillis: 60_000,
};

describe('backoffMillis', () => {
  test('first attempt is the base step', () => {
    expect(backoffMillis(1, config)).toBe(1_000);
    // attempt <= 0 is clamped to the first step, never negative exponents.
    expect(backoffMillis(0, config)).toBe(1_000);
  });

  test('doubles each attempt', () => {
    expect(backoffMillis(2, config)).toBe(2_000);
    expect(backoffMillis(3, config)).toBe(4_000);
    expect(backoffMillis(4, config)).toBe(8_000);
  });

  test('caps at maxMillis', () => {
    expect(backoffMillis(20, config)).toBe(60_000);
  });
});

describe('decideOutcome', () => {
  const now = 1_000_000;

  test('success is terminal, no retry', () => {
    const outcome = decideOutcome(
      { failed: false, attemptCount: 1 },
      now,
      config,
    );
    expect(outcome).toEqual({
      status: 'success',
      retryAt: null,
      finished: true,
    });
  });

  test('a failure below the cap retries with backoff from now', () => {
    const outcome = decideOutcome(
      { failed: true, attemptCount: 2 },
      now,
      config,
    );
    expect(outcome.status).toBe('retry');
    expect(outcome.finished).toBe(false);
    expect(outcome.retryAt).toEqual(new Date(now + backoffMillis(2, config)));
  });

  test('a failure at the cap is terminal fail', () => {
    const outcome = decideOutcome(
      { failed: true, attemptCount: 5 },
      now,
      config,
    );
    expect(outcome).toEqual({ status: 'fail', retryAt: null, finished: true });
  });

  test('a failure beyond the cap is terminal fail', () => {
    const outcome = decideOutcome(
      { failed: true, attemptCount: 6 },
      now,
      config,
    );
    expect(outcome.status).toBe('fail');
    expect(outcome.finished).toBe(true);
  });

  test('default config caps attempts at 5', () => {
    expect(
      decideOutcome({ failed: true, attemptCount: 5 }, now, defaultRetryConfig)
        .status,
    ).toBe('fail');
    expect(
      decideOutcome({ failed: true, attemptCount: 4 }, now, defaultRetryConfig)
        .status,
    ).toBe('retry');
  });
});

const NOW = 1_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
// The agreed delivery ladder, written out independently of the config.
const LADDER = [
  10_000,
  MIN,
  10 * MIN,
  HOUR,
  2 * HOUR,
  4 * HOUR,
  8 * HOUR,
  16 * HOUR,
];

describe('deliveryRetryConfig', () => {
  const now = NOW;
  const ladder = LADDER;

  test('each failed attempt waits its step of the ladder (no jitter draw)', () => {
    ladder.forEach((wait, i) => {
      const outcome = decideOutcome(
        { failed: true, attemptCount: i + 1 },
        now,
        deliveryRetryConfig,
      );
      expect(outcome.status).toBe('retry');
      expect(outcome.retryAt).toEqual(new Date(now + wait));
    });
  });

  test('the 9th attempt is the last: its failure dead-letters', () => {
    expect(deliveryRetryConfig.maxAttempts).toBe(9);
    expect(
      decideOutcome(
        { failed: true, attemptCount: 9 },
        now,
        deliveryRetryConfig,
      ),
    ).toEqual({ status: 'fail', retryAt: null, finished: true });
  });

  test('the last retry runs ~31 h after the first failure', () => {
    const total = ladder.reduce((a, b) => a + b, 0);
    expect(total).toBe(31 * HOUR + 11 * MIN + 10_000);
  });
});

describe('deliveryRetryConfig jitter', () => {
  const now = NOW;

  test('jitter only adds, up to 20% of the step', () => {
    const at = (random: number) =>
      decideOutcome(
        { failed: true, attemptCount: 7 },
        now,
        deliveryRetryConfig,
        random,
      ).retryAt?.getTime();
    expect(at(0)).toBe(now + 8 * HOUR);
    expect(at(0.5)).toBe(now + 8 * HOUR + 48 * MIN); // +10%
    expect(at(0.999_999)).toBeLessThan(now + 8 * HOUR * 1.2);
  });

  test('stays strictly below +20% on every step, even at the top draw', () => {
    LADDER.forEach((wait, i) => {
      for (const random of [0.999_999, 1 - Number.EPSILON]) {
        const at = decideOutcome(
          { failed: true, attemptCount: i + 1 },
          now,
          deliveryRetryConfig,
          random,
        ).retryAt?.getTime();
        expect(at).toBeGreaterThanOrEqual(now + wait);
        expect(at).toBeLessThan(now + wait * 1.2);
      }
    });
  });

  test('a permanent failure still dead-letters on its first attempt', () => {
    expect(
      decideOutcome(
        { failed: true, attemptCount: 1, permanent: true },
        now,
        deliveryRetryConfig,
      ).status,
    ).toBe('fail');
  });

  test('the default ladder takes no jitter and still fails at 5', () => {
    expect(
      decideOutcome(
        { failed: true, attemptCount: 1 },
        now,
        defaultRetryConfig,
        0.9,
      ).retryAt,
    ).toEqual(new Date(now + 1_000));
    expect(
      decideOutcome({ failed: true, attemptCount: 5 }, now, defaultRetryConfig)
        .status,
    ).toBe('fail');
  });
});

describe('scheduledRetryConfig', () => {
  test('allows one retry per step and repeats the last step past the end', () => {
    const c = scheduledRetryConfig([5, 50]);
    expect(c.maxAttempts).toBe(3);
    expect(backoffMillis(1, c)).toBe(5);
    expect(backoffMillis(2, c)).toBe(50);
    expect(backoffMillis(9, c)).toBe(50);
  });

  test.each([[[]], [[Number.NaN]], [[Infinity]], [[-1]]])(
    'rejects %j',
    (delays) => {
      expect(() => scheduledRetryConfig(delays)).toThrow();
    },
  );
});

describe('a permanent failure', () => {
  const now = 1_000_000;

  test('is terminal on its first attempt, with attempts left on the ladder', () => {
    const outcome = decideOutcome(
      { failed: true, attemptCount: 1, permanent: true },
      now,
      config,
    );

    expect(outcome).toEqual({ status: 'fail', retryAt: null, finished: true });
  });

  test('a failure not marked permanent still retries on its first attempt', () => {
    const outcome = decideOutcome(
      { failed: true, attemptCount: 1, permanent: false },
      now,
      config,
    );

    expect(outcome.status).toBe('retry');
  });

  test('does not turn a success into a failure', () => {
    const outcome = decideOutcome(
      { failed: false, attemptCount: 1, permanent: true },
      now,
      config,
    );

    expect(outcome.status).toBe('success');
  });
});

describe('isPermanentFailure', () => {
  test.each([
    ['a value carrying permanent: true', { permanent: true }, true],
    ['a value carrying permanent: false', { permanent: false }, false],
    ['a value without the flag', { _tag: 'SinkError' }, false],
    ['a truthy non-boolean flag', { permanent: 'yes' }, false],
    ['null', null, false],
    ['a string', 'permanent', false],
  ])('%s → %s', (_label, error, expected) => {
    expect(isPermanentFailure(error)).toBe(expected);
  });
});

describe('describeError', () => {
  test('extracts message, code, and stack from an Error', () => {
    const error = Object.assign(new Error('boom'), { code: 'E_BOOM' });
    const detail = describeError(error);
    expect(detail.message).toBe('boom');
    expect(detail.code).toBe('E_BOOM');
    expect(typeof detail.stack).toBe('string');
  });

  test('uses the _tag of a tagged error object', () => {
    const detail = describeError({ _tag: 'SqlError', extra: 1 });
    expect(detail.message).toBe('SqlError');
  });

  test('falls back to String for primitives', () => {
    expect(describeError('nope').message).toBe('nope');
    expect(describeError(42).message).toBe('42');
  });
});
