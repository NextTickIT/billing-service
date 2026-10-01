import { SqlClient, type SqlError } from '@effect/sql';
import type { DomainEvent, Payment } from '@billing-service/shared';
import {
  Cause,
  Clock,
  Data,
  Duration,
  Effect,
  Option,
  Schedule,
  Schema,
} from 'effect';

import { withIdempotencyKey } from '@/infra/db/idempotency.js';

import type { Charge } from '@/modules/charge/contracts.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { advanceLocked, isLive } from '@/modules/payment/domain.js';
import { planRetry } from '@/modules/payment/retry.js';
import { PAYMENT_ORDER_PREFIX } from '@/modules/payment/matcher.js';
import type { WayForPayClient } from '@/modules/wayforpay/client.js';
import type { W4pChargeResponse } from '@/modules/wayforpay/contracts.js';
import {
  chargeIncomingEvent,
  chargeRetryFailed,
  type ManualCheckout,
  paymentManualRequired,
  upcomingCharge,
  renewalFailed,
} from '@/modules/billing/events.js';
import { productNameFor } from '@/modules/wayforpay/product.js';

/**
 * The recurring billing scheduler (docs/00 §5.3, FR-004/005/006). Each tick finds
 * due payments and charges the stored token. Success advances the next charge
 * from the period ANCHOR (`currentPeriodEnd`), never the retry date — this is the
 * drift fix (AC-8). Failure walks the fixed 0/1/3/5/7 retry ladder.
 */
