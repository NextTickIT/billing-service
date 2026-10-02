import type { SqlError } from '@effect/sql';
import {
  type CheckoutChoice,
  type CheckoutCycleOption,
  type CheckoutOptionPublic,
  type CheckoutOrigin,
  type CheckoutSession,
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type CheckoutTerms,
  DEFAULT_CHOICE,
  type NewCheckoutSession,
  optionTerms,
  parseCheckoutRef,
  type Payment,
  PaymentMethod,
  PaymentStatus,
  sameTerms,
  scalePeriod,
  sessionIdOfRef,
  type StoredCheckoutOption,
} from '@billing-service/shared';
import { Data, Effect, Option } from 'effect';

import {
  type AppliedCharge,
  type Charge,
  type ChargeApplier,
  type ChargeMatcher,
  type Match,
  type RefusedCharge,
  settlementAnomaly,
} from '@/modules/charge/contracts.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import {
  advanceLocked,
  createOrExtend,
  type FindActiveRecurring,
} from '@/modules/payment/domain.js';

/** The public checkout page URL for a session id (served by the frontend SPA). `baseUrl`
 * is the environment's `checkoutBaseUrl` config (no trailing slash). */
export const checkoutPath = (baseUrl: string, sessionId: string): string =>
  `${baseUrl}/checkout/${sessionId}`;

/** How a terms session is minted: its id, expiry, idempotency key and label. */
export interface TermsSessionMint {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly idempotencyKey: string | null;
  readonly origin: CheckoutOrigin | null;
}

/**
 * A server-minted RECURRING checkout at a subscription's own current terms and method
 * (amount, currency, period), with no promo and no renewal override. Paying it runs the
 * one prolongation path: it stacks onto the contact's live sub, or after that sub died
 * starts a fresh one. `origin` labels who minted it; a labelled session also records the
 * sub it renews (`renewalOf`), while an unlabelled re-mint (`origin` null) records none.
 */
export const subscriptionTermsSession = (
  sub: Payment,
  { sessionId, expiresAt, idempotencyKey, origin }: TermsSessionMint,
): NewCheckoutSession => ({
  id: sessionId,
  externalUserId: sub.externalUserId,
  amount: sub.amount,
  currency: sub.currency,
  period: sub.period,
  method: sub.method,
  // Server-minted: no form was filled. The email sink resolves the address at delivery
  // time from the payment or an earlier session, so '' here loses nothing.
  email: '',
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  options: null,
  origin,
  // The sub this session renews: names it in a decline after the sub has died.
  renewalOf: origin === null ? null : sub.id,
  // A renewal prompt re-charges terms the buyer already declared; it adds no declaration
  // of its own, so paying it leaves the payment's stored metadata standing.
  metadata: null,
  idempotencyKey,
  expiresAt,
});

/**
 * Build OUR internal checkout session for a token-less (crypto) renewal prompt (docs/28):
 * the payment's own terms, with the last-used method preselected. Paying it extends THIS
 * recurring payment; a card pay captures a token and graduates it back to autocharge.
 * One session per renewal cycle: re-prompts on the retry ladder reuse the SAME link (the
 * unique idempotencyKey collapses re-inserts), so a user can never hold several
 * independently-payable links for one cycle and double-pay.
 */
export const manualRenewalSession = (
  sub: Payment,
  sessionId: string,
  expiresAt: Date,
  idempotencyKey: string,
): NewCheckoutSession =>
  subscriptionTermsSession(sub, {
    sessionId,
    expiresAt,
    idempotencyKey,
    origin: 'manual_renewal',
  });

/**
 * The stored options for a manual renewal that offers these cycle counts. Null when it
 * offers only the one cycle, so a session minted with the default config is exactly the
 * single-option session it always was.
 */
export const cycleOptions = (
  cycles: readonly number[],
): readonly CheckoutCycleOption[] | null =>
  cycles.length > 1 ? cycles.map((n) => ({ cycles: n })) : null;

/** The cycle counts a session's page offers: `[1]` when it sells no cycles. */
export const offeredCycles = (session: CheckoutSession): readonly number[] => {
  const cycles = (session.options ?? []).filter(isCycleOption);
  return cycles.length === 0 ? [1] : cycles.map((o) => o.cycles);
};

/** The `/prolong` session: the sub's terms, its method locked (`origin='prolong'`). */
export const prolongSession = (
  sub: Payment,
  sessionId: string,
  expiresAt: Date,
  idempotencyKey: string | null,
): NewCheckoutSession =>
  subscriptionTermsSession(sub, {
    sessionId,
    expiresAt,
    idempotencyKey,
    origin: 'prolong',
  });

