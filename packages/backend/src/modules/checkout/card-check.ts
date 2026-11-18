import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import {
  type CardCheckAnomalyEvent,
  type CardCheckFailedEvent,
  cardCheckMethodOf,
  type CheckoutSession,
  CheckoutSessionStatus,
  Currency,
  currencyFromCode,
  parseCheckoutRef,
  type PaymentCreatedEvent,
  PaymentMethod,
  type SubscriptionCardCheckedEvent,
} from '@billing-service/shared';
import { Clock, Effect, Option } from 'effect';

import type {
  CardCheckSettle,
  CardCheckStep,
  Charge,
} from '@/modules/charge/contracts.js';
import { enqueue } from '@/infra/queue/store.js';
import {
  CARD_CHECK_REFUND,
  type CardCheckRefundTask,
  refundTaskKey,
} from '@/modules/checkout/card-check-refund.js';
import {
  closeOpenCardCheck,
  lockSessionById,
  makeCheckoutRepo,
  markVerifyRefundOwed,
  settleVerifyRefund,
} from '@/modules/checkout/data-access.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import {
  type ApplyPaymentResult,
  createOrExtend,
} from '@/modules/payment/domain.js';

/**
 * Card-check dispatch (plan wfp-migration-card-check §1.3). A card-check session's
 * callback carries a 0-UAH WayForPay verify (`lookup`) or a small USD charge billing
 * refunds (`charge_refund`), never the plan's money, so no ordinary path may settle it:
 * this step owns every charge that names such a session, decides one outcome from the
 * session's state and the RAW callback, and writes it in the settlement transaction under
 * the session's row lock. An approved `charge_refund` charge owes its refund whatever the
 * outcome; the provider's own refund row of it is this step's too.
 */

/** A verify that lands this close to `startsAt` (or later) is refused: the payer's old
 * subscription may charge before a handover could be confirmed. */
export const LATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The verify's success: WayForPay holds the authorisation and has issued a token. */
const VERIFIED_STATUS = 'WaitingAuthComplete';
const VERIFIED_REASON_CODE = '1100';
/** A `charge_refund` verify's success: the provider took the charge and issued a token. */
const CHARGED_STATUS = 'Approved';
const DECLINED_STATUSES: readonly string[] = ['Declined', 'Expired'];
/** What the provider reports for an order whose money went back. */
const RETURNED_STATUSES: readonly string[] = ['refunded', 'voided'];

// "0", "00", "0.00" — a decimal that is exactly zero, nothing else.
const ZERO_AMOUNT = /^0+(\.0+)?$/;
// A plain non-negative decimal, as WayForPay writes a major-unit amount.
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** A raw provider field as text (numbers stringified), or null when absent. */
const rawText = (payload: Charge['payload'], key: string): string | null => {
  const value = payload[key];
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : null;
};

/** Whether the RAW amount is exactly zero. Missing or unparseable is not zero: the
 * normalised charge would have defaulted it to 0, which proves nothing. */
export const rawAmountIsZero = (raw: unknown): boolean =>
  typeof raw === 'number'
    ? raw === 0
    : typeof raw === 'string' && ZERO_AMOUNT.test(raw);

/**
 * The RAW major-unit amount as exact minor units: "1", "1.0", "1.00" and 1 are 100.
 * Null when absent, unparseable, or finer than a minor unit — never rounded, so a charge
 * of 1.001 is not taken for 1.
 */
const amountText = (raw: unknown): string | null => {
  if (typeof raw === 'string') return raw;
  return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : null;
};

export const rawAmountMinor = (raw: unknown): number | null => {
  const match = DECIMAL.exec(amountText(raw) ?? '');
  if (match === null) return null;
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > 2) return null;
  return Number(match[1]) * 100 + Number(fraction.padEnd(2, '0'));
};

/** What a session's card check must look like: its method, and for `charge_refund` the
 * amount charged (minor units, USD). */
export type ExpectedVerify =
  | { readonly method: 'lookup' }
  | { readonly method: 'charge_refund'; readonly amountMinor: number };

