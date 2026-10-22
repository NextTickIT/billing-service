import { randomUUID } from 'node:crypto';

import { SqlClient, type SqlError } from '@effect/sql';
import {
  CardChangeRequest,
  checkoutRef,
  type CheckoutOrigin,
  type CheckoutSession,
  CheckoutSessionKind,
  CheckoutSessionPublic,
  CheckoutSessionStatus,
  CreateCheckoutSession,
  MethodChangeRequest,
  MethodChangeResult,
  type NewCheckoutSession,
  ONE_TIME_PERIOD,
  type Payment,
  PayInstruction,
  PAYMENT_METHOD_CHANGE,
  PaymentMethod,
  PaymentStatus,
  ProlongRequest,
  SelectMethod,
  SessionCreated,
} from '@billing-service/shared';
import { Clock, Effect, Either, Option, Redacted, Schema } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { assertBffSecret } from '@/infra/http/bff-secret.js';
import { extractBearer } from '@/infra/http/bearer.js';
import {
  AlreadySubscribed,
  ChangeUnavailable,
  Conflict,
  MethodLocked,
  NotFound,
  Unauthorized,
  UnprocessableEntity,
} from '@/infra/http/errors.js';
import {
  assertIdempotencyKey,
  idempotencyKeyOf,
} from '@/infra/http/idempotency-key.js';
import { makeRoute } from '@/infra/http/route.js';
import { enqueue } from '@/infra/queue/store.js';
import { PAYMENT_EVENT_RECEIVED } from '@/modules/charge/contracts.js';
import { authenticateToken } from '@/modules/auth/domain.js';
import {
  type CheckoutRepo,
  makeCheckoutRepo,
} from '@/modules/checkout/data-access.js';
import {
  checkoutPath,
  choiceAt,
  chosenTerms,
  defaultOptionIndex,
  type MethodChangePlan,
  planMethodChange,
  prolongSession,
  publicOptions,
  redirectHostAllowed,
  subscriptionTermsSession,
} from '@/modules/checkout/domain.js';
import type { MethodChangeNotify } from '@/modules/payment/contracts.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import {
  type FindActiveRecurring,
  isIntroPriced,
  isLive,
} from '@/modules/payment/domain.js';
import { isValidPeriod } from '@/modules/payment/period.js';
import {
  ackResponse,
  type CallbackPayload,
  normalizeCallback,
  verifyCallback,
} from '@/modules/wayforpay/callback.js';
import { buildPurchase, buildVerify } from '@/modules/wayforpay/purchase.js';
import {
  normalizeWebhook,
  verifyWebhook,
} from '@/modules/whitepay/callback.js';
import { WhitePay } from '@/modules/whitepay/client.js';
import {
  CryptoPaymentUnavailable,
  type WhitePayError,
} from '@/modules/whitepay/errors.js';

const route = makeRoute((app: FastifyInstance) => app.runtime);

/** The external system authenticates with a service token to open a session. */
const serviceActor = (request: FastifyRequest) => {
  const presented = extractBearer(request);
  return presented === null
    ? Effect.fail(new Unauthorized({ reason: 'missing bearer token' }))
    : authenticateToken(presented);
};

const readId = (request: FastifyRequest): string =>
  (request.params as { readonly id: string }).id;

/** Refuse a checkout whose post-payment redirect points off the allowed hosts (docs/30). */
const assertRedirectAllowed = (
  allowedHosts: readonly string[],
  url: string | undefined,
): Effect.Effect<void, UnprocessableEntity> =>
  url === undefined || redirectHostAllowed(allowedHosts, url)
    ? Effect.void
    : Effect.fail(
        new UnprocessableEntity({
          reason: `redirect host not allowed: ${url}`,
        }),
      );

/** Both post-payment redirects on a create request must point at an allowed host. */
const assertRedirects = (
  input: CreateCheckoutSession,
  request: FastifyRequest,
): Effect.Effect<void, UnprocessableEntity> =>
  Effect.gen(function* () {
    const hosts = request.server.appConfig.redirectAllowedHosts;
    yield* assertRedirectAllowed(hosts, input.successUrl);
    yield* assertRedirectAllowed(hosts, input.failureUrl);
  });

/** A promo's bonus must be a period in our format (an ISO-8601 duration). Reject a
 * malformed one at creation with a 422 rather than let it throw when the charge applies
 * it in the worker (where it would fail the attempt instead of the caller's request).
 * Every option's promo is held to the same rule. */
const assertPromo = (input: CreateCheckoutSession) => {
  const promo = [
    input.promo,
    ...(input.options ?? []).map((o) => o.promo),
  ].find((p) => p !== undefined && !isValidPeriod(p.additionalFreePeriod));
  if (promo !== undefined) {
    return Effect.fail(
      new UnprocessableEntity({
        reason: `unsupported promo period '${promo.additionalFreePeriod}'`,
      }),
    );
  }
  return Effect.void;
};

/** The SessionCreated response for a session id + expiry. */
const created = (
  id: string,
  expiresAt: Date,
  baseUrl: string,
): SessionCreated => ({
  sessionId: id,
  checkoutUrl: checkoutPath(baseUrl, id),
  expiresAt,
});