const isCycleOption = (
  option: StoredCheckoutOption,
): option is CheckoutCycleOption => 'cycles' in option;

/** What a stored session or a session about to be minted offers. */
type Offer = CheckoutTerms & Pick<CheckoutSession, 'options'>;

const flatTerms = (session: Offer): CheckoutTerms => ({
  amount: session.amount,
  period: session.period,
  promo: session.promo,
  renewal: session.renewal,
});

/**
 * What one choice on a session charges and buys. `terms` is what settlement stores — one
 * cycle's terms for a multi-cycle choice, so the subscription keeps renewing at its base
 * price; `total` is what the provider order charges; `cycles` is set only on a session
 * that sells cycles.
 */
export interface ChosenTerms {
  readonly terms: CheckoutTerms;
  readonly cycles: number | null;
  readonly total: number;
}

/** The terms a choice stands for on this session, or None when it offers no such choice
 * (a reference naming an option the session does not have). */
export const chosenTerms = (
  session: Offer,
  choice: CheckoutChoice,
): Option.Option<ChosenTerms> => {
  const flat = flatTerms(session);
  const options = session.options ?? [];
  if (choice.kind === 'option') {
    const option = options[choice.index];
    return option === undefined || isCycleOption(option)
      ? Option.none()
      : Option.some({
          terms: optionTerms(option),
          cycles: null,
          total: option.amount,
        });
  }
  if (choice.kind === 'cycles') {
    const offered = options.some(
      (o) => isCycleOption(o) && o.cycles === choice.cycles,
    );
    return offered
      ? Option.some({
          terms: flat,
          cycles: choice.cycles,
          total: flat.amount * choice.cycles,
        })
      : Option.none();
  }
  const cycles = options.some(isCycleOption) ? 1 : null;
  return Option.some({ terms: flat, cycles, total: flat.amount });
};

/** The choice the page's option `index` stands for, or None when there is no such
 * option. The flat terms are the default wherever they sit in the list. */
export const choiceAt = (
  session: Offer,
  index: number,
): Option.Option<CheckoutChoice> => {
  if (session.options === null) {
    return index === 0 ? Option.some(DEFAULT_CHOICE) : Option.none();
  }
  const option = session.options[index];
  if (option === undefined) {
    return Option.none();
  }
  if (isCycleOption(option)) {
    return Option.some(
      option.cycles === 1
        ? DEFAULT_CHOICE
        : { kind: 'cycles', cycles: option.cycles },
    );
  }
  return Option.some(
    sameTerms(optionTerms(option), flatTerms(session))
      ? DEFAULT_CHOICE
      : { kind: 'option', index },
  );
};

/** The index of the default (the flat terms) among the page's options. */
export const defaultOptionIndex = (session: Offer): number =>
  Math.max(
    0,
    (session.options ?? []).findIndex((_, i) =>
      Option.exists(choiceAt(session, i), (c) => c.kind === 'default'),
    ),
  );

/** The option a `/pay` picked: its index, the choice it names and what it charges. */
export interface PickedOption {
  readonly index: number;
  readonly choice: CheckoutChoice;
  readonly chosen: ChosenTerms;
}

/**
 * The option `/pay` picked on this session: the sent index, or the default when none was
 * sent or the session offers no choice. None when the session has no such option.
 */
export const pickOption = (
  session: Offer,
  option: number | undefined,
): Option.Option<PickedOption> => {
  const index =
    option === undefined || session.options === null
      ? defaultOptionIndex(session)
      : option;
  return Option.flatMap(choiceAt(session, index), (choice) =>
    Option.map(chosenTerms(session, choice), (chosen) => ({
      index,
      choice,
      chosen,
    })),
  );
};

/** Whether two picks charge the same total for the same terms and cycles. */
export const samePick = (a: PickedOption, b: PickedOption): boolean =>
  a.chosen.total === b.chosen.total &&
  a.chosen.cycles === b.chosen.cycles &&
  sameTerms(a.chosen.terms, b.chosen.terms);

/** Every option as the page shows it, in order; the flat terms alone when the session
 * offers no choice. A cycle option shows its total and the time it buys. */