/** What the raw callback says, and whether it proves a verified card. */
export interface CardCheckEvidence {
  readonly verified: boolean;
  readonly declined: boolean;
  /** A `charge_refund` charge the provider approved: money was taken and is owed back,
   * whether or not the rest of the evidence holds. */
  readonly moneyTaken: boolean;
  readonly status: string | null;
  readonly reasonCode: string | null;
  readonly token: string | null;
}

/** Whether the raw amount and currency are what this method's verify carries. */
const verifyTerms = (
  payload: Charge['payload'],
  expected: ExpectedVerify,
): boolean =>
  expected.method === 'lookup'
    ? rawAmountIsZero(payload['amount']) && payload['currency'] === 'UAH'
    : rawAmountMinor(payload['amount']) === expected.amountMinor &&
      payload['currency'] === 'USD';

/** The status a method's verify succeeds with, and the token it carries, if any. */
const successStatus = (expected: ExpectedVerify): string =>
  expected.method === 'charge_refund' ? CHARGED_STATUS : VERIFIED_STATUS;

const tokenOf = (payload: Charge['payload']): string | null => {
  const raw = payload['recToken'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/**
 * Read the evidence from the raw payload only — never from the normalised amount and
 * currency, whose defaults (`mapping.ts`) would turn a missing field into "0 UAH". A
 * verified card is a signed WayForPay callback reporting the method's status
 * (`WaitingAuthComplete` for `lookup`, `Approved` for `charge_refund`) with code 1100, the
 * method's exact amount and currency (0 UAH; the configured USD charge), and a token.
 */
export const cardCheckEvidence = (
  event: Charge,
  expected: ExpectedVerify = { method: 'lookup' },
): CardCheckEvidence => {
  const { payload } = event;
  const status = rawText(payload, 'transactionStatus');
  const reasonCode = rawText(payload, 'reasonCode');
  const token = tokenOf(payload);
  return {
    verified:
      event.source === 'wayforpay_callback' &&
      status === successStatus(expected) &&
      reasonCode === VERIFIED_REASON_CODE &&
      verifyTerms(payload, expected) &&
      token !== null,
    declined: status !== null && DECLINED_STATUSES.includes(status),
    moneyTaken:
      expected.method === 'charge_refund' && status === CHARGED_STATUS,
    status,
    reasonCode,
    token,
  };
};

/** The provider's own refund record for this order: a REFUND row, or the order reported
 * Refunded / Voided. The card-check step owns every such row of a `charge_refund` session. */
export const isProviderRefund = (event: Charge): boolean =>
  event.status === 'refunded' || providerReturned(event);

/** Whether the row says the money went back (a REFUND row may also report a refusal). */
export const providerReturned = (event: Charge): boolean => {
  const status = rawText(event.payload, 'transactionStatus');
  return status !== null && RETURNED_STATUSES.includes(status.toLowerCase());
};

/** The outcome before the apply. `verify` may still turn into `on_live` under the payment
 * lock (`createOrExtend` refuses to stack a card check onto a live subscription). */
export type CardCheckOutcome =
  'verify' | 'late' | 'closed' | 'declined' | 'terminal' | 'anomalous';

export interface CardCheckFacts {
  readonly status: CheckoutSessionStatus;
  readonly evidence: Pick<CardCheckEvidence, 'verified' | 'declined'>;
  readonly nowMillis: number;
  readonly startsAt: Date | null;
  readonly payableUntil: Date | null;
}

const isOpen = (status: CheckoutSessionStatus): boolean =>
  status === CheckoutSessionStatus.Created ||
  status === CheckoutSessionStatus.Pending;

/** Too late to activate: at or past `startsAt − 24 h`, or at or past `payableUntil`. A
 * session without `startsAt` (the create forbids it) is never activated. */
const isLate = (f: CardCheckFacts): boolean =>
  f.startsAt === null ||
  f.nowMillis >= f.startsAt.getTime() - LATE_WINDOW_MS ||
  (f.payableUntil !== null && f.nowMillis >= f.payableUntil.getTime());

/**
 * The outcome table (§1.3). A Completed session already activated: a later callback is a
 * terminal update, logged only. Any other session that is not open (Closed; Expired, which
 * nothing writes today) never activates: logged only. On an open session a decline is
 * reported and leaves it open; anything that is not verified evidence is an anomaly; a
 * verified card activates unless it is late.
 */
export const classifyCardCheck = (f: CardCheckFacts): CardCheckOutcome => {
  if (f.status === CheckoutSessionStatus.Completed) return 'terminal';
  if (!isOpen(f.status)) return 'closed';
  if (f.evidence.declined) return 'declined';
  if (!f.evidence.verified) return 'anomalous';
  return isLate(f) ? 'late' : 'verify';
};

const eventId = (event: Charge, suffix: string): string =>
  `evt_${event.idemKey}:${suffix}`;

/** The envelope every card-check event shares: the charge's key, the session's contact. */
const envelopeOf = (event: Charge, session: CheckoutSession) => ({
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: session.externalUserId,
});

export const cardCheckFailed = (
  event: Charge,
  session: CheckoutSession,
  reason: CardCheckFailedEvent['payload']['reason'],
): CardCheckFailedEvent => ({
  id: eventId(event, 'card_check_failed'),
  name: 'card_check_failed',
  ...envelopeOf(event, session),
  aggregateId: session.id,
  payload: {
    reason,
    checkoutSessionId: session.id,
    metadata: session.metadata,
    cardCheckMethod: cardCheckMethodOf(session),
  },
});

export const cardCheckAnomaly = (
  event: Charge,
  session: CheckoutSession,
  evidence: CardCheckEvidence,
): CardCheckAnomalyEvent => ({
  id: eventId(event, 'card_check_anomaly'),
  name: 'card_check_anomaly',
  ...envelopeOf(event, session),
  aggregateId: session.id,
  payload: {
    status: evidence.status,
    reasonCode: evidence.reasonCode,
    tokenPresent: evidence.token !== null,
    checkoutSessionId: session.id,
    metadata: session.metadata,
  },
});

/** `payment_created` for a card check: the plan's amount and currency (no money moved;
 * that is what `firstCharge` says), keyed like every other `payment_created`. */
export const cardCheckPaymentCreated = (
  event: Charge,
  session: CheckoutSession,
  paymentId: string,
): PaymentCreatedEvent => ({
  id: eventId(event, 'subscription'),
  name: 'payment_created',
  ...envelopeOf(event, session),
  aggregateId: paymentId,
  payload: {
    amount: session.amount,
    currency: session.currency,
    method: PaymentMethod.Card,
    period: session.period,
    renewal: null,
    metadata: session.metadata,
    firstCharge: 'card_check',
  },
});

/** `subscription_card_checked`: the success facts of a verify that bought nothing. */
export const subscriptionCardChecked = (
  event: Charge,
  session: CheckoutSession,
  applied: ApplyPaymentResult,
): SubscriptionCardCheckedEvent => ({
  id: eventId(event, 'card_checked'),
  name: 'subscription_card_checked',
  ...envelopeOf(event, session),
  aggregateId: applied.subscriptionId,
  payload: {
    amount: 0,
    currency: session.currency,
    method: PaymentMethod.Card,
    period: session.period,
    source: event.source,
    chargeKind: 'checkout',
    nextPaymentDate: applied.nextPaymentDate.toISOString(),
    nextAmount: session.amount,
    periodStart: null,
    periodEnd: null,
    recurring: true,
    metadata: applied.metadata,
    checkoutSessionId: session.id,
    cardCheckMethod: cardCheckMethodOf(session),
  },
});

/** The card-check session a charge names, locked; None for any other charge. Read
 * unlocked first so a charge for an ordinary session takes no new lock (the mode never
 * changes after create). */
const ownedSession = (
  sql: SqlClient.SqlClient,
  ref: string,
): Effect.Effect<Option.Option<CheckoutSession>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const parsed = parseCheckoutRef(ref);
    if (parsed === null) return Option.none();
    const found = yield* makeCheckoutRepo(sql).findById(parsed.sessionId);
    if (Option.isNone(found) || found.value.firstCharge !== 'card_check') {
      return Option.none();
    }
    return yield* lockSessionById(sql)(parsed.sessionId);
  });

