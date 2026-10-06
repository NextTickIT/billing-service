import { AuthKind, type Sink, SinkKind } from '@billing-service/shared';
import { expect, it } from 'vitest';

import { mergeUpdate, toView } from '@/modules/sinks/domain.js';

const base: Sink = {
  kind: SinkKind.SendPulse,
  enabled: false,
  auth: { kind: AuthKind.Bearer, token: 'stored-token' },
  config: { flows: { initial_payment_succeeded: 'f1' } },
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const crm: Sink = {
  kind: SinkKind.Crm,
  enabled: false,
  auth: { kind: AuthKind.Bearer, token: 'crm-token' },
  config: { url: 'https://crm.example/events' },
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

/** Unwrap a merge the test expects to succeed; fails loudly rather than silently. */
const merged = (sink: Sink, patch: Parameters<typeof mergeUpdate>[1]): Sink => {
  const outcome = mergeUpdate(sink, patch);
  if (!outcome.ok) throw new Error(`unexpected reject: ${outcome.reason}`);
  return outcome.sink;
};

it('toView strips the token and reports hasToken=true', () => {
  expect(toView(base).auth).toEqual({ kind: AuthKind.Bearer, hasToken: true });
});

it('toView reports hasToken=false for an empty token', () => {
  const v = toView({ ...base, auth: { kind: AuthKind.Bearer, token: '' } });
  expect(v.auth.hasToken).toBe(false);
});

it('toView keeps the CRM url (not a secret) and still strips its token', () => {
  const v = toView(crm);
  expect(v.auth).toEqual({ kind: AuthKind.Bearer, hasToken: true });
  // The operator must be able to see where the feed points; only the token is write-only.
  expect(v.config).toEqual({ url: 'https://crm.example/events' });
});

it('mergeUpdate keeps the stored token when the patch omits auth', () => {
  const out = merged(base, {
    enabled: true,
    config: { flows: { renewal_failed: 'f2' } },
  });
  expect(out.auth.token).toBe('stored-token');
  expect(out.enabled).toBe(true);
  expect(out.kind === SinkKind.SendPulse && out.config.flows).toEqual({
    renewal_failed: 'f2',
  });
});

it('mergeUpdate keeps the stored token when the patch token is empty', () => {
  expect(
    merged(base, { auth: { kind: AuthKind.Bearer, token: '' } }).auth.token,
  ).toBe('stored-token');
});

it('mergeUpdate replaces the token when a new one is provided', () => {
  expect(
    merged(base, { auth: { kind: AuthKind.Bearer, token: 'new-token' } }).auth
      .token,
  ).toBe('new-token');
});

it('mergeUpdate sets the CRM url and keeps its stored token', () => {
  const out = merged(crm, {
    enabled: true,
    config: { url: 'https://crm.example/v2/events' },
  });
  expect(out.enabled).toBe(true);
  expect(out.auth.token).toBe('crm-token');
  expect(out.kind === SinkKind.Crm && out.config.url).toBe(
    'https://crm.example/v2/events',
  );
});

it('mergeUpdate keeps the stored config when the patch omits it', () => {
  expect(merged(crm, { enabled: true }).config).toEqual({
    url: 'https://crm.example/events',
  });
});

// The update body's config is untagged (the kind comes from the route path), so a
// mis-addressed config CAN arrive. Storing it would leave the operator believing they had
// configured a sink whose connector reads nothing of what they saved.
it('mergeUpdate REJECTS a flows config addressed to the CRM sink', () => {
  const outcome = mergeUpdate(crm, {
    config: { flows: { renewal_failed: 'f2' } },
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toContain('crm');
});

it('mergeUpdate REJECTS a url config addressed to the SendPulse sink', () => {
  const outcome = mergeUpdate(base, {
    config: { url: 'https://crm.example/events' },
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toContain('sendpulse');
});

it('a rejected merge writes nothing — the stored sink is returned untouched', () => {
  const outcome = mergeUpdate(crm, {
    enabled: true,
    config: { flows: {} },
  });
  // Importantly the `enabled: true` is dropped too: a half-applied patch that enabled a
  // sink while refusing its endpoint would start dead-lettering every event.
  expect(outcome.ok).toBe(false);
  expect(crm.enabled).toBe(false);
});