/**
 * Insert the session, or replay the existing one when its Idempotency-Key already maps to
 * a session (a retry, or a concurrent create that lost the ON CONFLICT race). The unique
 * index makes this atomic — concurrent creates with one key collapse to a single row and
 * every caller gets the same sessionId/checkoutUrl/expiresAt, so one intent never mints
 * two provider flows. A key-less create (null) always inserts.
 */
const insertOrReplay = (
  repo: CheckoutRepo,
  input: NewCheckoutSession,
  baseUrl: string,
) =>
  Effect.gen(function* () {
    const inserted = yield* repo.insert(input);
    const key = input.idempotencyKey;
    if (inserted || key === null) {
      return created(input.id, input.expiresAt, baseUrl);
    }
    const existing = yield* repo.findByIdempotencyKey(key);
    // The key alone is not identity: a reused key must never hand one contact another
    // contact's session, nor turn a /prolong into a plain checkout (or back).
    if (
      existing._tag === 'None' ||
      existing.value.externalUserId !== input.externalUserId ||
      existing.value.origin !== input.origin
    ) {
      return yield* Effect.fail(new Conflict({ field: 'idempotency key' }));
    }
    return created(existing.value.id, existing.value.expiresAt, baseUrl);
  });

const createSession = (input: CreateCheckoutSession, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    yield* assertRedirects(input, request);
    yield* assertPromo(input);
    yield* assertIdempotencyKey(request);
    const sql = yield* SqlClient.SqlClient;
    const nowMillis = yield* Clock.currentTimeMillis;
    const id = `chk_${randomUUID()}`;
    const expiresAt = new Date(
      nowMillis + request.server.appConfig.wayforpay.sessionTtlSeconds * 1000,
    );
    return yield* insertOrReplay(
      makeCheckoutRepo(sql),
      {
        id,
        externalUserId: input.externalUserId,
        amount: input.amount,
        currency: input.currency,
        // A recurring checkout always carries its cadence (enforced by the schema); a
        // one-time purchase never renews, so it may omit `period` — store the zero-length
        // sentinel to satisfy the NOT NULL column (it is never read back for a one-time).
        period: input.period ?? ONE_TIME_PERIOD,
        // Default preselected method (Card unless the caller passed one; the schema
        // defaults it to Card). The page can still switch it before Pay.
        method: input.method,
        kind: CheckoutSessionKind.Checkout,
        // Schema-defaulted to true; false opts this checkout into a one-time payment.
        recurring: input.recurring,
        paymentId: null,
        successUrl: input.successUrl ?? null,
        failureUrl: input.failureUrl ?? null,
        // A one-time bonus period applied once, when this session is paid (see CheckoutPromo).
        promo: input.promo ?? null,
        // Renewal terms when they differ from the first charge (see CheckoutRenewal).
        renewal: input.renewal ?? null,
        // What the payer may pick instead of the flat terms (the schema checked that the
        // flat terms are among them).
        options: input.options ?? null,
        // Caller-created: no internal origin, renews no particular subscription.
        origin: null,
        renewalOf: null,
        // Opt-in dedup key from the caller's header; null → always a fresh session.
        idempotencyKey: idempotencyKeyOf(request),
        // Where the receipt goes. '' when the caller sent none: no address, no email —
        // and the email sink then fails loudly rather than pretending it delivered.
        email: input.email ?? '',
        expiresAt,
      },
      request.server.appConfig.checkoutBaseUrl,
    );
  });

const getSession = (_input: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    const sql = yield* SqlClient.SqlClient;
    const id = readId(request);
    const found = yield* makeCheckoutRepo(sql).findById(id);
    if (found._tag === 'None') {
      return yield* Effect.fail(new NotFound({ resource: 'checkout session' }));
    }
    const {
      amount,
      currency,
      period,
      recurring,
      status,
      kind,
      method,
      successUrl,
      failureUrl,
      expiresAt,
      renewal,
      origin,
    } = found.value;
    // `origin` itself is never returned (X11); the page sees only what it acts on.
    const prolong = origin === 'prolong';
    return {
      options: publicOptions(found.value),
      defaultOption: defaultOptionIndex(found.value),
      amount,
      currency,
      period,
      recurring,
      status,
      kind,
      method,
      successUrl,
      failureUrl,
      expiresAt,
      renewal,
      methodLocked: prolong,
      prolong,
    };
  });

/** Card (WayForPay): a 0-amount card change verifies the card (buildVerify) when verify
 * is enabled; otherwise a signed Purchase form the browser POSTs to the provider.
 * `session` is the provider order (`orderFor`): its id is the order reference. */
const payCard = (
  session: CheckoutSession,
  request: FastifyRequest,
): Effect.Effect<PayInstruction> =>
  Effect.gen(function* () {
    const config = request.server.appConfig.wayforpay;
    if (
      session.kind === CheckoutSessionKind.CardChange &&
      session.amount === 0 &&
      config.cardVerifyEnabled
    ) {
      return buildVerify(config, session);
    }
    const orderDate = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    return buildPurchase(config, session, orderDate);
  });