/** Log a charge that changes nothing (a closed or already-activated session). */
const logIgnored = (
  outcome: CardCheckOutcome,
  event: Charge,
  session: CheckoutSession,
) =>
  Effect.logInfo(`CARD_CHECK_IGNORED ${outcome}`).pipe(
    Effect.annotateLogs({
      idemKey: event.idemKey,
      sessionId: session.id,
      sessionStatus: session.status,
    }),
  );

interface Verify {
  readonly sql: SqlClient.SqlClient;
  readonly event: Charge;
  readonly session: CheckoutSession;
  readonly token: string;
  readonly nowMillis: number;
  readonly settle: CardCheckSettle;
}

/**
 * Activate: create the payment at the plan's terms with the verify's token, its first
 * charge at `startsAt` and no paid window, then complete the session. A live subscription
 * met under the payment lock closes the session `on_live` instead, writing no payment.
 */
const activate = (v: Verify) =>
  Effect.gen(function* () {
    const { sql, event, session, settle } = v;
    const applied = yield* createOrExtend(makePaymentRepo(sql))({
      externalUserId: session.externalUserId,
      amount: session.amount,
      currency: session.currency,
      method: PaymentMethod.Card,
      period: session.period,
      recurring: true,
      recurringTokenRef: v.token,
      // When billing learnt of the verify: the callback's own date can be absent, and a
      // missing one would be read as 1970.
      paidAt: new Date(v.nowMillis),
      metadata: session.metadata,
      startsAt: session.startsAt,
      source: event.source,
      firstCharge: 'card_check',
    });
    if (applied.cardCheckOnLive === true) {
      yield* closeOpenCardCheck(sql)(session.id, 'on_live');
      return yield* settle.publish(cardCheckFailed(event, session, 'on_live'));
    }
    yield* makeCheckoutRepo(sql).completeIfOpen(session.id);
    yield* settle.publish(
      cardCheckPaymentCreated(event, session, applied.subscriptionId),
    );
    yield* settle.publish(subscriptionCardChecked(event, session, applied));
  });

