import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import { type Payment, PaymentMethod } from '@billing-service/shared';

import { cycleOptions, prolongSession } from '@/modules/checkout/domain.js';

import type { Scenario } from './http-harness.js';
import {
  assertMethodLocked,
  cardOrderOf,
  CREATED,
  cyclesOffered,
  endDateOf,
  eventsOf,
  FAR,
  type Http,
  httpContext,
  insertSessions,
  onApp,
  PAST,
  pay,
  publicRead,
  rowOf,
  scalar,
  seedSubs,
  statusOf,
  w4pCallback,
  withWhitePayApp,
} from './prolong.e2e.js';

/**
 * HTTP e2e for the pay-now link the notice sweep mints (plan B6, B8a): a prolong session
 * keyed `paynow:<subId>:<dueMs>`, renewing the sub, offering the configured cycles. The
 * minter itself is proven in the Effect tier; here the sessions are inserted directly
 * with the shape it writes, and the public read, `/pay`, the re-mint of a lapsed link and
 * the provider callback run end to end.
 */

/** Paid through Dec 1, P4W at 30000 (the seed's default terms). */
const END = new Date('2026-12-01T00:00:00Z');
const ONE_THREE_SIX = [
  [30000, 1],
  [90000, 3],
  [180000, 6],
];

/** Session ids as every real minter writes them (`chk_<uuid>`): only that shape has its
 * option suffix (`_c3`) parsed back off a provider reference, so a hand-picked id would
 * quarantine the callback instead of settling it. */
const ID = {
  n1: `chk_${randomUUID()}`,
  n2: `chk_${randomUUID()}`,
  n3: `chk_${randomUUID()}`,
  n4: `chk_${randomUUID()}`,
  n5: `chk_${randomUUID()}`,
};

/** The pay-now session for `sub`'s due date, as the minter writes it. */
const payNowSession = (
  sub: Payment,
  id: string,
  expiresAt: Date,
  cycles: readonly number[],
) => ({
  ...prolongSession(
    sub,
    id,
    expiresAt,
    `paynow:${sub.id}:${String(sub.nextPaymentDate.getTime())}`,
  ),
  options: cycleOptions(cycles),
});

// ---------------------------------------------------------------------------------
// N1 — a pay-now link with the knob at its default "1" is a single-cycle prolong page.
// ---------------------------------------------------------------------------------

const n1SingleCycle = async (http: Http, sub: Payment) => {
  await insertSessions([payNowSession(sub, ID.n1, FAR, [1])]);
  assert.equal(
    await scalar(
      http,
      `SELECT options IS NULL FROM checkout_sessions WHERE id = '${ID.n1}'`,
    ),
    't',
    'cycleOptions([1]) stores no options',
  );
  const read = await publicRead(http, ID.n1);
  assert.equal(read['prolong'], true, 'a prolong page');
  assert.equal(read['methodLocked'], true);
  assert.equal((read['options'] as unknown[]).length, 1, 'one option');
  assert.deepEqual(
    cyclesOffered(read),
    [[30000, null]],
    "today's single-cycle prolong page: the flat option at the sub amount, cycles null",
  );
};

// ---------------------------------------------------------------------------------
// N2 — a pay-now link with cycles: read, `_c3` at 3x, method lock.
// ---------------------------------------------------------------------------------

const n2Cycles = async (http: Http, sub: Payment) => {
  await insertSessions([payNowSession(sub, ID.n2, FAR, [1, 3, 6])]);
  const read = await publicRead(http, ID.n2);
  assert.equal(read['prolong'], true);
  assert.deepEqual(cyclesOffered(read), ONE_THREE_SIX);
  const crypto = await pay(http, ID.n2, PaymentMethod.Crypto, 1);
  assertMethodLocked(
    crypto,
    PaymentMethod.Card,
    'Crypto on a card pay-now link',
  );
  assert.equal(await statusOf(http, ID.n2), CREATED, 'nothing claimed');
  const order = cardOrderOf(
    await pay(http, ID.n2, PaymentMethod.Card, 1),
    'c3',
  );
  assert.deepEqual(order, { ref: `${ID.n2}_c3`, amount: 900 }, '_c3 at 3x');
};

const n1n2Scenario: Scenario = {
  name: 'pay-now (N1, N2): a link minted with "1" reads as one option + prolong; with 1,3,6 option 1 is chk_<id>_c3 at 3x and the wrong method is 400 method_locked',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'n12-svc');
    const subOf = await seedSubs([
      { externalUserId: 'sp:n1', end: END },
      { externalUserId: 'sp:n2', end: END },
    ]);
    await n1SingleCycle(http, subOf('sp:n1'));
    await n2Cycles(http, subOf('sp:n2'));
  },
};

// ---------------------------------------------------------------------------------
// N3 — a lapsed pay-now link re-mints with its cycles and pays `_c3`.
// ---------------------------------------------------------------------------------

const N3 = 'sp:n3';

const n3LapsedKeepsCycles = async (http: Http, sub: Payment) => {
  await insertSessions([payNowSession(sub, ID.n3, PAST, [1, 3, 6])]);
  const order = cardOrderOf(
    await pay(http, ID.n3, PaymentMethod.Card, 1),
    'lapsed c3',
  );
  const replacement = order.ref.replace(/_c3$/, '');
  assert.notEqual(replacement, ID.n3, 're-minted under a fresh id');
  assert.equal(order.ref, `${replacement}_c3`, 'the pick is still 3 cycles');
  assert.equal(order.amount, 900, 'at 3x the sub amount');
  assert.equal(
    await scalar(
      http,
      `SELECT origin || '|' || "renewalOf" || '|' || method || '|' || (options IS NOT NULL) FROM checkout_sessions WHERE id = '${replacement}'`,
    ),
    `prolong|${sub.id}|${String(PaymentMethod.Card)}|true`,
    'a card-locked prolong for the same sub, cycles kept',
  );
  assert.deepEqual(
    cyclesOffered(await publicRead(http, replacement)),
    ONE_THREE_SIX,
  );
  await w4pCallback(http, 'Approved', order);
  assert.equal(await endDateOf(http, sub.id), '2027-02-23', '3 x P4W on Dec 1');
  assert.equal(
    await eventsOf(http, N3),
    `recurring_payment_succeeded:${sub.id}`,
  );
};