export const publicOptions = (
  session: CheckoutSession,
): readonly CheckoutOptionPublic[] => {
  const flat = flatTerms(session);
  if (session.options === null) {
    return [{ ...flat, cycles: null }];
  }
  return session.options.map((option) =>
    isCycleOption(option)
      ? {
          ...flat,
          amount: flat.amount * option.cycles,
          period: scalePeriod(flat.period, option.cycles),
          cycles: option.cycles,
        }
      : { ...optionTerms(option), cycles: null },
  );
};

/**
 * A caller-supplied post-payment redirect must point at an allowed host (docs/30). An
 * empty allowlist accepts any host (dev/default); otherwise the URL's hostname must be
 * listed — this stops an open redirect off our own checkout domain. The URL already
 * passed the http(s) scheme filter, so an unparseable value here is malformed → rejected.
 */
export const redirectHostAllowed = (
  allowedHosts: readonly string[],
  url: string,
): boolean => {
  if (allowedHosts.length === 0) {
    return true;
  }
  try {
    return allowedHosts.includes(new URL(url).hostname);
  } catch (err) {
    if (err instanceof TypeError) {
      return false;
    }
    throw err;
  }
};

/** How a method change lands. `flip` mutates the payment server-side (no payment);
 * `checkout` issues a pay/verify session for `amount` in the target method. `arrears` is
 * true only when that session collects what the subscription owes: the route mints it
 * with `origin='card_change_arrears'`, which alone lets its payment credit a period. */
export type MethodChangePlan =
  | { readonly action: 'flip' }
  | {
      readonly action: 'checkout';
      readonly amount: number;
      readonly arrears: boolean;
    };

/**
 * Decide how a method change takes effect (docs/32), previous-method agnostic:
 * an up-to-date subscription switching TO crypto flips server-side — crypto has no free
 * verify (WhitePay minimum), so we just drop the card token and record crypto, and the
 * next renewal becomes a manual crypto prompt. Every other case issues a checkout in the
 * target method: an owed subscription (past_due/renewal_failed) pays its arrears and
 * revives in place; an up-to-date one runs a 0-amount card verify when enabled, else a
 * minimal tokenizing charge (`cardChangeChargeMinor`). Mirrors the card-change amount rule.
 */
export const planMethodChange = (
  payment: Payment,
  targetMethod: number,
  cardVerifyEnabled: boolean,
  cardChangeChargeMinor: number,
): MethodChangePlan => {
  const owed =
    payment.status === PaymentStatus.PastDue ||
    payment.status === PaymentStatus.RenewalFailed;
  if (!owed && targetMethod === PaymentMethod.Crypto) {
    return { action: 'flip' };
  }
  const amount = owed
    ? payment.amount
    : cardVerifyEnabled
      ? 0
      : cardChangeChargeMinor;
  return { action: 'checkout', amount, arrears: owed };
};

/**
 * Whether a charge on an open checkout session may settle under the session's terms.
 * Both providers map an unknown currency to UAH, so a succeeded charge in another
 * currency is not what the session priced: never book it (quarantine, loudly). A
 * differing amount is routine (WhitePay reports the converted crypto value): settle on
 * the session's price and leave a trace.
 */
const settlesOnSession = (
  event: Charge,
  session: CheckoutSession,
  total: number,
) =>
  Effect.gen(function* () {
    if (event.status !== 'succeeded') {
      return true;
    }
    const sessionCurrency: number = session.currency;
    if (event.currency !== sessionCurrency) {
      yield* settlementAnomaly(
        'checkout: currency differs from session',
        event,
      );
      return false;
    }
    if (event.amount !== total) {
      yield* Effect.logWarning('settlement: amount differs from session').pipe(
        Effect.annotateLogs({
          idemKey: event.idemKey,
          externalRef: event.externalRef,
          amount: event.amount,
          sessionAmount: total,
        }),
      );
    }
    return true;
  });

/** The checkout match for an open session: the chosen option's price and terms, and the
 * session's labels. */
const checkoutMatch = (
  session: CheckoutSession,
  { terms, cycles }: ChosenTerms,
  prolongOf: string | null,
): Match => ({
  matched: true,
  kind: 'checkout',
  subscriptionId: null,
  externalUserId: session.externalUserId,
  period: terms.period,
  method: session.method ?? PaymentMethod.Card,
  recurring: session.recurring,
  // A one-time bonus period the option carried; applied once on the create path.
  promoBonus: terms.promo?.additionalFreePeriod ?? null,
  renewal: terms.renewal,
  origin: session.origin,
  renewalOf: session.renewalOf,
  prolongOf,
  amount: terms.amount,
  currency: session.currency,
  cycles,
  // The caller's declaration for THIS purchase; stamped on the payment when applied.
  metadata: session.metadata,
});