/** Write the outcome the table picked (everything but the activation itself). */
const settleOutcome = (
  outcome: Exclude<CardCheckOutcome, 'verify'>,
  ctx: Omit<Verify, 'token' | 'nowMillis'> & {
    readonly evidence: CardCheckEvidence;
  },
) => {
  const { sql, event, session, settle } = ctx;
  switch (outcome) {
    case 'late':
      return closeOpenCardCheck(sql)(session.id, 'late').pipe(
        Effect.andThen(settle.publish(cardCheckFailed(event, session, 'late'))),
      );
    case 'declined':
      return settle.publish(cardCheckFailed(event, session, 'declined'));
    case 'anomalous':
      return Effect.logWarning('CARD_CHECK_ANOMALY').pipe(
        Effect.annotateLogs({ idemKey: event.idemKey, sessionId: session.id }),
        Effect.andThen(
          settle.publish(cardCheckAnomaly(event, session, ctx.evidence)),
        ),
      );
    case 'closed':
    case 'terminal':
      return logIgnored(outcome, event, session);
  }
};

/** The refund an approved verify charge owes: what the provider says it took, or the
 * configured charge when the raw amount is unreadable; USD unless the raw says otherwise. */
export const refundTaskOf = (
  event: Charge,
  session: CheckoutSession,
  configuredMinor: number,
): CardCheckRefundTask => {
  const taken = rawAmountMinor(event.payload['amount']);
  const code = rawText(event.payload, 'currency');
  return {
    checkoutSessionId: session.id,
    orderReference: event.externalRef,
    amount: taken !== null && taken > 0 ? taken : configuredMinor,
    currency:
      (code === null ? undefined : currencyFromCode(code)) ?? Currency.USD,
  };
};