/** Crypto (WhitePay): mint a FRESH order on-click and hand back its hosted redirect —
 * minting here (not at session creation) keeps WhitePay's ~2-min rate lock fresh (docs/26).
 * Guarded by `enabled` so a dark deploy refuses crypto (503) instead of calling with an
 * empty slug/token (docs/25). `external_order_id` = the order reference (`orderFor`), the
 * callback match key. */
const payCrypto = (
  session: CheckoutSession,
  request: FastifyRequest,
): Effect.Effect<
  PayInstruction,
  CryptoPaymentUnavailable | WhitePayError,
  WhitePay
> =>
  Effect.gen(function* () {
    if (!request.server.appConfig.whitepay.enabled) {
      return yield* Effect.fail(
        new CryptoPaymentUnavailable({ reason: 'whitepay disabled' }),
      );
    }
    const client = yield* WhitePay;
    const order = yield* client.createOrder({
      amount: session.amount,
      currency: session.currency,
      externalOrderId: session.id,
    });
    return { kind: 'redirect', url: order.acquiringUrl };
  });

/** What `/pay` reads and writes: the sessions, and the contact's live subscription. */
export interface PayRepos {
  readonly sessions: CheckoutRepo;
  readonly findActiveRecurring: FindActiveRecurring;
}

/** A session past its life is not claimable: 409 when terminal or past `expiresAt`. */
const assertClaimable = (
  session: CheckoutSession,
  nowMillis: number,
): Effect.Effect<void, Conflict> => {
  if (
    session.status === CheckoutSessionStatus.Completed ||
    session.status === CheckoutSessionStatus.Expired
  ) {
    return Effect.fail(
      new Conflict({ field: 'checkout session (completed or expired)' }),
    );
  }
  // Enforce the session TTL at claim time: a link past its `expiresAt` is not payable.
  // Without this the checkout URL (incl. the crypto manual-renewal link with its
  // advertised `windowExpiresAt`) would be a permanent bearer capability. State is still
  // reconciled from the provider webhook, so a payment begun before expiry still settles.
  if (session.expiresAt.getTime() <= nowMillis) {
    return Effect.fail(new Conflict({ field: 'checkout session (expired)' }));
  }
  return Effect.void;
};

/**
 * Resolve a session and atomically claim it for payment, or fail: 404 when unknown, 409
 * when terminal (completed/expired) or already claimed. The claim IS the idempotency
 * guard — the session id is the key, so a concurrent or repeat /pay (button spam, two
 * tabs, a scripted client) finds the row already pending, loses the created→pending
 * claim, and gets the 409. Exactly one provider order is ever minted per session
 * (docs/26). Returns the now-pending session, ready to hand to a provider.
 */
export const claimPayableSession = (
  { sessions: repo, findActiveRecurring }: PayRepos,
  id: string,
  method: number,
  nowMillis: number,
) =>
  Effect.gen(function* () {
    const found = yield* repo.findById(id);
    if (found._tag === 'None') {
      return yield* Effect.fail(new NotFound({ resource: 'checkout session' }));
    }
    yield* assertClaimable(found.value, nowMillis);
    // The same two rules the preflight ran, now on the row we actually claim: a sub can
    // have gone live, or the session been swapped, since `resolvePayableSessionId` read.
    const live = liveOf(yield* findActiveRecurring(found.value.externalUserId));
    yield* assertMethodAllowed(found.value, method);
    yield* assertNotIntroOnLiveSub(found.value, live);
    const claimed = yield* repo.claimForPayment(id, method);
    if (!claimed) {
      // The SQL backstop refuses a locked method too; tell that apart from a lost race.
      const current = yield* repo.findById(id);
      if (Option.isSome(current)) {
        yield* assertMethodAllowed(current.value, method);
      }
      return yield* Effect.fail(
        new Conflict({
          field: 'checkout session payment (already in progress)',
        }),
      );
    }
    return {
      ...found.value,
      method,
      status: CheckoutSessionStatus.Pending,
    } satisfies CheckoutSession;
  });

/**
 * Re-issue applies only to a session that was never handed to the provider.
 *
 * `Created` means the Pay button was never pressed, so `buildPurchase` never ran and no
 * `orderReference` ever reached WayForPay — there is no old order that could still be
 * paid alongside the new one. A `Pending` row is the opposite: the form WAS handed out,
 * its provider-side lifetime is whatever WayForPay defaulted to (every row predating
 * `orderTimeout` in this branch), and re-issuing beside it would leave two payable
 * orders for one intent. Both would match, both would book, and neither would
 * quarantine — the buyer pays twice and receives one period. So `Pending` keeps the old
 * refusal until it can be released deliberately.
 */
const isReissuable = (status: CheckoutSessionStatus): boolean =>
  status === CheckoutSessionStatus.Created ||
  status === CheckoutSessionStatus.Expired;

/**
 * A fresh purchase intent cloned from a lapsed one. Everything that belongs to the
 * BUYER's intent carries over; everything that identifies the old request does not.
 */
