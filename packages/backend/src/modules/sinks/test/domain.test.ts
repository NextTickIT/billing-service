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

  expect(outcome).toEqual({
    ok: false,
    reason: 'config does not match sink kind crm',
  });
});

it('mergeUpdate REJECTS a url config addressed to the SendPulse sink', () => {
  const outcome = mergeUpdate(base, {
    config: { url: 'https://crm.example/events' },
  });

  expect(outcome).toEqual({
    ok: false,
    reason: 'config does not match sink kind sendpulse',
  });
});

// The route writes only `outcome.sink`. A rejection that carried a sink — say the patch
// with its `enabled: true` applied and only the config refused — would be a half-applied
// patch that enabled a sink while refusing its endpoint. The outcome must carry no sink.
it('a rejected merge carries no sink for the route to write', () => {
  const outcome = mergeUpdate(crm, {
    enabled: true,
    config: { flows: {} },
  });

  expect(outcome).toEqual({
    ok: false,
    reason: 'config does not match sink kind crm',
  });
});

/** The CRM row as migration 0025 seeds it: disabled, no URL, no token. */
const seededCrm: Sink = {
  ...crm,
  auth: { kind: AuthKind.Bearer, token: '' },
  config: { url: '' },
};

// An enabled CRM sink with no URL or token would fail every delivery until someone noticed;
// the console refuses the state instead (422), and only that state.
it.each([
  [
    'enabling the seeded row as is',
    seededCrm,
    { enabled: true },
    'cannot enable the crm sink without: url, auth.token',
  ],
  [
    'enabling it with a url but no token',
    seededCrm,
    { enabled: true, config: { url: 'https://crm.example/events' } },
    'cannot enable the crm sink without: auth.token',
  ],
  [
    'enabling it with a token but no url',
    seededCrm,
    { enabled: true, auth: { kind: AuthKind.Bearer, token: 't' } },
    'cannot enable the crm sink without: url',
  ],
  [
    'blanking the url of an enabled sink',
    { ...crm, enabled: true },
    { config: { url: '' } },
    'cannot enable the crm sink without: url',
  ],
] as const)(
  'mergeUpdate REJECTS %s',
  (_label, current, patch, expectedReason) => {
    const outcome = mergeUpdate(current, patch);

    expect(outcome).toEqual({ ok: false, reason: expectedReason });
  },
);

it.each([
  [
    'enabling the seeded row with both a url and a token',
    seededCrm,
    {
      enabled: true,
      config: { url: 'https://crm.example/events' },
      auth: { kind: AuthKind.Bearer, token: 't' },
    },
    true,
  ],
  [
    'saving a url on the seeded row while it stays disabled',
    seededCrm,
    { config: { url: 'https://crm.example/events' } },
    false,
  ],
  [
    'disabling a sink with no url',
    { ...seededCrm, enabled: true },
    { enabled: false },
    false,
  ],
  [
    'enabling a configured sink with an empty token in the patch (the stored one is kept)',
    crm,
    { enabled: true, auth: { kind: AuthKind.Bearer, token: '' } },
    true,
  ],
] as const)(
  'mergeUpdate ACCEPTS %s',
  (_label, current, patch, expectedEnabled) => {
    const outcome = mergeUpdate(current, patch);

    expect(outcome).toMatchObject({
      ok: true,
      sink: { enabled: expectedEnabled },
    });
  },
);