/**
 * Owe the refund of an approved verify charge, in the settlement transaction: the session
 * flips to `pending` and the task is enqueued, once. A duplicate copy (callback + poller)
 * finds the state already set; the queue key backs that up.
 */
const oweRefund = (sql: SqlClient.SqlClient, task: CardCheckRefundTask) =>
  Effect.gen(function* () {
    if (!(yield* markVerifyRefundOwed(sql)(task.checkoutSessionId))) return;
    yield* enqueue(sql)({
      messageType: CARD_CHECK_REFUND,
      idemKey: refundTaskKey(task.orderReference),
      payload: task,
    });
  });

/** The provider's refund row of a verify charge: settle the refund if the row says the
 * money went back and it is not settled yet; otherwise only log. Never a
 * `payment_refunded`, a quarantine or an anomaly: the verify charge was never a payment. */
const observeRefund = (
  sql: SqlClient.SqlClient,
  event: Charge,
  session: CheckoutSession,
  nowMillis: number,
) =>
  Effect.gen(function* () {
    const settled =
      providerReturned(event) &&
      (yield* settleVerifyRefund(sql)(session.id, new Date(nowMillis)));
    // A warning when it settles: it may correct a refund already reported as failed.
    yield* (
      settled
        ? Effect.logWarning('CARD_CHECK_REFUNDED by provider row')
        : Effect.logInfo('CARD_CHECK_REFUND_SEEN')
    ).pipe(
      Effect.annotateLogs({ idemKey: event.idemKey, sessionId: session.id }),
    );
  });

/** What the dispatch step needs beyond `sql`: the `charge_refund` amount it recognises. */
export interface CardCheckStepOptions {
  readonly chargeRefundAmountMinor: number;
}

const expectedVerify = (
  session: CheckoutSession,
  options: CardCheckStepOptions,
): ExpectedVerify =>
  cardCheckMethodOf(session) === 'charge_refund'
    ? { method: 'charge_refund', amountMinor: options.chargeRefundAmountMinor }
    : { method: 'lookup' };

/** Settle one charge of an owned session (everything but the provider's refund row). */
const settleVerify = (
  ctx: Omit<Verify, 'token'> & { readonly options: CardCheckStepOptions },
) =>
  Effect.gen(function* () {
    const { sql, event, session, nowMillis } = ctx;
    const evidence = cardCheckEvidence(
      event,
      expectedVerify(session, ctx.options),
    );
    if (evidence.moneyTaken) {
      yield* oweRefund(
        sql,
        refundTaskOf(event, session, ctx.options.chargeRefundAmountMinor),
      );
    }
    const outcome = classifyCardCheck({
      status: session.status,
      evidence,
      nowMillis,
      startsAt: session.startsAt,
      payableUntil: session.payableUntil,
    });
    if (outcome === 'verify' && evidence.token !== null) {
      yield* activate({ ...ctx, token: evidence.token });
    } else if (outcome !== 'verify') {
      yield* settleOutcome(outcome, { ...ctx, evidence });
    }
  });

/** The dispatch step for the pipeline, built on `sql` at the runtime root. */
export const makeCardCheckStep =
  (sql: SqlClient.SqlClient, options: CardCheckStepOptions): CardCheckStep =>
  (event, settle) =>
    Effect.gen(function* () {
      const owned = yield* ownedSession(sql, event.externalRef);
      if (Option.isNone(owned)) return false;
      const session = owned.value;
      const nowMillis = yield* Clock.currentTimeMillis;
      if (
        cardCheckMethodOf(session) === 'charge_refund' &&
        isProviderRefund(event)
      ) {
        yield* observeRefund(sql, event, session, nowMillis);
      } else {
        yield* settleVerify({
          sql,
          event,
          session,
          settle,
          nowMillis,
          options,
        });
      }
      yield* settle.markMatched;
      return true;
    });