const clonedIntent = (
  session: CheckoutSession,
  expiresAt: Date,
): NewCheckoutSession => ({
  id: `chk_${randomUUID()}`,
  externalUserId: session.externalUserId,
  amount: session.amount,
  currency: session.currency,
  period: session.period,
  method: session.method ?? undefined,
  kind: CheckoutSessionKind.Checkout,
  recurring: session.recurring,
  paymentId: null,
  successUrl: session.successUrl,
  failureUrl: session.failureUrl,
  // The promo rode on the original intent and is still unspent — this checkout was
  // never paid — so it carries over rather than being silently dropped.
  promo: session.promo,
  // Carried like the promo: a re-issued link must still reach the buyer.
  email: session.email,
  // The same intent renews on the same terms, and keeps its attribution: a plain clone
  // of a prolong/manual-renewal link still names the subscription it renews.
  renewal: session.renewal,
  // The same choices too, so the option index the page sent still means the same option.
  options: session.options,
  origin: session.origin,
  renewalOf: session.renewalOf,
  // Never copied: the key is unique across live rows, and the clone is a new checkout,
  // not a replay of the caller's original request.
  idempotencyKey: null,
  expiresAt,
});

/** The contact's live (Active/PastDue) subscription, the only kind a prolongation or a
 * Q8 refusal acts on. The finder already excludes the rest; this keeps the rule local. */
const liveOf = (found: Option.Option<Payment>): Option.Option<Payment> =>
  Option.filter(found, isLive);

/** What a method-lock or Q8 check looks at — a stored session or an intent to mint. */
type PayableTerms = Pick<
  NewCheckoutSession,
  'amount' | 'period' | 'renewal' | 'origin' | 'externalUserId'
> & { readonly method?: number | null | undefined };

/**
 * A `/prolong` session is locked to the method it was minted with (the subscription's).
 * A different pick is a 400 that names the method to use. Every other origin, including
 * `manual_renewal` (a crypto sub may pay by card and graduate back to autocharge), is open.
 */
const assertMethodAllowed = (
  terms: PayableTerms,
  method: number,
): Effect.Effect<void, MethodLocked> =>
  terms.origin === 'prolong' &&
  terms.method !== undefined &&
  terms.method !== null &&
  terms.method !== method
    ? Effect.fail(new MethodLocked({ method: terms.method }))
    : Effect.void;

/**
 * Q8: an intro offer is for new customers. Paid by a contact with a live subscription it
 * would stack the intro period at the intro price, so it is refused while one exists —
 * lapsed or not, Active or PastDue.
 */
const assertNotIntroOnLiveSub = (
  terms: PayableTerms,
  live: Option.Option<Payment>,
): Effect.Effect<void, AlreadySubscribed> =>
  isIntroPriced(terms) && Option.isSome(live)
    ? Effect.fail(
        new AlreadySubscribed({ externalUserId: terms.externalUserId }),
      )
    : Effect.void;

/** The session `/pay` will actually charge: the stored one, or the replacement a re-issue
 * writes. Computed once, before any write, and the same value is what gets written. */
export type EffectivePayable =
  | { readonly _tag: 'Stored'; readonly session: CheckoutSession }
  | { readonly _tag: 'Reissue'; readonly intent: NewCheckoutSession };

const ORIGINS_REMINTED: readonly (CheckoutOrigin | null)[] = [
  'prolong',
  'manual_renewal',
];

/**
 * A replacement minted at the live subscription's CURRENT terms and method, never the
 * stale link's: no promo, no old amount. Where the buyer is sent afterwards still belongs
 * to the link they clicked, so the redirects and receipt address carry over.
 */
const remintedIntent = (
  session: CheckoutSession,
  sub: Payment,
  origin: CheckoutOrigin | null,
  expiresAt: Date,
): NewCheckoutSession => ({
  ...subscriptionTermsSession(sub, {
    sessionId: `chk_${randomUUID()}`,
    expiresAt,
    idempotencyKey: null,
    origin,
  }),
  successUrl: session.successUrl,
  failureUrl: session.failureUrl,
  email: session.email,
  // A manual renewal keeps its cycle choices: they are multiples of whatever the live
  // sub's terms are. A caller's priced options are the stale link's terms, so they go.
  options: origin === 'manual_renewal' ? session.options : null,
});

/** The replacement for a lapsed, re-issuable recurring checkout (rules on
 * `effectivePayable`). */
const replacementIntent = (
  session: CheckoutSession,
  live: Option.Option<Payment>,
  expiresAt: Date,
): Either.Either<NewCheckoutSession, AlreadySubscribed> => {
  if (Option.isNone(live)) {
    return Either.right(clonedIntent(session, expiresAt));
  }
  const sub = live.value;
  if (ORIGINS_REMINTED.includes(session.origin)) {
    return Either.right(
      remintedIntent(session, sub, session.origin, expiresAt),
    );
  }
  if (sub.status === PaymentStatus.Active) {
    return Either.left(
      new AlreadySubscribed({ externalUserId: session.externalUserId }),
    );
  }
  return Either.right(remintedIntent(session, sub, null, expiresAt));
};

/**
 * A `/prolong` or manual-renewal link that no longer describes the contact's live sub:
 * it names a different subscription (minted for A, while B is the live one now), or —
 * for a method-locked prolong — the sub has since changed method. Paid as-is it would
 * stack onto the live sub with another sub's terms, or flip the sub's method back, so
 * it is replaced like a lapsed link: re-minted at the live sub's current terms and method.
 */
