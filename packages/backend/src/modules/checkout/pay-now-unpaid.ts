import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { CheckoutSessionStatus } from '@billing-service/shared';
import { Clock, Duration, Effect, Ref } from 'effect';

import {
  type OrderState,
  verdictOf,
} from '@/modules/checkout/card-check-stall.js';
import { closeUnpaidPayNow } from '@/modules/checkout/data-access.js';
import type { WayForPayClient } from '@/modules/wayforpay/client.js';

/**
 * A pay-now migration session whose bank confirmation failed (support case @nameBigBoss,
 * 2026-11-25): WayForPay declined it, its `payableUntil` lapsed, and it stayed Pending, so
 * the caller could only see an unresolved attempt and sent the member to a manager. This
 * sweep asks WayForPay about open pay-now sessions whose `payableUntil` lapsed a while
 * ago and closes as `unpaid` the ones whose order WayForPay refused, does not know, or
 * holds on a bank confirmation nobody answered. The caller reads the Closed session on
 * the member's next click and offers a new attempt; no event is published.
 */

/** How long after `payableUntil` a session is first asked about: a payer who pressed Pay
 * just before it may still be typing the bank's code. A `WaitingOtpConfirm` order is
 * judged by the card-check stall rule (`verdictOf`), the same delay counted from
 * WayForPay's `processingDate`. */
export const PAY_NOW_UNPAID_AFTER_SECONDS = 15 * 60;

/** How far back the sweep looks: an order WayForPay keeps answering in flight is asked
 * about on every traversal until it ages out. A week reaches the oldest stuck migration
 * attempt when the sweep shipped. */
export const PAY_NOW_UNPAID_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

/** Pass interval: while there are at most a batch of candidates, a lapsed unpaid session
 * closes within ~25 minutes of `payableUntil`; with N candidates, within about ceil(N / batch)
 * passes of becoming one. */
export const PAY_NOW_UNPAID_INTERVAL_SECONDS = 10 * 60;

/** Sessions asked about per pass, the hard CHECK_STATUS budget of a pass. A pass picks up
 * behind the last one (most recently lapsed first) and starts again from the top once it
 * reaches the end, so sessions WayForPay keeps answering in flight never hide an older
 * refused one: with N candidates each is asked once every ceil(N / batch) passes. */
export const UNPAID_BATCH = 50;

/** One CHECK_STATUS, retries included, may take this long; past it the session is left
 * open and asked again when the traversal next reaches it. */
const CHECK_DEADLINE = Duration.seconds(20);

const CHECK_CONCURRENCY = 5;

/** What WayForPay said about the order: its state, that it never saw the order, or
 * nothing readable (an outage, a timeout, an error without a status). */
export type UnpaidAnswer =
  | { readonly kind: 'order'; readonly order: OrderState }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unreadable' };

/** `close` when billing stops waiting for this order: it was refused, WayForPay never saw
 * it (the payer left the form), or its bank confirmation went unanswered for the delay.
 * WayForPay can still take money on it later (its repayUrl); billing then refuses to
 * credit it and quarantines the charge for a refund. `leave` for an order that may still
 * succeed and for an answer we could not read. */
export const unpaidVerdictOf = (
  answer: UnpaidAnswer,
  nowMillis: number,
): 'close' | 'leave' => {
  switch (answer.kind) {
    case 'not_found':
      return 'close';
    case 'unreadable':
      return 'leave';
    case 'order':
      return verdictOf(answer.order, nowMillis) === 'stuck' ? 'close' : 'leave';
  }
};

const UNREADABLE: UnpaidAnswer = { kind: 'unreadable' };

const askWayForPay = (
  client: Pick<WayForPayClient, 'checkStatus'>,
  orderReference: string,
): Effect.Effect<UnpaidAnswer> =>
  client.checkStatus(orderReference).pipe(
    Effect.map((order): UnpaidAnswer => ({ kind: 'order', order })),
    Effect.catchTags({
      W4pOrderNotFoundError: () =>
        Effect.succeed<UnpaidAnswer>({ kind: 'not_found' }),
      // A refusal comes back as a non-OK reason code that still carries the status.
      W4pApiError: (order) =>
        Effect.succeed<UnpaidAnswer>({ kind: 'order', order }),
    }),
    Effect.timeoutFail({
      duration: CHECK_DEADLINE,
      onTimeout: () => 'CHECK_STATUS deadline passed',
    }),
    Effect.catchAll((error) =>
      Effect.logWarning('PAY_NOW_UNPAID status unreadable').pipe(
        Effect.annotateLogs({ orderReference, error: String(error) }),
        Effect.as(UNREADABLE),
      ),
    ),
  );

/** Where the last pass stopped: the last session it asked about, in the sweep's order. */
export interface UnpaidCursor {
  readonly payableUntil: Date;
  readonly id: string;
}

