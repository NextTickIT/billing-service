import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import {
  type CardCheckFailedEvent,
  type CheckoutSession,
  CheckoutSessionStatus,
  cardCheckMethodOf,
  type DomainEvent,
} from '@billing-service/shared';
import { Clock, Duration, Effect, Option } from 'effect';

import { lockSessionById } from '@/modules/checkout/data-access.js';
import type { WayForPayClient } from '@/modules/wayforpay/client.js';

/**
 * A card check WayForPay never answers (support case @ddeenis, 2026-11-24). The payer's
 * bank asked for a 3-D Secure code that never arrived: the order sits in
 * `WaitingOtpConfirm` for good, no callback ever comes, and the session stays open. The
 * payer's next press hands back the SAME order (`releasePending`), so they are stuck on
 * it, and the CRM never learns of a refusal, so it never offers the fallback (pay now, or
 * the $1 check) it offers after a decline.
 *
 * This sweep asks WayForPay about open card checks pressed a while ago and reports an
 * order whose 3-D Secure challenge went unanswered long enough, or one refused with its
 * callback lost, as the same `card_check_failed{declined}` a decline callback reports.
 * The session stays open, exactly as after a real decline: a late verify still
 * activates it.
 */

/** How long a 3-D Secure challenge must have gone unanswered — counted from WayForPay's
 * own `processingDate` of the challenge, not from our Pay press — before it counts as
 * stuck. Banks expire a challenge within minutes. The same delay after the last press
 * gates which sessions are asked about at all. */
export const CARD_CHECK_STALL_AFTER_SECONDS = 15 * 60;

/** How far back the sweep looks. Orders WayForPay does not know (the payer opened the
 * form and left) are asked about on every pass until they age out of this window. A
 * week reaches back past the oldest stuck order when the sweep shipped (2026-11-20). */
export const CARD_CHECK_STALL_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

/** Pass interval: normally an order is reported within ~25 minutes of an unanswered
 * challenge (a full batch or a WayForPay outage can push that out),
 * and an abandoned order costs at most 144 CHECK_STATUS calls a day while in the
 * window. */
export const CARD_CHECK_STALL_INTERVAL_SECONDS = 10 * 60;

/** Sessions asked about per pass, newest press first: a fresh stuck order is never
 * queued behind older unresolved ones. */
const STALL_BATCH = 50;

/** One CHECK_STATUS, retries included, may take this long; past it the order is left for
 * the next pass and the sweep moves on. */
const CHECK_DEADLINE = Duration.seconds(20);

const CHECK_CONCURRENCY = 5;

/** Refusals WayForPay reports as final — the callback that said so was lost. */
const REFUSED_STATUSES: readonly string[] = ['Declined', 'Expired'];

/** The 3-D Secure wait that never resolves on its own. `InProcessing` and `Pending`
 * (processing, antifraud review) can still succeed and are left alone. */
const CHALLENGE_STATUS = 'WaitingOtpConfirm';

/** What WayForPay says about an order: its status and last processing time. */
export interface OrderState {
  readonly transactionStatus?: string | undefined;
  readonly processingDate?: string | number | null | undefined;
}

const UNIX_SECONDS = /^\d+$/;

const processedAtMillis = (
  raw: OrderState['processingDate'],
): number | null => {
  const text = typeof raw === 'number' ? String(raw) : raw;
  return typeof text === 'string' && UNIX_SECONDS.test(text)
    ? Number(text) * 1000
    : null;
};

/** `stuck` when the payer is due the fallback: the order was refused, or its 3-D Secure
 * challenge went unanswered for the stall delay (a late answer still verifies — the
 * session stays open); `leave` for everything else, including a challenge with no
 * readable processing time. */
export const verdictOf = (
  order: OrderState,
  nowMillis: number,
): 'stuck' | 'leave' => {
  const status = order.transactionStatus;
  if (status !== undefined && REFUSED_STATUSES.includes(status)) return 'stuck';
  if (status !== CHALLENGE_STATUS) return 'leave';
  const processedAt = processedAtMillis(order.processingDate);
  return processedAt !== null &&
    processedAt <= nowMillis - CARD_CHECK_STALL_AFTER_SECONDS * 1000
    ? 'stuck'
    : 'leave';
};

/** WayForPay's answer: the verdict, and what it was read from (for the log). */
interface Observed {
  readonly verdict: 'stuck' | 'leave';
  readonly order: OrderState;
}

const observe = (order: OrderState, nowMillis: number): Observed => ({
  verdict: verdictOf(order, nowMillis),
  order,
});

const LEFT: Observed = { verdict: 'leave', order: {} };

const askWayForPay = (
  client: Pick<WayForPayClient, 'checkStatus'>,
  orderReference: string,
  nowMillis: number,
): Effect.Effect<Observed> =>
  client.checkStatus(orderReference).pipe(
    Effect.map((response) => observe(response, nowMillis)),
    Effect.catchTags({
      // The payer opened the form and left: a retry works, nothing to report.
      W4pOrderNotFoundError: () => Effect.succeed(LEFT),
      W4pApiError: (error) => Effect.succeed(observe(error, nowMillis)),
    }),
    Effect.timeoutFail({
      duration: CHECK_DEADLINE,
      onTimeout: () => 'CHECK_STATUS deadline passed',
    }),
    Effect.catchAll((error) =>
      Effect.logWarning('CARD_CHECK_STALL status unreadable').pipe(
        Effect.annotateLogs({ orderReference, error: String(error) }),
        Effect.as(LEFT),
      ),
    ),
  );

