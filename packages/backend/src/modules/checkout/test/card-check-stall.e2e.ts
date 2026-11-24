import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import {
  CheckoutSessionKind,
  type NewCheckoutSession,
  PaymentMethod,
} from '@billing-service/shared';
import { Effect } from 'effect';

import type { Charge } from '@/modules/charge/contracts.js';
import {
  asPayload,
  DAY,
  type EffectScenario,
  expectRows,
  settlementHandler,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { sweepStalledCardChecks } from '@/modules/checkout/card-check-stall.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { normalizeCallback } from '@/modules/wayforpay/callback.js';
import type { W4pCheckStatusResponse } from '@/modules/wayforpay/contracts.js';
import {
  W4pApiError,
  W4pOrderNotFoundError,
} from '@/modules/wayforpay/errors.js';

/**
 * The stall sweep on a real Postgres (support case @ddeenis, 2026-11-24): an open card
 * check WayForPay holds in a 3-D Secure wait is reported as the decline a callback would
 * have reported, once, and the session stays open. CHECK_STATUS is a canned fake keyed by
 * order reference, recording which orders it was asked about.
 */

const MINUTE = 60 * 1000;

const cardCheckSession = (
  id: string,
  externalUserId: string,
): NewCheckoutSession => ({
  id,
  externalUserId,
  amount: 5000,
  currency: 1,
  period: 'P4W',
  method: PaymentMethod.Card,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  options: null,
  origin: 'migration',
  renewalOf: null,
  metadata: { attemptId: id },
  startsAt: new Date(Date.now() + 30 * DAY),
  payableUntil: null,
  lockMethod: true,
  idempotencyKey: null,
  email: '',
  expiresAt: new Date(Date.now() + 29 * DAY),
  firstCharge: 'card_check',
});

/** Seed an open card check whose Pay was pressed `minutesAgo` ago and sent to WayForPay. */
const pressed = (id: string, contact: string, minutesAgo: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* makeCheckoutRepo(sql).insert(cardCheckSession(id, contact));
    const at = new Date(Date.now() - minutesAgo * MINUTE);
    yield* sql`
      UPDATE checkout_sessions
      SET status = 1, "claimedAt" = ${at}, "firstSentToProviderAt" = ${at}
      WHERE id = ${id}
    `;
  });

type Answer =
  | { readonly kind: 'status'; readonly response: W4pCheckStatusResponse }
  | { readonly kind: 'api_error'; readonly error: W4pApiError }
  | { readonly kind: 'not_found' };

/** What WayForPay answers about an order whose 3-D Secure challenge started
 * `minutesAgo` and was never answered (live shape, 2026-11-24). */
const otpWaitSince = (minutesAgo: number): Answer => ({
  kind: 'api_error',
  error: new W4pApiError({
    endpoint: 'CHECK_STATUS',
    reasonCode: 5110,
    reason: 'Ok',
    transactionStatus: 'WaitingOtpConfirm',
    processingDate: Math.floor((Date.now() - minutesAgo * MINUTE) / 1000),
  }),
});

const otpWait = otpWaitSince(20);

/** A canned CHECK_STATUS. `onAsk` runs before the answer — a payer acting while
 * WayForPay is being asked. */
const fakeWayForPay = (
  answers: Readonly<Record<string, Answer>>,
  onAsk: (orderReference: string) => Effect.Effect<void> = () => Effect.void,
) => {
  const asked: string[] = [];
  const client = {
    checkStatus: (orderReference: string) => {
      asked.push(orderReference);
      const answer = answers[orderReference] ?? { kind: 'not_found' };
      return onAsk(orderReference).pipe(
        Effect.andThen(() => {
          switch (answer.kind) {
            case 'status':
              return Effect.succeed(answer.response);
            case 'api_error':
              return Effect.fail(answer.error);
            case 'not_found':
              return Effect.fail(new W4pOrderNotFoundError({ orderReference }));
          }
        }),
      );
    },
  };
  return { client, asked };
};

const sweep = (client: ReturnType<typeof fakeWayForPay>['client']) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* Outbox;
    return yield* sweepStalledCardChecks({
      sql,
      client,
      publish: outbox.publish,
    });
  });

const settle = (charge: Charge) =>
  Effect.flatMap(settlementHandler(), (handle) => handle(asPayload(charge)));

