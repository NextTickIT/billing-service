import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import {
  CheckoutSessionKind,
  type NewCheckoutSession,
  PaymentMethod,
} from '@billing-service/shared';
import { Effect, Either, Option } from 'effect';

import type { Charge } from '@/modules/charge/contracts.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import {
  drain,
  type EffectScenario,
  expectRows,
  HOUR,
  registerHandlers,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { effectivePayable } from '@/modules/checkout/routes.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';

/**
 * Re-issuing a lapsed link may hand back a live session of the same contact instead of
 * minting one, but only when that session is the SAME intent. The caller's `metadata` is
 * part of the intent: it is echoed on the success event, so reusing a session that
 * declares another purchase reports the wrong one. A NULL declaration and `{}` are
 * different instructions (docs/07, `Metadata`), so they never match each other.
 */

const FAR = new Date('2030-01-01T00:00:00Z');
const USD = 1;
const LIVE_ID = 'chk_rm_live';

type Declaration = Record<string, unknown> | null;

/** A plain recurring checkout of `externalUserId` on fixed terms. */
const session = (
  id: string,
  externalUserId: string,
  expiresAt: Date,
  metadata: Declaration,
): NewCheckoutSession => ({
  id,
  externalUserId,
  amount: 30000,
  currency: USD,
  period: 'P4W',
  method: PaymentMethod.Crypto,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  origin: null,
  renewalOf: null,
  options: null,
  idempotencyKey: null,
  email: '',
  metadata,
  expiresAt,
});

/** A lapsed link declaring `stale` and a live one declaring `live`; the lapsed link is
 * then re-issued the way `/pay` does it for a contact with no live subscription. */
const reissueBeside = (
  externalUserId: string,
  stale: Declaration,
  live: Declaration,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const checkout = makeCheckoutRepo(sql);
    const lapsed = new Date(Date.now() - HOUR);
    yield* checkout.insert(
      session('chk_rm_stale', externalUserId, lapsed, stale),
    );
    yield* checkout.insert(session(LIVE_ID, externalUserId, FAR, live));
    const noSub =
      yield* makePaymentRepo(sql).findActiveRecurringByExternalUser(
        externalUserId,
      );
    const found = yield* checkout.findById('chk_rm_stale');
    const effective = Either.getOrThrow(
      effectivePayable(Option.getOrThrow(found), noSub, Date.now(), 3600),
    );
    assert.equal(effective._tag, 'Reissue', 'a plain clone');
    return yield* checkout.reissueLapsed(effective.intent);
  });

/** A WhitePay (crypto, USD) success for checkout session `ref`. */
const paid = (ref: string): Charge => ({
  source: 'whitepay_callback',
  idemKey: `wp:${ref}|succeeded`,
  externalRef: ref,
  externalUserId: null,
  amount: 30000,
  currency: USD,
  status: 'succeeded',
  occurredAt: new Date('2026-05-03T00:00:00Z'),
  payload: {},
});

const declaredOn = (externalUserId: string, name: string) =>
  `SELECT payload->'metadata' FROM domain_events WHERE name = '${name}' AND "externalUserId" = '${externalUserId}'`;

const payReissuedA = Effect.gen(function* () {
  yield* registerHandlers;
  const id = yield* reissueBeside(
    'sp:rm-ab',
    { orderId: 'A' },
    { orderId: 'B' },
  );
  yield* (yield* ChargePipeline).ingest(paid(id));
  yield* drain;
});

const reissuedLinkSettlesItsOwnDeclaration: EffectScenario = {
  name: "reissue (metadata): paying A's re-issued link reports A, not the live checkout that declares B",
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      await run(payReissuedA);

      await expectRows(query, [
        [
          declaredOn('sp:rm-ab', 'initial_payment_succeeded'),
          '{"orderId": "A"}',
          'the success event echoes the declaration of the link that was paid',
        ],
        [
          declaredOn('sp:rm-ab', 'payment_created'),
          '{"orderId": "A"}',
          'the new payment is born with that declaration',
        ],
      ]);
    }),
};

/** One reuse boundary: what the lapsed and the live link declare, whether the live one is
 * handed back, and the declaration the session the buyer now pays carries. */
interface ReuseBoundary {
  readonly label: string;
  readonly stale: Declaration;
  readonly live: Declaration;
  readonly expectedReused: boolean;
  readonly expectedDeclaration: string;
}

const reuseBoundary = ({
  label,
  stale,
  live,
  expectedReused,
  expectedDeclaration,
}: ReuseBoundary): EffectScenario => ({
  name: `reissue (metadata): ${label}`,
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const id = await run(reissueBeside('sp:rm-edge', stale, live));

      assert.equal(id === LIVE_ID, expectedReused, 'reuse of the live link');
      await expectRows(query, [
        [
          `SELECT coalesce(metadata::text, 'NULL') FROM checkout_sessions WHERE id = '${id}'`,
          expectedDeclaration,
          'the session the buyer pays declares what the lapsed link declared',
        ],
      ]);
    }),
});

/** An intent that omits `metadata` beside a live link that declares nothing. */
const reissueOmitted = Effect.gen(function* () {
  const checkout = makeCheckoutRepo(yield* SqlClient.SqlClient);
  yield* checkout.insert(session(LIVE_ID, 'sp:rm-omit', FAR, null));
  const omitted: NewCheckoutSession = session(
    'chk_rm_omitted',
    'sp:rm-omit',
    FAR,
    null,
  );
  Reflect.deleteProperty(omitted, 'metadata');
  return yield* checkout.reissueLapsed(omitted);
});

const omittedDeclarationIsNone: EffectScenario = {
  name: 'reissue (metadata): an intent that omits its declaration reuses a live link that declares nothing',
  run: ({ config }) =>
    withWorker(config, async (run) => {
      const id = await run(reissueOmitted);

      assert.equal(id, LIVE_ID, 'omitted and null are the same instruction');
    }),
};

export const reissueMetadataScenarios: readonly EffectScenario[] = [
  omittedDeclarationIsNone,
  reissuedLinkSettlesItsOwnDeclaration,
  reuseBoundary({
    label: 'an equal declaration reuses the live link',
    stale: { orderId: 'A' },
    live: { orderId: 'A' },
    expectedReused: true,
    expectedDeclaration: '{"orderId": "A"}',
  }),
  reuseBoundary({
    label: 'the same declaration with its keys in another order is still equal',
    stale: { a: 1, b: 2 },
    live: { b: 2, a: 1 },
    expectedReused: true,
    expectedDeclaration: '{"a": 1, "b": 2}',
  }),
  reuseBoundary({
    label: 'no declaration on either side reuses the live link',
    stale: null,
    live: null,
    expectedReused: true,
    expectedDeclaration: 'NULL',
  }),
  reuseBoundary({
    label: 'no declaration does not reuse a live link that declares {}',
    stale: null,
    live: {},
    expectedReused: false,
    expectedDeclaration: 'NULL',
  }),
  reuseBoundary({
    label: '{} does not reuse a live link that declares nothing',
    stale: {},
    live: null,
    expectedReused: false,
    expectedDeclaration: '{}',
  }),
];
