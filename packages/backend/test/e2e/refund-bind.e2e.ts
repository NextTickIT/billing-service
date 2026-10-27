import assert from 'node:assert/strict';

import {
  ADMIN_TOKEN,
  loadBffHandler,
  makeBff,
  postJson,
} from './http-harness.js';
import type { E2eContext, Scenario } from './http-harness.js';

/**
 * The operator bind route refuses a refund before anything is queued (docs/34): a bind
 * settles a payment, and a refund is money returned. A quarantined charge that is not a
 * refund still binds, so the refusal is about the refund, not the route.
 */

const loginOperator = async (baseUrl: string) => {
  const bff = makeBff(await loadBffHandler(), baseUrl);
  const created = await postJson(
    `${baseUrl}/auth/operators`,
    { login: 'refund-op', password: 'refund-pass', role: 1 },
    { authorization: `Bearer ${ADMIN_TOKEN}` },
  );
  assert.equal(created.status, 201, 'operator created');
  const login = await bff(
    new Request(`${baseUrl}/api/auth/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'refund-op', password: 'refund-pass' }),
    }),
  );
  const cookie = /bss=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(cookie, 'operator signed in');
  return (quarantineId: string) =>
    bff(
      new Request(`${baseUrl}/api/quarantine/${quarantineId}/bind`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `bss=${cookie}`,
        },
        body: JSON.stringify({ externalUserId: '64b7f0c2a1d3e4f5a6b7c8d9' }),
      }),
    );
};

/** A quarantined charge of `status`, as the pipeline leaves an unmatched one. */
const seedQuarantined = async (
  query: E2eContext['query'],
  ref: string,
  status: string,
): Promise<string> =>
  (
    await query(
      `WITH c AS (
         INSERT INTO charges (source, "idemKey", "externalRef", amount, currency, status, "occurredAt", payload, "matchResult")
         VALUES ('wayforpay_callback', 'w4pcb:${ref}|x', '${ref}', 30000, 0, '${status}', now(), '{}'::jsonb, 'quarantined')
         RETURNING id)
       INSERT INTO quarantine_records ("incomingEventId") SELECT id FROM c RETURNING id`,
    )
  )
    .trim()
    .split('\n')[0] ?? '';

export const refundBindScenarios: readonly Scenario[] = [
  {
    name: 'quarantine bind: a refund is refused before it is queued; another charge still binds',
    run: async ({ baseUrl, query }) => {
      const bind = await loginOperator(baseUrl);
      const refund = await seedQuarantined(query, 'chk_refund', 'refunded');
      const payment = await seedQuarantined(query, 'chk_paid', 'succeeded');

      const refused = await bind(refund);
      const accepted = await bind(payment);

      assert.equal(refused.status, 422, 'the refund bind is refused');
      const body = (await refused.json()) as { error?: string };
      assert.match(body.error ?? '', /refund/, 'the refusal says why');
      assert.equal(accepted.status, 202, 'a non-refund charge still binds');
      assert.equal(
        (
          await query(
            `SELECT string_agg("idemKey", ',') FROM messages WHERE "messageType" = 'payment_rebind'`,
          )
        ).trim(),
        `rebind:${payment}`,
        'only the non-refund bind was queued',
      );
      assert.equal(
        (
          await query(
            `SELECT count(*) FROM audit_log WHERE action = 'bind_quarantine'`,
          )
        ).trim(),
        '1',
        'only the accepted bind was audited',
      );
    },
  },
];