const isStaleRenewal = (
  session: CheckoutSession,
  live: Option.Option<Payment>,
): boolean =>
  Option.isSome(live) &&
  ORIGINS_REMINTED.includes(session.origin) &&
  (session.renewalOf !== live.value.id ||
    (session.origin === 'prolong' && session.method !== live.value.method));

/**
 * Decide, without writing, which session `/pay` charges.
 *
 * A live link is paid as-is. A lapsed one re-issues — a new id, which is also the
 * `orderReference`, so a reference WayForPay has already seen is never re-POSTed, and the
 * old row stays matchable for a late callback. Guards, in order: a completed or pending
 * session is never re-issued; one-time and card-change sessions keep the old 409; a
 * `/prolong` or manual-renewal link for a contact with a live sub re-mints at that sub's
 * current terms and method; a plain link is refused while the contact is Active
 * (`AlreadySubscribed`), re-minted at the sub's current terms while PastDue (an old promo
 * link must not be replayable), and cloned on its own terms when there is no live sub —
 * including a `/prolong` or manual-renewal link whose sub has died (paid after death, AC 25).
 * A still-live `/prolong` or manual-renewal link that is stale (`isStaleRenewal`) takes the
 * same re-mint; a stale one already handed to the provider (Pending) is refused like a
 * lapsed Pending one, since a second payable order beside it could double-charge.
 */
export const effectivePayable = (
  session: CheckoutSession,
  live: Option.Option<Payment>,
  nowMillis: number,
  ttlSeconds: number,
): Either.Either<EffectivePayable, Conflict | AlreadySubscribed> => {
  const lapsed =
    session.status === CheckoutSessionStatus.Expired ||
    session.expiresAt.getTime() <= nowMillis;
  if (!lapsed && !isStaleRenewal(session, live)) {
    return Either.right({ _tag: 'Stored', session });
  }
  if (!isReissuable(session.status)) {
    return Either.left(
      new Conflict({ field: 'checkout session (not re-issuable)' }),
    );
  }
  // Only a recurring checkout is re-issuable: a one-time purchase has no subscription
  // to check against (an immortal link would be unlimited repeat charges), and a
  // card-change session is minted by its own endpoint.
  if (!session.recurring || session.kind !== CheckoutSessionKind.Checkout) {
    return Either.left(new Conflict({ field: 'checkout session (expired)' }));
  }
  return Either.map(
    replacementIntent(session, live, new Date(nowMillis + ttlSeconds * 1000)),
    (intent): EffectivePayable => ({ _tag: 'Reissue', intent }),
  );
};

/**
 * Resolve the session id we should actually charge, re-issuing when the one in the link
 * has lapsed (see `effectivePayable`).
 *
 * Every refusal is decided BEFORE any write: Q8 on the stored session, then the method
 * lock on the effective one (a lapsed prolong link may re-mint locked to a different
 * method than the stored row). Only then the writes — releasing a Pending link, or the
 * re-issue — so a refused pick never moves a session.
 */
export const resolvePayableSessionId = (
  { sessions: repo, findActiveRecurring }: PayRepos,
  id: string,
  method: number,
  nowMillis: number,
  ttlSeconds: number,
) =>
  Effect.gen(function* () {
    const found = yield* repo.findById(id);
    if (found._tag === 'None') {
      return yield* Effect.fail(new NotFound({ resource: 'checkout session' }));
    }
    const session = found.value;
    const live = liveOf(yield* findActiveRecurring(session.externalUserId));
    yield* assertNotIntroOnLiveSub(session, live);
    const effective = yield* effectivePayable(
      session,
      live,
      nowMillis,
      ttlSeconds,
    );
    yield* assertMethodAllowed(
      effective._tag === 'Stored' ? session : effective.intent,
      method,
    );
    if (effective._tag === 'Stored') {
      // A live link the buyer already pressed Pay on. `claimForPayment` only moves
      // Created → Pending, so without this the second press 409s and the buyer is shut
      // out for the rest of the TTL — 24 hours now that the TTL is a day. Release it and
      // let the normal claim re-hand the SAME orderReference: one order, not two, so
      // this cannot produce the double capture that re-issuing a Pending row would.
      // `paymentId` non-null means a card-change session, which its own endpoint owns.
      if (
        session.status === CheckoutSessionStatus.Pending &&
        session.paymentId === null
      ) {
        yield* repo.releasePending(id);
      }
      return id;
    }
    // Reuses the user's live session on these terms when one already exists, so a buyer
    // clicking the same stale link repeatedly (their URL still carries the OLD id) gets
    // one order, not one per click. That reuse is also the rate bound: a user can hold
    // at most one live session at a time, so at most one provider order per TTL window.
    return yield* repo.reissueLapsed(effective.intent);
  });

/**
 * The provider order for the option the payer picked: the claimed session under that
 * option's reference (`checkoutRef`), priced at the option's total. An option the session
 * does not offer is a 422. A session without options charges its flat terms whatever was
 * sent: a re-mint at the live sub's terms drops the stale link's options by design. A
 * non-default option is held to Q8 on its own terms — an intro option paid on a live sub
 * would only be refused at settlement, after the money moved.
 */