/** The session a provider reference names and the terms of the option it paid for; None
 * for a reference we did not mint or an option the session does not offer. */
const sessionOfRef = (repo: CheckoutRepo, ref: string) =>
  Effect.gen(function* () {
    const parsed = parseCheckoutRef(ref);
    if (parsed === null) {
      return Option.none();
    }
    const found = yield* repo.findById(parsed.sessionId);
    return Option.flatMap(found, (session) =>
      Option.map(chosenTerms(session, parsed.choice), (chosen) => ({
        session,
        chosen,
      })),
    );
  });

/**
 * Checkout matcher: an incoming event whose `externalRef` names a known checkout
 * session and one of its options (`parseCheckoutRef`) resolves to a `checkout` match.
 * A succeeded event is create-or-extend; a declined one is a first-payment failure (the
 * pipeline emits `initial_payment_failed`, FR-003) — both are OUR session, not an
 * unknown payment.
 * Intermediate/other statuses (pending, refunded) still fall through to quarantine,
 * as do events for an unknown ref. Poller/legacy events never match here (no session).
 *
 * The match carries the chosen option's price and renewal terms (what gets stored, never
 * the callback's), its `origin` and `renewalOf`, and, for a declined recurring session
 * whose contact holds a live sub, that sub as `prolongOf` (a failed prolongation).
 */
export const makeCheckoutMatcher =
  (
    repo: CheckoutRepo,
    findActiveRecurring: FindActiveRecurring,
  ): ChargeMatcher =>
  (event) =>
    Effect.gen(function* () {
      if (event.status !== 'succeeded' && event.status !== 'failed') {
        return { matched: false };
      }
      const found = yield* sessionOfRef(repo, event.externalRef);
      // A card-change session is handled by its own matcher/applier — never as a
      // first checkout (which would create-or-extend a second payment).
      if (
        Option.isNone(found) ||
        found.value.session.kind !== CheckoutSessionKind.Checkout
      ) {
        return { matched: false };
      }
      const { session, chosen } = found.value;
      // A session is completed on the FIRST successful charge. A second success (crypto
      // double-pay: two paid orders for one session) or a late decline arriving after
      // completion must NOT re-credit or emit a spurious failure — fall through to
      // quarantine so the operator sees it (a refund candidate), never book it (docs/26).
      if (session.status === CheckoutSessionStatus.Completed) {
        if (event.status === 'succeeded') {
          yield* settlementAnomaly('checkout: paid a completed session', event);
        }
        return { matched: false };
      }
      if (!(yield* settlesOnSession(event, session, chosen.total))) {
        return { matched: false };
      }
      const live =
        event.status === 'failed' && session.recurring
          ? yield* findActiveRecurring(session.externalUserId)
          : Option.none<Payment>();
      return checkoutMatch(
        session,
        chosen,
        Option.getOrNull(Option.map(live, (sub) => sub.id)),
      );
    });

/**
 * Whether a card-change session's payment credits its own period. New sessions carry
 * the intent from mint time (`card_change_arrears`); a session from before `origin`
 * existed (null) keeps the old rule, a priced session is arrears.
 */
const isArrears = (session: CheckoutSession): boolean =>
  session.origin === null
    ? session.amount > 0
    : session.origin === 'card_change_arrears';

/**
 * Card-change matcher (docs/23): a callback whose session is a `card_change`
 * resolves to that session's target payment. Runs BEFORE the checkout matcher.
 * `amountCharged` (money moved, so it is fixed and reported) is kept apart from
 * `arrears` (a period is credited). Both success and failure match here so the pipeline
 * can emit the outcome.
 */
export const makeCardChangeMatcher =
  (repo: CheckoutRepo): ChargeMatcher =>
  (event) =>
    Effect.gen(function* () {
      if (event.status !== 'succeeded' && event.status !== 'failed') {
        return { matched: false };
      }
      const found = yield* sessionOfRef(repo, event.externalRef);
      if (Option.isNone(found)) {
        return { matched: false };
      }
      const { session } = found.value;
      if (
        session.kind !== CheckoutSessionKind.CardChange ||
        session.paymentId === null
      ) {
        return { matched: false };
      }
      return {
        matched: true,
        kind: 'card_change',
        subscriptionId: session.paymentId,
        externalUserId: session.externalUserId,
        period: session.period,
        method: session.method ?? PaymentMethod.Card,
        amountCharged: event.amount > 0,
        arrears: isArrears(session),
        origin: session.origin,
        // Usually null — a card change re-tokenizes rather than declaring a purchase — so
        // the extend COALESCE leaves the payment's existing declaration standing.
        metadata: session.metadata,
      };
    });