interface Candidate {
  readonly id: string;
  readonly payableUntil: Date;
}

/** Open pay-now sessions sent to WayForPay, with no options, whose `payableUntil` lapsed
 * between the delay and the lookback ago, behind `after`; most recently lapsed first, at
 * most `limit`. */
const candidates = (
  sql: SqlClient.SqlClient,
  nowMillis: number,
  after: UnpaidCursor | null,
  limit: number,
) =>
  sql<Candidate>`
    SELECT s.id, s."payableUntil" FROM checkout_sessions s
    WHERE s."firstCharge" = 'now'
      AND s.status IN (${CheckoutSessionStatus.Created}, ${CheckoutSessionStatus.Pending})
      AND s."firstSentToProviderAt" IS NOT NULL
      AND s.options IS NULL
      AND s."payableUntil" IS NOT NULL
      AND s."payableUntil"
        <= ${new Date(nowMillis - PAY_NOW_UNPAID_AFTER_SECONDS * 1000)}
      AND s."payableUntil"
        > ${new Date(nowMillis - PAY_NOW_UNPAID_LOOKBACK_SECONDS * 1000)}
      ${
        after === null
          ? sql``
          : sql`AND (s."payableUntil", s.id) < (${after.payableUntil}, ${after.id})`
      }
    ORDER BY s."payableUntil" DESC, s.id DESC
    LIMIT ${limit}
  `;

export interface PayNowUnpaidDeps {
  readonly sql: SqlClient.SqlClient;
  readonly client: Pick<WayForPayClient, 'checkStatus'>;
}

const answerLog = (answer: UnpaidAnswer) =>
  answer.kind === 'order'
    ? {
        transactionStatus: answer.order.transactionStatus ?? null,
        processingDate: answer.order.processingDate ?? null,
      }
    : { transactionStatus: answer.kind, processingDate: null };

const checkOne = (deps: PayNowUnpaidDeps, id: string, nowMillis: number) =>
  Effect.gen(function* () {
    const answer = yield* askWayForPay(deps.client, id);
    if (unpaidVerdictOf(answer, nowMillis) !== 'close') return false;
    const closed = yield* closeUnpaidPayNow(deps.sql)(
      id,
      new Date(nowMillis - PAY_NOW_UNPAID_AFTER_SECONDS * 1000),
    );
    if (closed) {
      yield* Effect.logWarning('CHECKOUT_UNPAID_CLOSED').pipe(
        Effect.annotateLogs({ sessionId: id, ...answerLog(answer) }),
      );
    }
    return closed;
  });

export interface UnpaidPass {
  /** How many sessions this pass closed. */
  readonly closed: number;
  /** Where the next pass picks up; null to start again from the most recently lapsed. */
  readonly next: UnpaidCursor | null;
}

/**
 * One pass behind `after`: ask about each candidate of the batch, close the unpaid ones.
 * One more row than the batch is read to tell whether anything lies behind it, so a batch
 * that ends exactly at the last candidate starts the next pass from the top.
 */
export const sweepUnpaidPayNow = (
  deps: PayNowUnpaidDeps,
  after: UnpaidCursor | null = null,
): Effect.Effect<UnpaidPass, SqlError.SqlError> =>
  Effect.gen(function* () {
    const nowMillis = yield* Clock.currentTimeMillis;
    const read = yield* candidates(
      deps.sql,
      nowMillis,
      after,
      UNPAID_BATCH + 1,
    );
    const batch = read.slice(0, UNPAID_BATCH);
    const results = yield* Effect.forEach(
      batch,
      ({ id }) => checkOne(deps, id, nowMillis),
      { concurrency: CHECK_CONCURRENCY },
    );
    const last = read.length > UNPAID_BATCH ? batch.at(-1) : undefined;
    return {
      closed: results.filter(Boolean).length,
      next:
        last === undefined
          ? null
          : { payableUntil: last.payableUntil, id: last.id },
    };
  });

/** The sweep, forever, every `intervalSeconds`, each pass picking up where the last one
 * stopped; a failed pass is logged and the next starts from the same place. */
export const runPayNowUnpaidSweep = (
  deps: PayNowUnpaidDeps,
  intervalSeconds: number,
): Effect.Effect<never> =>
  Effect.flatMap(Ref.make<UnpaidCursor | null>(null), (cursor) =>
    Ref.get(cursor).pipe(
      Effect.flatMap((after) => sweepUnpaidPayNow(deps, after)),
      Effect.flatMap(({ next }) => Ref.set(cursor, next)),
      Effect.catchAllCause((cause) =>
        Effect.logError('pay-now unpaid sweep failed').pipe(
          Effect.annotateLogs('cause', String(cause)),
        ),
      ),
      Effect.andThen(Effect.sleep(Duration.seconds(intervalSeconds))),
      Effect.forever,
    ),
  );