const verifyCallback = (ref: string): Charge =>
  normalizeCallback({
    orderReference: ref,
    transactionStatus: 'WaitingAuthComplete',
    reasonCode: 1100,
    amount: '0',
    currency: 'UAH',
    recToken: 'tok_cc',
    createdDate: String(Math.floor(Date.now() / 1000)),
  });

const failedEventsOf = (contact: string) =>
  `SELECT coalesce(string_agg(id || '|' || (payload->>'reason'), ',' ORDER BY "createdAt"), '') FROM domain_events WHERE "externalUserId" = '${contact}' AND name = 'card_check_failed'`;

const sessionStatus = (id: string) =>
  `SELECT status FROM checkout_sessions WHERE id = '${id}'`;

const paymentsOf = (contact: string) =>
  `SELECT count(*) FROM payments WHERE "externalUserId" = '${contact}'`;

const STUCK = 'sp:stall-stuck';
const STUCK_ID = 'chk_stall-stuck';

const stuckReportedOnce: EffectScenario = {
  name: 'card-check stall: an order held for the 3-D Secure code is reported declined once, the session stays open, a late verify still activates',
  run: async ({ config, query }) => {
    const { client } = fakeWayForPay({ [STUCK_ID]: otpWait });
    const reported: number[] = [];
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pressed(STUCK_ID, STUCK, 20);
          reported.push(yield* sweep(client));
          reported.push(yield* sweep(client));
        }),
      ),
    );

    await expectRows(query, [
      [
        failedEventsOf(STUCK),
        `evt_w4pstall:${STUCK_ID}:card_check_failed|declined`,
        'one card_check_failed{declined} for the session',
      ],
      [sessionStatus(STUCK_ID), '1', 'the session stays open (Pending)'],
    ]);
    assert.deepEqual(
      reported,
      [1, 0],
      'the first pass reports, the second none',
    );
    await withWorker(config, (run) => run(settle(verifyCallback(STUCK_ID))));
    await expectRows(query, [
      [paymentsOf(STUCK), '1', 'a verify after the report still activates'],
    ]);
  },
};

const WINDOW = 'sp:stall-window';
const FRESH_ID = 'chk_stall-fresh';
const OLD_ID = 'chk_stall-old';
const EDGE_ID = 'chk_stall-edge';

const onlyInsideWindow: EffectScenario = {
  name: 'card-check stall: an order pressed under 15 minutes ago or over a week ago is not asked about',
  run: async ({ config, query }) => {
    const { client, asked } = fakeWayForPay({
      [FRESH_ID]: otpWait,
      [OLD_ID]: otpWait,
      [EDGE_ID]: otpWait,
    });
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pressed(FRESH_ID, `${WINDOW}-fresh`, 14);
          yield* pressed(OLD_ID, `${WINDOW}-old`, 7 * 24 * 60 + 1);
          yield* pressed(EDGE_ID, `${WINDOW}-edge`, 16);
          yield* sweep(client);
        }),
      ),
    );

    await expectRows(query, [
      [
        failedEventsOf(`${WINDOW}-fresh`),
        '',
        'a payer still typing the code is left alone',
      ],
      [
        failedEventsOf(`${WINDOW}-old`),
        '',
        'an order past the lookback is left alone',
      ],
      [
        failedEventsOf(`${WINDOW}-edge`),
        `evt_w4pstall:${EDGE_ID}:card_check_failed|declined`,
        'an order just past the stall delay is reported',
      ],
    ]);
    assert.deepEqual(
      asked,
      [EDGE_ID],
      'only the order inside the window is asked about',
    );
  },
};

const LEFT = 'sp:stall-left';
const UNKNOWN_ID = 'chk_stall-unknown';
const VERIFIED_ID = 'chk_stall-verified';

const leftAlone: EffectScenario = {
  name: 'card-check stall: an order WayForPay does not know, or one it verified, is not reported',
  run: async ({ config, query }) => {
    const { client } = fakeWayForPay({
      [VERIFIED_ID]: {
        kind: 'status',
        response: {
          reasonCode: 1100,
          orderReference: VERIFIED_ID,
          transactionStatus: 'WaitingAuthComplete',
        },
      },
    });
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pressed(UNKNOWN_ID, `${LEFT}-unknown`, 30);
          yield* pressed(VERIFIED_ID, `${LEFT}-verified`, 30);
          yield* sweep(client);
        }),
      ),
    );

    await expectRows(query, [
      [
        failedEventsOf(`${LEFT}-unknown`),
        '',
        'a form opened and left is not a decline',
      ],
      [
        failedEventsOf(`${LEFT}-verified`),
        '',
        'a verified order waits for its callback',
      ],
    ]);
  },
};