/** The sweep's event: the decline a lost or never-sent callback would have reported. One
 * per session — the id is the session's, so a repeat pass publishes nothing new. */
export const cardCheckStalled = (
  session: CheckoutSession,
  at: Date,
): CardCheckFailedEvent => ({
  id: `evt_w4pstall:${session.id}:card_check_failed`,
  name: 'card_check_failed',
  occurredAt: at,
  correlationId: `w4pstall:${session.id}`,
  externalUserId: session.externalUserId,
  aggregateId: session.id,
  payload: {
    reason: 'declined',
    checkoutSessionId: session.id,
    metadata: session.metadata,
    cardCheckMethod: cardCheckMethodOf(session),
  },
});

/** The time of the last Pay press: `claimedAt`, or the first send for a press released
 * back to Created. */
const LAST_PRESS = `COALESCE(s."claimedAt", s."firstSentToProviderAt")`;

/** Open card checks last pressed between the stall delay and the lookback ago, not
 * reported failed yet; newest press first. */
const candidates = (sql: SqlClient.SqlClient, nowMillis: number) =>
  sql<{ readonly id: string }>`
    SELECT s.id FROM checkout_sessions s
    WHERE s."firstCharge" = 'card_check'
      AND s.status IN (${CheckoutSessionStatus.Created}, ${CheckoutSessionStatus.Pending})
      AND s."firstSentToProviderAt" IS NOT NULL
      AND ${sql.unsafe(LAST_PRESS)}
        <= ${new Date(nowMillis - CARD_CHECK_STALL_AFTER_SECONDS * 1000)}
      AND ${sql.unsafe(LAST_PRESS)}
        > ${new Date(nowMillis - CARD_CHECK_STALL_LOOKBACK_SECONDS * 1000)}
      AND NOT EXISTS (
        SELECT 1 FROM domain_events e
        WHERE e."aggregateId" = s.id AND e.name = 'card_check_failed'
      )
    ORDER BY ${sql.unsafe(LAST_PRESS)} DESC
    LIMIT ${STALL_BATCH}
  `;

export interface CardCheckStallDeps {
  readonly sql: SqlClient.SqlClient;
  readonly client: Pick<WayForPayClient, 'checkStatus'>;
  readonly publish: (
    event: DomainEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

/**
 * Report one stuck session under its row lock, re-deciding everything the candidate
 * query decided: still open, not reported, and not pressed again while WayForPay was
 * being asked (a fresh press restarts the payer's challenge). True iff this call
 * reported it.
 */
const report = (deps: CardCheckStallDeps, id: string, nowMillis: number) =>
  deps.sql.withTransaction(
    Effect.gen(function* () {
      const locked = yield* lockSessionById(deps.sql)(id);
      if (Option.isNone(locked)) return false;
      const eligible = yield* deps.sql<{ readonly id: string }>`
        SELECT s.id FROM checkout_sessions s
        WHERE s.id = ${id}
          AND s.status IN (${CheckoutSessionStatus.Created}, ${CheckoutSessionStatus.Pending})
          AND ${deps.sql.unsafe(LAST_PRESS)}
            <= ${new Date(nowMillis - CARD_CHECK_STALL_AFTER_SECONDS * 1000)}
          AND NOT EXISTS (
            SELECT 1 FROM domain_events e
            WHERE e."aggregateId" = s.id AND e.name = 'card_check_failed'
          )
      `;
      if (eligible.length === 0) return false;
      yield* deps.publish(cardCheckStalled(locked.value, new Date(nowMillis)));
      return true;
    }),
  );

const checkOne = (deps: CardCheckStallDeps, id: string, nowMillis: number) =>
  Effect.gen(function* () {
    const observed = yield* askWayForPay(deps.client, id, nowMillis);
    if (observed.verdict !== 'stuck') return false;
    const reported = yield* report(deps, id, nowMillis);
    if (reported) {
      yield* Effect.logWarning('CARD_CHECK_STALLED reported as declined').pipe(
        Effect.annotateLogs({
          sessionId: id,
          transactionStatus: observed.order.transactionStatus ?? null,
          processingDate: observed.order.processingDate ?? null,
        }),
      );
    }
    return reported;
  });

/** One pass: ask about each candidate, report the stuck ones. Returns how many it reported. */
export const sweepStalledCardChecks = (
  deps: CardCheckStallDeps,
): Effect.Effect<number, SqlError.SqlError> =>
  Effect.gen(function* () {
    const nowMillis = yield* Clock.currentTimeMillis;
    const rows = yield* candidates(deps.sql, nowMillis);
    const results = yield* Effect.forEach(
      rows,
      ({ id }) => checkOne(deps, id, nowMillis),
      { concurrency: CHECK_CONCURRENCY },
    );
    return results.filter(Boolean).length;
  });

/** The sweep, forever, every `intervalSeconds`; a failed pass is logged and the next runs. */
export const runCardCheckStallSweep = (
  deps: CardCheckStallDeps,
  intervalSeconds: number,
): Effect.Effect<never> =>
  sweepStalledCardChecks(deps).pipe(
    Effect.asVoid,
    Effect.catchAllCause((cause) =>
      Effect.logError('card-check stall sweep failed').pipe(
        Effect.annotateLogs('cause', String(cause)),
      ),
    ),
    Effect.andThen(Effect.sleep(Duration.seconds(intervalSeconds))),
    Effect.forever,
  );
