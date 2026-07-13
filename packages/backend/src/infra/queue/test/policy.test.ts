import { describe, expect, test } from 'vitest';

import {
  backoffMillis,
  decideOutcome,
  defaultRetryConfig,
  describeError,
  type RetryConfig,
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