const orderFor = (
  session: CheckoutSession,
  option: number | undefined,
  findActiveRecurring: FindActiveRecurring,
) =>
  Effect.gen(function* () {
    const index =
      option === undefined || session.options === null
        ? defaultOptionIndex(session)
        : option;
    const choice = Option.getOrNull(choiceAt(session, index));
    const chosen =
      choice === null ? null : Option.getOrNull(chosenTerms(session, choice));
    if (choice === null || chosen === null) {
      return yield* Effect.fail(
        new UnprocessableEntity({ reason: 'unknown checkout option' }),
      );
    }
    if (choice.kind !== 'default') {
      const live = liveOf(yield* findActiveRecurring(session.externalUserId));
      yield* assertNotIntroOnLiveSub({ ...session, ...chosen.terms }, live);
    }
    return {
      ...session,
      id: checkoutRef(session.id, choice),
      amount: chosen.total,
    } satisfies CheckoutSession;
  });

const pay = (input: SelectMethod, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    const sql = yield* SqlClient.SqlClient;
    const repo = makeCheckoutRepo(sql);
    const nowMillis = yield* Clock.currentTimeMillis;
    const repos: PayRepos = {
      sessions: repo,
      findActiveRecurring:
        makePaymentRepo(sql).findActiveRecurringByExternalUser,
    };
    const id = yield* resolvePayableSessionId(
      repos,
      readId(request),
      input.method,
      nowMillis,
      request.server.appConfig.wayforpay.sessionTtlSeconds,
    );
    const claimed = yield* claimPayableSession(
      repos,
      id,
      input.method,
      nowMillis,
    );
    // A refused option releases the claim, like a failed crypto mint below.
    const order = yield* orderFor(
      claimed,
      input.option,
      repos.findActiveRecurring,
    ).pipe(Effect.tapError(() => repo.releasePending(id)));
    // A card handoff is a pure signed form (WayForPay dedups on our orderReference), so it
    // cannot fail. Only crypto calls out to WhitePay: if that mint fails (5xx / disabled),
    // release the claim so the buyer can retry or switch method instead of bricking here.
    if (input.method === PaymentMethod.Crypto) {
      return yield* payCrypto(order, request).pipe(
        Effect.tapError(() => repo.releasePending(id)),
      );
    }
    return yield* payCard(order, request);
  });

const providerOf = (request: FastifyRequest): string =>
  (request.params as { readonly provider: string }).provider;

const header = (request: FastifyRequest, key: string): string | undefined => {
  const value = request.headers[key];
  return typeof value === 'string' ? value : undefined;
};

/** WayForPay serviceUrl callback: 8-field HMAC-MD5, normalize, enqueue, signed accept. */
const wayForPayCallback = (body: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    const config = request.server.appConfig.wayforpay;
    const payload = (body ?? {}) as CallbackPayload;
    if (!verifyCallback(config, payload)) {
      return yield* Effect.fail(new Unauthorized({ reason: 'bad signature' }));
    }
    const event = normalizeCallback(payload);
    const sql = yield* SqlClient.SqlClient;
    yield* enqueue(sql)({
      messageType: PAYMENT_EVENT_RECEIVED,
      idemKey: event.idemKey,
      payload: event,
    });
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    return ackResponse(config, event.externalRef, time);
  });

/** WhitePay webhook: HMAC-SHA256 the RAW body against the webhook token (docs/26),
 * normalize into the same pipeline, ack HTTP 200. State is reconciled from the webhook,
 * never the browser redirect. */
const whitePayCallback = (body: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    const config = request.server.appConfig.whitepay;
    const verified = verifyWebhook(
      Redacted.value(config.webhookToken),
      request.rawBody ?? '',
      header(request, 'signature'),
    );
    if (!verified) {
      return yield* Effect.fail(new Unauthorized({ reason: 'bad signature' }));
    }
    const event = normalizeWebhook(body);
    const sql = yield* SqlClient.SqlClient;
    yield* enqueue(sql)({
      messageType: PAYMENT_EVENT_RECEIVED,
      idemKey: event.idemKey,
      payload: event,
    });
    return { status: 'accepted' };
  });

/** Provider callbacks share one path (`:provider`); dispatch to the provider's verify +
 * normalize. The two providers ack differently (a signed W4P accept vs a bare 200), so
 * the route output is `Unknown` — an unknown provider is a 404 (AC8: adding one is local). */
const callback = (body: unknown, request: FastifyRequest) => {
  const provider = providerOf(request);
  if (provider === 'whitepay') {
    return whitePayCallback(body, request);
  }
  if (provider === 'wayforpay') {
    return wayForPayCallback(body, request);
  }
  return Effect.fail(new NotFound({ resource: 'provider' }));
};

/** A `card_change` session for a method change: it re-tokenizes/switches the SAME recurring
 * payment, preselecting the DESTINATION method. Never one-time, carries no promo/redirects,
 * server-initiated so no idempotency key. `origin` records at mint time whether paying it
 * settles arrears (credits a period) — never inferred when it is paid. */
type ChangeOrigin = 'card_change' | 'card_change_arrears';

/** What a change session charges, and whether paying it settles arrears. */
interface ChangeCharge {
  readonly amount: number;
  readonly origin: ChangeOrigin;
}