/** The recToken the provider returns on a card checkout, if any. */
const recToken = (payload: Record<string, unknown>): string | null =>
  typeof payload['recToken'] === 'string' && payload['recToken'].length > 0
    ? payload['recToken']
    : null;

/** A payment that still owes for the current period (a card change collects it). */
const owesMoney = (status: PaymentStatus): boolean =>
  status === PaymentStatus.PastDue || status === PaymentStatus.RenewalFailed;

/** A different charge already settled this session: write nothing, quarantine it. */
const alreadyApplied = (subscriptionId: string | null): RefusedCharge => ({
  refused: 'already_applied',
  subscriptionId,
});

/** Aborts the checkout settlement savepoint so the session claim rolls back with it. */
class IntroOnLive extends Data.TaggedError('IntroOnLive')<{
  readonly subscriptionId: string;
}> {}

/**
 * Card-change applier (docs/23): claim the session, rewrite the stored token on the
 * target payment and, for an arrears change, credit the session's own period on the
 * SAME payment (never create-or-extend, so the one-active-payment invariant holds),
 * stacked on its locked anchor; the advance also resets the retry ladder and sets
 * `active`, reviving a past_due/renewal_failed payment in place.
 */
const applyCardChange =
  (payments: PaymentRepo, checkout: CheckoutRepo) =>
  (
    event: Parameters<ChargeApplier>[0],
    paymentId: string,
    match: Match,
  ): Effect.Effect<AppliedCharge, SqlError.SqlError> =>
    Effect.gen(function* () {
      // Exactly one charge settles a session; a replay of the same charge never gets
      // here (the pipeline's matchResult lock), so a loss is a different charge.
      if (
        !(yield* checkout.completeIfOpen(sessionIdOfRef(event.externalRef)))
      ) {
        return alreadyApplied(paymentId);
      }
      // Persist the rail the payment ACTUALLY came in on — keyed on the event SOURCE, not on
      // whether a token came back. This records what the buyer really paid even if they
      // switched method on the checkout page from what was requested.
      // → WhitePay (crypto): never a reusable token, so switch to manual crypto renewals —
      //   drop any stored token and set Crypto (the scheduler's token-less branch prompts).
      // → WayForPay (card): stay on card. Store the new token if the callback returned one,
      //   but NEVER clear the existing token — an Approved WayForPay charge CAN omit `recToken`
      //   (docs/14), and clearing it would silently strip a live card sub to manual. `setMethod`
      //   keeps the label in step (a crypto→card switch flips it; a card→card is a no-op).
      if (event.source === 'whitepay_callback') {
        yield* payments.clearToken(paymentId);
        yield* payments.setMethod(paymentId, PaymentMethod.Crypto);
      } else {
        const token = recToken(event.payload);
        if (token !== null) {
          yield* payments.updateToken(paymentId, token);
        }
        yield* payments.setMethod(paymentId, PaymentMethod.Card);
      }
      if (match.arrears === true) {
        // A session from before `origin` keeps the old guard: it advances only while the
        // payment still owes. A new arrears session always credits its period, unless the
        // payment was cancelled meanwhile.
        const legacy = match.origin === null || match.origin === undefined;
        const advanced = yield* advanceLocked(payments)(
          paymentId,
          match.period,
          event.occurredAt,
          (locked) =>
            legacy
              ? owesMoney(locked.status)
              : locked.status !== PaymentStatus.Cancelled,
        );
        if (Option.isSome(advanced)) {
          const credited = advanced.value;
          return {
            subscriptionId: paymentId,
            created: false,
            prolonged: false,
            nextPaymentDate: credited.nextPaymentDate,
            periodStart: credited.currentPeriodStart,
            periodEnd: credited.currentPeriodEnd,
            metadata: credited.metadata,
          };
        }
      }
      // No period credited, so no window: a charge that moved money reports the unchanged
      // schedule and the payment's declaration; a 0-amount verify reports neither.
      const current =
        match.amountCharged === true
          ? Option.getOrNull(yield* payments.findById(paymentId))
          : null;
      return {
        subscriptionId: paymentId,
        created: false,
        prolonged: false,
        nextPaymentDate: current?.nextPaymentDate ?? null,
        periodStart: null,
        periodEnd: null,
        metadata: current?.metadata ?? null,
      };
    });

