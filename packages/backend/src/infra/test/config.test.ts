import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '@/config.js';

// `makeRateLimiter` dies on a non-positive rate inside the layer that builds every sink,
// so a bad value would take the whole worker down. The CRM limiter falls back to its
// default instead, like every other limiter (06f5fd4).
const expectedCrmDefaultRps = 10;
const expectedConfiguredRps = 4;

describe('the CRM sink rate limit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([['0'], ['-3'], ['not-a-number'], ['']])(
    'falls back to the default for %j',
    (raw) => {
      vi.stubEnv('CRM_RATE_LIMIT_RPS', raw);

      const config = loadConfig();

      expect(config.sinks.crm.rateLimitRps).toBe(expectedCrmDefaultRps);
    },
  );

  it('takes a positive configured value', () => {
    vi.stubEnv('CRM_RATE_LIMIT_RPS', String(expectedConfiguredRps));

    const config = loadConfig();

    expect(config.sinks.crm.rateLimitRps).toBe(expectedConfiguredRps);
  });
});

// One deadline per CRM POST; the worker dispatches one message at a time, so "no deadline"
// would let a stalled CRM hold every delivery. A bad value falls back to the default.
const expectedCrmDefaultTimeoutMs = 10_000;
const expectedConfiguredTimeoutMs = 2_500;

describe('the CRM sink deadline', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults when unset', () => {
    const config = loadConfig();

    expect(config.sinks.crm.timeoutMillis).toBe(expectedCrmDefaultTimeoutMs);
  });

  it.each([['0'], ['-3'], ['not-a-number'], ['']])(
    'falls back to the default for %j',
    (raw) => {
      vi.stubEnv('CRM_TIMEOUT_MS', raw);

      const config = loadConfig();

      expect(config.sinks.crm.timeoutMillis).toBe(expectedCrmDefaultTimeoutMs);
    },
  );

  it('takes a positive configured value', () => {
    vi.stubEnv('CRM_TIMEOUT_MS', String(expectedConfiguredTimeoutMs));

    const config = loadConfig();

    expect(config.sinks.crm.timeoutMillis).toBe(expectedConfiguredTimeoutMs);
  });
});