const changeSession = (
  payment: Payment,
  targetMethod: number,
  { amount, origin }: ChangeCharge,
  id: string,
  expiresAt: Date,
): NewCheckoutSession => ({
  id,
  externalUserId: payment.externalUserId,
  amount,
  currency: payment.currency,
  period: payment.period,
  method: targetMethod,
  // Server-initiated re-tokenization, not a purchase form: the email sink resolves the
  // address at delivery time from the payment or an earlier session.
  email: '',
  // Reused for ALL method-change sessions (card- and crypto-target): the callback matcher
  // routes on this kind, while the applier keys on the event source, not this label.
  kind: CheckoutSessionKind.CardChange,
  recurring: true,
  paymentId: payment.id,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  options: null,
  origin,
  renewalOf: null,
  idempotencyKey: null,
  expiresAt,
});

/** The change-session origin for a checkout plan: arrears only on the owed branch; a
 * token charge or a 0-amount verify credits no time. */
const changeOriginOf = (plan: MethodChangePlan): ChangeOrigin =>
  plan.action === 'checkout' && plan.arrears
    ? 'card_change_arrears'
    : 'card_change';

/** The user's ONE recurring payment a card/method change acts on, or a 409: a cancelled
 * one (or none) is refused — start a fresh checkout. One-time payments hold no reusable
 * token and are never the target, so skip past them to the newest recurring. */
const resolveChangeable = (sql: SqlClient.SqlClient, externalUserId: string) =>
  Effect.gen(function* () {
    const found =
      yield* makePaymentRepo(sql).findByExternalUser(externalUserId);
    // Intentionally accepts a RenewalFailed (owed) recurring payment so a method-change
    // can revive it in place by billing the arrears — a deliberate divergence from
    // `findActiveRecurringByExternalUser`, which treats RenewalFailed as terminal.
    const payment = found.find((p) => p.recurring);
    if (payment === undefined || payment.status === PaymentStatus.Cancelled) {
      return yield* Effect.fail(
        new ChangeUnavailable({
          reason: 'no changeable payment; start a new checkout',
        }),
      );
    }
    return payment;
  });

/** Issue the pay/verify checkout for a method change and return its SessionCreated link. */
const openChangeSession = (
  sql: SqlClient.SqlClient,
  payment: Payment,
  targetMethod: number,
  charge: ChangeCharge,
  request: FastifyRequest,
) =>
  Effect.gen(function* () {
    const config = request.server.appConfig.wayforpay;
    const nowMillis = yield* Clock.currentTimeMillis;
    const id = `chk_${randomUUID()}`;
    const expiresAt = new Date(nowMillis + config.sessionTtlSeconds * 1000);
    yield* makeCheckoutRepo(sql).insert(
      changeSession(payment, targetMethod, charge, id, expiresAt),
    );
    return created(id, expiresAt, request.server.appConfig.checkoutBaseUrl);
  });

/**
 * SendPulse-initiated card change (docs/23): re-tokenize the user's recurring CARD. A
 * cancelled payment (or none) is refused (409 — start a fresh checkout); a current one runs
 * a 0-amount Card Verify when enabled, else a minimal tokenizing Purchase
 * (`cardChangeChargeMinor`); a past_due/renewal_failed one pays the owed amount (revives in
 * place). The card-only special case of `methodChange` below (kept for its callers).
 */
const cardChange = (input: CardChangeRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    const config = request.server.appConfig.wayforpay;
    const sql = yield* SqlClient.SqlClient;
    const payment = yield* resolveChangeable(sql, input.externalUserId);
    const plan = planMethodChange(
      payment,
      PaymentMethod.Card,
      config.cardVerifyEnabled,
      config.cardChangeChargeMinor,
    );
    // A card change is never the no-payment flip (that path is crypto-only), so `plan` is
    // always a checkout; the fallback keeps the type total.
    const amount = plan.action === 'checkout' ? plan.amount : payment.amount;
    return yield* openChangeSession(
      sql,
      payment,
      PaymentMethod.Card,
      { amount, origin: changeOriginOf(plan) },
      request,
    );
  });

/**
 * SendPulse-initiated payment-method change (docs/32), previous-method agnostic:
 * switch the user's one recurring payment to `input.method` (0=Card, 1=Crypto). Per
 * `planMethodChange`:
 * - `flip` (an up-to-date subscription → crypto): drop the card token + record crypto with
 *   NO payment — the existing scheduler then prompts a manual crypto renewal next cycle.
 *   Returns `{ kind: 'applied' }`.
 * - `checkout` (→ card always; → crypto while an amount is owed): issue a pay/verify session
 *   in the target method whose callback re-tokenizes/switches the SAME payment. Returns
 *   `{ kind: 'checkout', … }` with the link.
 */