/**
 * The checkout branch of the applier: claim the session, then create or extend. Runs as
 * a savepoint inside the settlement transaction: an intro-priced charge on a live sub
 * (Q8) rolls back its session claim too, leaving the session as it was.
 */
const applyCheckout =
  (payments: PaymentRepo, checkout: CheckoutRepo) =>
  (
    event: Charge,
    match: Match,
  ): Effect.Effect<AppliedCharge, SqlError.SqlError> =>
    Effect.gen(function* () {
      if (
        !(yield* checkout.completeIfOpen(sessionIdOfRef(event.externalRef)))
      ) {
        return alreadyApplied(null);
      }
      const applied = yield* createOrExtend(payments)({
        externalUserId: match.externalUserId,
        // The session's price, not the callback's: a provider maps an unknown currency
        // to UAH, and WhitePay reports a converted amount.
        amount: match.amount ?? event.amount,
        currency: match.currency ?? event.currency,
        method: match.method,
        period: match.period,
        // Absent on a recurring/card_change match — those act on an existing recurring
        // payment; only a checkout match can carry a one-time (false) intent.
        recurring: match.recurring ?? true,
        // One-time bonus period from the session; extends the paid-through anchor once.
        promoBonus: match.promoBonus ?? null,
        renewal: match.renewal ?? null,
        // A multi-cycle renewal stacks that many periods; `amount`/`period` above stay one
        // cycle's, so the subscription keeps its base terms.
        cycles: match.cycles ?? 1,
        // Absent when the caller declared none — `extend` then keeps what is stored.
        metadata: match.metadata,
        source: event.source,
        recurringTokenRef: recToken(event.payload),
        paidAt: event.occurredAt,
      });
      if (applied.introOnLive === true) {
        return yield* Effect.fail(
          new IntroOnLive({ subscriptionId: applied.subscriptionId }),
        );
      }
      const { subscriptionId, created, prolonged, nextPaymentDate } = applied;
      return {
        subscriptionId,
        created,
        prolonged,
        ...(applied.reactivated === undefined
          ? {}
          : { reactivated: applied.reactivated }),
        nextPaymentDate,
        periodStart: applied.periodStart,
        periodEnd: applied.periodEnd,
        metadata: applied.metadata,
      };
    }).pipe(
      payments.transaction,
      Effect.catchTag('IntroOnLive', (refusal) =>
        Effect.succeed<AppliedCharge>({
          refused: 'intro_on_live',
          subscriptionId: refusal.subscriptionId,
        }),
      ),
    );

/**
 * Checkout applier (FR-003): claim the session, then create or extend the user's
 * payment (storing the card token). A `recurring` match already has its payment — the
 * scheduler advances it (M6) — so the applier just reports it. A `card_change` match
 * re-tokenizes an existing payment. Opens no transaction of its own (only a savepoint,
 * `applyCheckout`): the pipeline's settlement transaction holds every write and lock.
 */
export const makeCheckoutApplier =
  (payments: PaymentRepo, checkout: CheckoutRepo): ChargeApplier =>
  (event, match: Match) => {
    if (match.kind === 'card_change' && match.subscriptionId !== null) {
      // applyCardChange records the rail from the event SOURCE (WayForPay → card,
      // WhitePay → crypto), not from the session's requested target.
      return applyCardChange(payments, checkout)(
        event,
        match.subscriptionId,
        match,
      );
    }
    if (match.kind === 'recurring' && match.subscriptionId !== null) {
      const subscriptionId = match.subscriptionId;
      // A recurring match already has its payment (the scheduler advanced it before the
      // incoming event re-entered the pipeline), so its own row IS the prolongation this
      // charge bought — and its stored metadata is the last intent the buyer declared,
      // which is what a renewal must report rather than nothing.
      return Effect.gen(function* () {
        const found = Option.getOrNull(
          yield* payments.findById(subscriptionId),
        );
        return {
          subscriptionId,
          created: false,
          prolonged: false,
          nextPaymentDate: found?.nextPaymentDate ?? null,
          periodStart: found?.currentPeriodStart ?? null,
          periodEnd: found?.currentPeriodEnd ?? null,
          metadata: found?.metadata ?? null,
        };
      });
    }
    return applyCheckout(payments, checkout)(event, match);
  };