export interface SchedulerDeps {
  readonly subs: PaymentRepo;
  readonly client: Pick<WayForPayClient, 'charge'>;
  readonly ingest: (event: Charge) => Effect.Effect<void, SqlError.SqlError>;
  readonly publish: (
    event: DomainEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly lapse: (sub: Payment) => Effect.Effect<void, SqlError.SqlError>;
  /** Best-effort check that the contact cancelled/quarantined on the SendPulse side
   * (by contact tag). Fail-open: the boot wires any SendPulse error to `false` so a
   * SendPulse outage never stalls real renewals (docs/23). */
  readonly upstreamCancelled: (sub: Payment) => Effect.Effect<boolean>;
  /** Cancel locally because the contact cancelled upstream: flip to cancelled +
   * record payment_cancelled. No charge, no retry ladder. */
  readonly cancelUpstream: (
    sub: Payment,
    now: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /** Mint OUR internal checkout session for a token-less (crypto) renewal and return its
   * link + live window, so the manual-pay prompt can point the user at it (docs/28). Fails
   * with `ForeignManualCheckout` when the cycle's key is held by a session that is not
   * this sub's: the prompt is withheld, but the ladder still advances. */
  readonly createManualCheckout: (
    sub: Payment,
    now: Date,
  ) => Effect.Effect<ManualCheckout, SqlError.SqlError | ForeignManualCheckout>;
  /** Run the post-charge write as ONE transaction under the persistent per-attempt claim
   * `scheduler.advance:{orderReference}` (the idempotency ledger): the first run commits
   * the claim with its result, a later run for the same attempt replays it untouched. */
  readonly claimAdvance: (
    orderReference: string,
  ) => <E>(
    effect: Effect.Effect<boolean, E>,
  ) => Effect.Effect<boolean, E | SqlError.SqlError>;
}

/** The production `claimAdvance`: the idempotency ledger under scope `scheduler.advance`,
 * whose own transaction is tx 2 (`advanceLocked` and the ingest enqueue nest in it). */
export const ledgerClaimAdvance =
  (sql: SqlClient.SqlClient): SchedulerDeps['claimAdvance'] =>
  (orderReference) =>
  (effect) =>
    withIdempotencyKey(
      'scheduler.advance',
      orderReference,
      Schema.Boolean,
    )(effect).pipe(Effect.provideService(SqlClient.SqlClient, sql));

/** The manual-renewal key of this cycle is held by a session that does not renew this
 * sub, so its link must not be sent to the contact (the minter has already alerted). */
export class ForeignManualCheckout extends Data.TaggedError(
  'ForeignManualCheckout',
)<{
  readonly paymentId: string;
  readonly idempotencyKey: string;
}> {}

export interface SchedulerConfig {
  readonly intervalSeconds: number;
  readonly batchSize: number;
  /** Days before a charge to announce it; empty disables the notice sweep. */
  readonly upcomingChargeNoticeDays: readonly number[];
}

/** Deterministic per attempt: the timestamp changes only when the schedule moves. */
const orderReferenceFor = (sub: Payment): string =>
  `${PAYMENT_ORDER_PREFIX}${sub.id}_${sub.nextPaymentDate.getTime().toString()}`;

/**
 * Bounded retry of the post-charge write (tx 2). The money is already taken, and the next
 * tick would re-charge the same `orderReference` because `nextPaymentDate` has not moved —
 * so a transient DB fault gets a few quick retries before we give up and alert.
 */
const SETTLE_RETRY = Schedule.exponential(Duration.millis(200)).pipe(
  Schedule.intersect(Schedule.recurs(3)),
);

/**
 * Per-process scheduler state. `unrecorded` holds subs whose Approved charge could not be
 * recorded even after the bounded retry: they are skipped until a restart, so the same
 * `orderReference` is never re-charged every tick while OPERATOR reconciles by hand.
 * Deliberately in memory (one worker): a restart retries once and re-alerts.
 */
export interface SchedulerState {
  readonly unrecorded: Set<string>;
}

export const makeSchedulerState = (): SchedulerState => ({
  unrecorded: new Set(),
});

/** What one tick's per-sub work shares. */
interface TickContext {
  readonly deps: SchedulerDeps;
  readonly state: SchedulerState;
  readonly now: Date;
}

/**
 * Run a decline-path write under the row lock, but only while the row is still the one we
 * charged: live, and due on the same instant. A prolongation (or defer) that committed
 * after the charge moved `nextPaymentDate`, so the stale decline is skipped together with
 * its event — the payment is paid up and owes nothing.
 */
const whileUnmoved = (
  deps: SchedulerDeps,
  charged: Payment,
  write: (locked: Payment) => Effect.Effect<void, SqlError.SqlError>,
) =>
  deps.subs.transaction(
    Effect.gen(function* () {
      const locked = yield* deps.subs.lockById(charged.id);
      if (
        Option.isNone(locked) ||
        !isLive(locked.value) ||
        locked.value.nextPaymentDate.getTime() !==
          charged.nextPaymentDate.getTime()
      ) {
        yield* Effect.logInfo(
          'scheduler: outcome skipped, payment moved since the charge',
        ).pipe(Effect.annotateLogs('paymentId', charged.id));
        return;
      }
      yield* write(locked.value);
    }),
  );

const onFailure = (
  deps: SchedulerDeps,
  sub: Payment,
  reason: string,
  now: Date,
) =>
  whileUnmoved(deps, sub, (locked) =>
    Effect.gen(function* () {
      const firstFailureAt = locked.firstFailureAt ?? now;
      const plan = planRetry(locked.retryAttempt, firstFailureAt);
      if (plan.final || plan.nextPaymentDate === null) {
        yield* deps.subs.markRenewalFailed(locked.id);
        yield* deps.publish(renewalFailed(locked, reason, now));
        return;
      }
      yield* deps.subs.recordRetry(locked.id, {
        firstFailureAt,
        retryAttempt: plan.attempt,
        nextPaymentDate: plan.nextPaymentDate,
      });
      yield* deps.publish(
        chargeRetryFailed(
          locked,
          {
            attempt: plan.attempt,
            nextRetryDate: plan.nextPaymentDate,
            reason,
          },
          now,
        ),
      );
    }),
  );

/**
 * A token-less (crypto) renewal came due (docs/28): we cannot autocharge, so we prompt the
 * user to pay again at OUR internal checkout. The attempt rides the SAME retry ladder as a
 * card failure — re-prompting on each scheduled date — and the exhausted ladder lapses to
 * `renewal_failed`. Paying the session extends the payment (and a card pay captures a token,
 * graduating it back to autocharge next cycle). We check the ladder BEFORE prompting so the
 * giving-up tick emits only `renewal_failed`, never a fresh prompt.
 */
const promptManual = (deps: SchedulerDeps, sub: Payment, now: Date) =>
  Effect.gen(function* () {
    const firstFailureAt = sub.firstFailureAt ?? now;
    const plan = planRetry(sub.retryAttempt, firstFailureAt);
    if (plan.final || plan.nextPaymentDate === null) {
      yield* whileUnmoved(deps, sub, (locked) =>
        deps.subs
          .markRenewalFailed(locked.id)
          .pipe(
            Effect.andThen(
              deps.publish(
                renewalFailed(locked, 'manual payment not completed', now),
              ),
            ),
          ),
      );
      return;
    }
    // Still within the ladder: mint our checkout link (DB only, outside the lock) and
    // prompt. Publish BEFORE recordRetry so the event carries this attempt's due date
    // (recordRetry moves it). A link we must not send withholds only the prompt: the
    // ladder still advances, so the sub reaches `renewal_failed` instead of stalling.
    const checkout = yield* deps
      .createManualCheckout(sub, now)
      .pipe(
        Effect.catchTag('ForeignManualCheckout', () => Effect.succeed(null)),
      );
    // Non-null here (the final case returned above) and the date recordRetry is about to
    // write, so the prompt names the same next date the ladder will actually use.
    const nextPaymentDate = plan.nextPaymentDate;
    const ladder = { attempt: plan.attempt, nextRetryDate: nextPaymentDate };
    yield* whileUnmoved(deps, sub, (locked) =>
      (checkout === null
        ? Effect.void
        : deps.publish(paymentManualRequired(locked, checkout, now, ladder))
      ).pipe(
        Effect.andThen(
          deps.subs.recordRetry(locked.id, {
            firstFailureAt,
            retryAttempt: plan.attempt,
            nextPaymentDate,
          }),
        ),
      ),
    );
  });

/**
 * Record an Approved charge (tx 2): advance from the locked anchor and feed the success
 * back through the pipeline, committed together under the `scheduler.advance` claim on
 * this `orderReference` — a duplicate Approved for the same attempt replays instead of
 * advancing twice, and a crash can never credit the period without its money event.
 * A prolongation that committed after the charge is stacked on, never overwritten.
 */
const recordApproved = (
  { deps, state, now }: TickContext,
  sub: Payment,
  orderReference: string,
  response: W4pChargeResponse,
) =>
  deps
    .claimAdvance(orderReference)(
      Effect.gen(function* () {
        const advanced = yield* advanceLocked(deps.subs)(
          sub.id,
          sub.period,
          now,
          isLive,
        ).pipe(Effect.map(Option.isSome));
        yield* deps.ingest(
          chargeIncomingEvent(sub, orderReference, response, now),
        );
        return advanced;
      }),
    )
    .pipe(
      // Typed failures here are SqlErrors only; a defect is not retried and goes
      // straight to the alert below.
      Effect.retry(SETTLE_RETRY),
      Effect.asVoid,
      Effect.catchAllCause((cause) =>
        Effect.logError(
          'SETTLEMENT_ANOMALY scheduler: approved charge not recorded',
        ).pipe(
          Effect.annotateLogs({
            paymentId: sub.id,
            orderReference,
            cause: Cause.pretty(cause),
          }),
          Effect.andThen(
            Effect.sync(() => {
              state.unrecorded.add(sub.id);
            }),
          ),
        ),
      ),
    );

/** Charge the stored card token (no lock or transaction held across the HTTP call) and
 * settle the outcome: approve → advance from the anchor + feed the success back through
 * the pipeline; decline → the retry ladder. */
const chargeCard = (ctx: TickContext, sub: Payment) =>
  Effect.gen(function* () {
    const { deps, now } = ctx;
    const orderReference = orderReferenceFor(sub);
    const response = yield* deps.client.charge({
      orderReference,
      amount: sub.amount,
      currency: sub.currency,
      recToken: sub.recurringTokenRef ?? '',
      orderDate: Math.floor(now.getTime() / 1000),
      productName: productNameFor(sub),
    });
    if (response.transactionStatus === 'Approved') {
      return yield* recordApproved(ctx, sub, orderReference, response);
    }
    yield* onFailure(deps, sub, response.reason ?? 'charge declined', now);
  });

/**
 * tx 1: re-read the `findDue` snapshot under the row lock and commit straight away. The
 * row is still ours to act on only if it is live, still due, and its cancel state has not
 * changed; a prolongation that landed since the snapshot moved `nextPaymentDate` out.
 * The branches below use this locked read, never the snapshot: a prolongation may have
 * adopted new terms or a new token.
 */
const recheckDue = (deps: SchedulerDeps, snapshot: Payment, now: Date) =>
  deps.subs
    .transaction(deps.subs.lockById(snapshot.id))
    .pipe(
      Effect.map(
        Option.filter(
          (locked) =>
            isLive(locked) &&
            locked.nextPaymentDate.getTime() <= now.getTime() &&
            (locked.cancelRequestedAt?.getTime() ?? null) ===
              (snapshot.cancelRequestedAt?.getTime() ?? null),
        ),
      ),
    );

/** The locked row to act on, or None (logged) when this sub is skipped this tick. */
const actionable = (ctx: TickContext, snapshot: Payment) =>
  Effect.gen(function* () {
    if (ctx.state.unrecorded.has(snapshot.id)) {
      yield* Effect.logWarning(
        'scheduler: skipped, unrecorded approved charge pending',
      ).pipe(Effect.annotateLogs('paymentId', snapshot.id));
      return Option.none<Payment>();
    }
    const recheck = yield* recheckDue(ctx.deps, snapshot, ctx.now);
    if (Option.isNone(recheck)) {
      yield* Effect.logInfo('scheduler: skipped, no longer due').pipe(
        Effect.annotateLogs('paymentId', snapshot.id),
      );
    }
    return recheck;
  });

const chargeOne = (ctx: TickContext, snapshot: Payment) =>
  Effect.gen(function* () {
    const { deps, now } = ctx;
    const recheck = yield* actionable(ctx, snapshot);
    if (Option.isNone(recheck)) {
      return;
    }
    const sub = recheck.value;
    if (sub.cancelRequestedAt !== null) {
      // A soft-cancelled payment lapses at the due date instead of charging —
      // no charge, no retry ladder (docs/23). The lapse is enqueued (not published
      // inline) so the worker-owned outbox emits the terminal event durably.
      yield* deps.lapse(sub);
      return;
    }
    if (yield* deps.upstreamCancelled(sub)) {
      // The contact cancelled/quarantined on the SendPulse side — cancel on our
      // side and never attempt the charge (docs/23). Applies to card AND crypto
      // renewals (checked before the token branch below).
      yield* deps.cancelUpstream(sub, now);
      return;
    }
    if (sub.recurringTokenRef === null) {
      // No reusable token (WhitePay crypto): can't autocharge — prompt the user to pay
      // again at our internal checkout (docs/28) instead.
      return yield* promptManual(deps, sub, now);
    }
    yield* chargeCard(ctx, sub);
  });

/**
 * Send advance notices for charges coming up on each configured offset.
 *
 * Runs on the same tick as the charge sweep but is strictly read-then-publish: it never
 * charges and never moves a date, so a failure here can only cost a notice, never money.
 * Exactly-once comes from the event id, which pins (payment, due date, offset) — the
 * outbox's `ON CONFLICT (id) DO NOTHING` absorbs every re-run, so a 5-minute tick does
 * not mean a notice every 5 minutes.
 */
const noticeSweep = (deps: SchedulerDeps, config: SchedulerConfig, now: Date) =>
  Effect.forEach(
    config.upcomingChargeNoticeDays,
    (days) =>
      Effect.gen(function* () {
        const upcoming = yield* deps.subs.findUpcomingForNotice(
          days,
          config.batchSize,
        );
        // Isolate each notice: one bad row must not cost the rest their warning.
        yield* Effect.forEach(
          upcoming,
          (sub) =>
            deps.publish(upcomingCharge(sub, days, now)).pipe(
              Effect.catchAllCause((cause) =>
                Effect.logError('scheduler: notice failed').pipe(
                  Effect.annotateLogs({
                    paymentId: sub.id,
                    noticeDays: days,
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
            ),
          { discard: true },
        );
      }),
    { discard: true },
  );

export const scheduleTick = (
  deps: SchedulerDeps,
  config: SchedulerConfig,
  state: SchedulerState = makeSchedulerState(),
): Effect.Effect<number, SqlError.SqlError> =>
  Effect.gen(function* () {
    const now = new Date(yield* Clock.currentTimeMillis);
    const due = yield* deps.subs.findDue(now, config.batchSize);
    // Isolate each payment: one failed charge must not abort the batch.
    yield* Effect.forEach(
      due,
      (sub) =>
        chargeOne({ deps, state, now }, sub).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError('scheduler: charge failed').pipe(
              Effect.annotateLogs({
                paymentId: sub.id,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
      { discard: true },
    );
    // After charging: a payment charged on this very tick has had its next date moved
    // forward, so it cannot also be announced as "coming up" in the same pass.
    yield* noticeSweep(deps, config, now).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logError('scheduler: notice sweep failed').pipe(
          Effect.annotateLogs('cause', Cause.pretty(cause)),
        ),
      ),
    );
    return due.length;
  });

export const runScheduler = (
  deps: SchedulerDeps,
  config: SchedulerConfig,
): Effect.Effect<never> =>
  Effect.suspend(() => {
    // One state per scheduler fiber: it lives exactly as long as the process.
    const state = makeSchedulerState();
    return scheduleTick(deps, config, state).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logError('scheduler tick failed').pipe(
          Effect.annotateLogs('cause', Cause.pretty(cause)),
        ),
      ),
      Effect.andThen(Effect.sleep(Duration.seconds(config.intervalSeconds))),
      Effect.forever,
    );
  });