const methodChange = (input: MethodChangeRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    const config = request.server.appConfig.wayforpay;
    const sql = yield* SqlClient.SqlClient;
    const payment = yield* resolveChangeable(sql, input.externalUserId);
    const plan = planMethodChange(
      payment,
      input.method,
      config.cardVerifyEnabled,
      config.cardChangeChargeMinor,
    );
    if (plan.action === 'flip') {
      // Already crypto with no stored token → nothing to change; return without mutating
      // or emitting a spurious `method_changed` for a genuine no-op.
      if (
        payment.method === PaymentMethod.Crypto &&
        payment.recurringTokenRef === null
      ) {
        return { kind: 'applied', method: PaymentMethod.Crypto } as const;
      }
      const payments = makePaymentRepo(sql);
      const at = yield* Clock.currentTimeMillis;
      // The no-payment flip mutates the payment but takes no money, so no charge event
      // fires — enqueue `method_changed` so a sink learns the method moved (the paid
      // paths already emit card_change_succeeded / recurring_payment_succeeded). All three
      // writes run in ONE transaction so the request can never leave the sub switched but
      // the notification unsent. The idemKey anchors on the paid-through end (which the flip
      // does not move), so a double-submit / client retry within the period dedupes to ONE
      // notification — wall-clock ms would let each retry re-emit.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* payments.clearToken(payment.id);
          yield* payments.setMethod(payment.id, PaymentMethod.Crypto);
          // Typed so a field rename can't silently drift from what methodChangeNotify
          // decodes in the worker (the queue payload is otherwise `unknown`).
          const payload: MethodChangeNotify = {
            paymentId: payment.id,
            externalUserId: payment.externalUserId,
            method: PaymentMethod.Crypto,
            at,
          };
          yield* enqueue(sql)({
            messageType: PAYMENT_METHOD_CHANGE,
            idemKey: `method-change:${payment.id}:${payment.currentPeriodEnd.toISOString()}`,
            payload,
          });
        }),
      );
      return { kind: 'applied', method: PaymentMethod.Crypto } as const;
    }
    const session = yield* openChangeSession(
      sql,
      payment,
      input.method,
      { amount: plan.amount, origin: changeOriginOf(plan) },
      request,
    );
    return { kind: 'checkout', ...session } as const;
  });

/**
 * The contact's live recurring subscription a `/prolong` extends, or a 404: only Active
 * and PastDue are prolongable (RenewalFailed and Cancelled start a fresh checkout).
 */
export const resolveProlongable = (
  findActiveRecurring: FindActiveRecurring,
  externalUserId: string,
): Effect.Effect<Payment, NotFound | SqlError.SqlError> =>
  findActiveRecurring(externalUserId).pipe(
    Effect.map(liveOf),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new NotFound({ resource: 'recurring payment' })),
        // The finder only returns recurring rows; kept so the rule reads in one place.
        onSome: (sub) =>
          sub.recurring
            ? Effect.succeed(sub)
            : Effect.fail(new NotFound({ resource: 'recurring payment' })),
      }),
    ),
  );

/**
 * SendPulse-initiated prolongation (AC 6–8, 22–23): mint a hosted pay link that extends
 * the contact's live subscription by one period at its CURRENT terms. A plain recurring
 * checkout with `origin='prolong'`: the applier finds the live row at payment time and
 * stacks onto it, the method is locked to the sub's, and there are no redirects. A crypto
 * sub while WhitePay is off is refused up front (503) — the link could only fail.
 */
const prolong = (input: ProlongRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    yield* assertIdempotencyKey(request);
    const sql = yield* SqlClient.SqlClient;
    const sub = yield* resolveProlongable(
      makePaymentRepo(sql).findActiveRecurringByExternalUser,
      input.externalUserId,
    );
    if (
      sub.method === PaymentMethod.Crypto &&
      !request.server.appConfig.whitepay.enabled
    ) {
      return yield* Effect.fail(
        new CryptoPaymentUnavailable({ reason: 'whitepay disabled' }),
      );
    }
    const nowMillis = yield* Clock.currentTimeMillis;
    const expiresAt = new Date(
      nowMillis + request.server.appConfig.wayforpay.sessionTtlSeconds * 1000,
    );
    return yield* insertOrReplay(
      makeCheckoutRepo(sql),
      prolongSession(
        sub,
        `chk_${randomUUID()}`,
        expiresAt,
        idempotencyKeyOf(request),
      ),
      request.server.appConfig.checkoutBaseUrl,
    );
  });

export default function checkout(fastify: FastifyInstance): void {
  route(fastify, {
    method: 'POST',
    path: '/api/checkout-sessions',
    input: CreateCheckoutSession,
    output: SessionCreated,
    status: 201,
    handler: createSession,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/payment/card-change',
    input: CardChangeRequest,
    output: SessionCreated,
    status: 201,
    handler: cardChange,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/payment/prolong',
    input: ProlongRequest,
    output: SessionCreated,
    status: 201,
    handler: prolong,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/payment/method-change',
    input: MethodChangeRequest,
    output: MethodChangeResult,
    handler: methodChange,
  });

  // Public JSON read (AC-9): BFF-proxied; no externalUserId in response.
  route(fastify, {
    method: 'GET',
    path: '/api/checkout-sessions/:id',
    input: Schema.Unknown,
    output: CheckoutSessionPublic,
    handler: getSession,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/checkout-sessions/:id/pay',
    input: SelectMethod,
    output: PayInstruction,
    handler: pay,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/providers/:provider/callback',
    input: Schema.Unknown,
    output: Schema.Unknown,
    handler: callback,
  });
}