const n3Scenario: Scenario = {
  name: 'pay-now (N3): a lapsed link with cycles and a live sub re-mints with its cycles kept and pays _c3 (3 periods stacked)',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'n3-svc');
    const subOf = await seedSubs([{ externalUserId: N3, end: END }]);
    await withWhitePayApp(async (url) => {
      await n3LapsedKeepsCycles(await onApp(http, url), subOf(N3));
    });
  },
};

// ---------------------------------------------------------------------------------
// N4 — a declined `_c3` leaves the sub alone and the link payable (AC 9).
// ---------------------------------------------------------------------------------

const N4 = 'sp:n4';

const n4DeclineThenPay = async (http: Http, sub: Payment) => {
  await insertSessions([payNowSession(sub, ID.n4, FAR, [1, 3, 6])]);
  const before = await rowOf(http, sub.id);
  const order = cardOrderOf(
    await pay(http, ID.n4, PaymentMethod.Card, 1),
    'c3',
  );
  assert.deepEqual(order, { ref: `${ID.n4}_c3`, amount: 900 });
  await w4pCallback(http, 'Declined', order);
  assert.equal(await rowOf(http, sub.id), before, 'payments byte-identical');
  assert.equal(await eventsOf(http, N4), `recurring_payment_failed:${sub.id}`);
  // Limit of this proof: after the decline the session is still Pending, and this second
  // `/pay` releases and re-claims it with the SAME chk_<id>_c3 reference. The e2e
  // WayForPay double accepts a repeat of a declined reference; whether WayForPay does is
  // not proven here (today's AC 9 rests on the same premise for every checkout).
  const again = cardOrderOf(
    await pay(http, ID.n4, PaymentMethod.Card, 1),
    'again',
  );
  assert.deepEqual(again, order, 'the same order is handed out again');
  await w4pCallback(http, 'Approved', again);
  await w4pCallback(http, 'Approved', again);
  assert.equal(await endDateOf(http, sub.id), '2027-02-23', '3 x P4W, once');
  assert.equal(
    await eventsOf(http, N4),
    `recurring_payment_failed:${sub.id},recurring_payment_succeeded:${sub.id}`,
    'one failure, then exactly one success',
  );
};

const n4Scenario: Scenario = {
  name: 'pay-now (N4): a declined _c3 leaves payments byte-identical with recurring_payment_failed; a second /pay is 200 and its callback stacks 3 cycles exactly once',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'n4-svc');
    const subOf = await seedSubs([{ externalUserId: N4, end: END }]);
    await withWhitePayApp(async (url) => {
      await n4DeclineThenPay(await onApp(http, url), subOf(N4));
    });
  },
};

// ---------------------------------------------------------------------------------
// N5 — `/pay` stamps `claimedAt`; a failed provider mint releases the claim and clears it.
// ---------------------------------------------------------------------------------

const N5 = 'sp:n5';

/** A port nothing listens on: the WhitePay mint fails in transport, as in an outage. */
const DEAD_WHITEPAY = { WHITEPAY_API_URL: 'http://127.0.0.1:1' };

const claimedAtOf = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT CASE WHEN "claimedAt" IS NULL THEN 'null'
                 WHEN now() - "claimedAt" < interval '5 minutes' THEN 'recent'
                 ELSE 'stale' END
       FROM checkout_sessions WHERE id = '${id}'`,
  );

const n5Claim = async (http: Http, url: string) => {
  const claimed = await pay(
    await onApp(http, url),
    ID.n5,
    PaymentMethod.Crypto,
  );
  assert.equal(claimed.status, 200, 'the crypto mint succeeded');
  assert.equal(await claimedAtOf(http, ID.n5), 'recent', 'stamped by /pay');
};

const n5FailedMint = async (http: Http, url: string) => {
  const failed = await pay(await onApp(http, url), ID.n5, PaymentMethod.Crypto);
  assert.notEqual(failed.status, 200, 'the WhitePay mint failed');
  assert.equal(await statusOf(http, ID.n5), CREATED, 'released');
  assert.equal(await claimedAtOf(http, ID.n5), 'null', 'claimedAt cleared');
};

const n5Scenario: Scenario = {
  name: 'pay-now (N5): claimedAt is NULL on insert, set by /pay, and NULL again after a failed WhitePay mint releases the claim',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'n5-svc');
    const subOf = await seedSubs([
      {
        externalUserId: N5,
        end: END,
        method: PaymentMethod.Crypto,
        token: null,
        currency: 1,
      },
    ]);
    await insertSessions([payNowSession(subOf(N5), ID.n5, FAR, [1])]);
    assert.equal(await claimedAtOf(http, ID.n5), 'null', 'unclaimed');
    await withWhitePayApp((url) => n5Claim(http, url));
    await withWhitePayApp((url) => n5FailedMint(http, url), DEAD_WHITEPAY);
  },
};

export const payNowScenarios: readonly Scenario[] = [
  n1n2Scenario,
  n3Scenario,
  n4Scenario,
  n5Scenario,
];