const SEEN = 'sp:stall-seen';
const SEEN_ID = 'chk_stall-seen';

const alreadyDeclined: EffectScenario = {
  name: 'card-check stall: a session already reported declined by a callback is not reported again',
  run: async ({ config, query }) => {
    const { client, asked } = fakeWayForPay({ [SEEN_ID]: otpWait });
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pressed(SEEN_ID, SEEN, 30);
          yield* settle(
            normalizeCallback({
              orderReference: SEEN_ID,
              transactionStatus: 'Declined',
              reasonCode: 1101,
              amount: '0',
              currency: 'UAH',
              recToken: '',
              createdDate: String(Math.floor(Date.now() / 1000)),
            }),
          );
          yield* sweep(client);
        }),
      ),
    );

    await expectRows(query, [
      [
        `SELECT count(*) FROM domain_events WHERE "externalUserId" = '${SEEN}' AND name = 'card_check_failed'`,
        '1',
        'only the callback decline',
      ],
    ]);
    assert.deepEqual(asked, [], 'a reported session is not asked about');
  },
};

const FRESH_CHALLENGE = 'sp:stall-fresh-challenge';
const FRESH_CHALLENGE_ID = 'chk_stall-fresh-challenge';

const freshChallenge: EffectScenario = {
  name: 'card-check stall: a challenge that started under 15 minutes ago is not reported, however long ago Pay was pressed',
  run: async ({ config, query }) => {
    const { client } = fakeWayForPay({
      [FRESH_CHALLENGE_ID]: otpWaitSince(5),
    });
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pressed(FRESH_CHALLENGE_ID, FRESH_CHALLENGE, 40);
          yield* sweep(client);
        }),
      ),
    );

    await expectRows(query, [
      [
        failedEventsOf(FRESH_CHALLENGE),
        '',
        'a payer who reached the code late is still typing it',
      ],
    ]);
  },
};

const AGAIN = 'sp:stall-again';
const AGAIN_ID = 'chk_stall-again';

const pressedAgainMeanwhile: EffectScenario = {
  name: 'card-check stall: a Pay press while WayForPay is being asked is not reported',
  run: async ({ config, query }) => {
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const pressNow = sql`
            UPDATE checkout_sessions SET "claimedAt" = now() WHERE id = ${AGAIN_ID}
          `.pipe(Effect.asVoid, Effect.orDie);
          const { client } = fakeWayForPay(
            { [AGAIN_ID]: otpWait },
            () => pressNow,
          );
          yield* pressed(AGAIN_ID, AGAIN, 30);
          yield* sweep(client);
        }),
      ),
    );

    await expectRows(query, [
      [
        failedEventsOf(AGAIN),
        '',
        'the fresh press keeps the session unreported',
      ],
    ]);
  },
};

const CROWD = 'sp:stall-crowd';
const CROWD_STUCK_ID = 'chk_stall-crowd-stuck';
const CROWD_SIZE = 50;

const notStarved: EffectScenario = {
  name: 'card-check stall: a full batch of older unresolved orders does not hide a newer stuck one',
  run: async ({ config, query }) => {
    const { client } = fakeWayForPay({ [CROWD_STUCK_ID]: otpWait });
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* Effect.forEach(
            Array.from({ length: CROWD_SIZE }, (_, n) => n),
            (n) =>
              pressed(
                `chk_stall-crowd-${String(n)}`,
                `${CROWD}-${String(n)}`,
                120,
              ),
            { discard: true },
          );
          yield* pressed(CROWD_STUCK_ID, `${CROWD}-stuck`, 20);
          yield* sweep(client);
        }),
      ),
    );

    await expectRows(query, [
      [
        failedEventsOf(`${CROWD}-stuck`),
        `evt_w4pstall:${CROWD_STUCK_ID}:card_check_failed|declined`,
        'the newer stuck order is reported in the first pass',
      ],
    ]);
  },
};

export const cardCheckStallScenarios: readonly EffectScenario[] = [
  stuckReportedOnce,
  onlyInsideWindow,
  leftAlone,
  alreadyDeclined,
  freshChallenge,
  pressedAgainMeanwhile,
  notStarved,
];
