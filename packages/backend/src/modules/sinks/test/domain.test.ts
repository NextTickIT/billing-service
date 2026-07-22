import { AuthKind, type Sink, SinkKind } from '@billing-service/shared';
import { expect, it } from 'vitest';

import { mergeUpdate, toView } from '@/modules/sinks/domain.js';

const base: Sink = {
  kind: SinkKind.SendPulse,
  enabled: false,
  auth: { kind: AuthKind.Bearer, token: 'stored-token' },
  config: { flows: { payment_succeeded: 'f1' } },
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

it('toView strips the token and reports hasToken=true', () => {
  expect(toView(base).auth).toEqual({ kind: AuthKind.Bearer, hasToken: true });
});

it('toView reports hasToken=false for an empty token', () => {
  const v = toView({ ...base, auth: { kind: AuthKind.Bearer, token: '' } });
  expect(v.auth.hasToken).toBe(false);
});

it('mergeUpdate keeps the stored token when the patch omits auth', () => {
  const merged = mergeUpdate(base, {
    enabled: true,
    config: { flows: { renewal_failed: 'f2' } },
  });
  expect(merged.auth.token).toBe('stored-token');
  expect(merged.enabled).toBe(true);
  expect(merged.config.flows).toEqual({ renewal_failed: 'f2' });
});

it('mergeUpdate keeps the stored token when the patch token is empty', () => {
  const merged = mergeUpdate(base, {
    auth: { kind: AuthKind.Bearer, token: '' },
  });
  expect(merged.auth.token).toBe('stored-token');
});

it('mergeUpdate replaces the token when a new one is provided', () => {
  const merged = mergeUpdate(base, {
    auth: { kind: AuthKind.Bearer, token: 'new-token' },
  });
  expect(merged.auth.token).toBe('new-token');
});
