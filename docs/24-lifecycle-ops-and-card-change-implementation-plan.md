# Lifecycle Ops & Card Change — Deliberate Consensus Implementation Plan (RALPLAN-DR)

Implementation plan for the three scenarios in [23](23-lifecycle-ops-and-card-change-spec.md):
soft-cancel-to-period-end (+ reactivate + status filter), payment deferral, and
SendPulse-initiated card change. Deliberate mode (money movement + DB migrations + a new
external API). Follows the house style of [17](17-payment-flows-implementation-plan.md) /
[20](20-payment-app-implementation-plan.md) and the conventions of [16](16-conventions.md).
Revised after Architect + Critic consensus (see §13). Status: **pending approval**.

## 1. Requirements summary (cited to docs/23)

Three independently-shippable components (docs/23 §Scope):

1. **Cancellation lifecycle** — cancel becomes soft: set `cancelRequestedAt`, keep `active`,
   enqueue `payment_cancelled` now; at the due date emit terminal `renewal_failed(reason:'cancelled')`
   with no retries and set `cancelled`. Add `/reactivate` (grace-window only,
   `payment_reactivated`) and a multi-select status filter on the payments list.
2. **Payment deferral** — `/defer {days ≤ 30}` (operator, audited, repeatable): `currentPeriodEnd
   += days`, re-derive `nextPaymentDate` from the anchor, emit `payment_deferred(newPeriodEnd)`.
3. **Card change** — `POST /api/payment/card-change` (service token): `active` → 0-amount Card
   Verify (rewrite token only); `past_due` → priced Purchase for the owed amount (collect + rewrite
   + advance + reset ladder). Report `card_change_succeeded` / `card_change_failed` to the sink.

Four new event names; four new queue message types; two migrations; no core edits for the new
events (AC8).

## 2. Principles (invariants every phase must hold)

- **P1 — Drift-free dates.** `nextPaymentDate` is *always* re-derived from `currentPeriodEnd`
  via `payment/period.ts`; deferral mutates the anchor and re-derives, never hand-sets the date
  (CLAUDE.md §6). **A token-only rewrite must not touch any date field** (see Decision 4).
- **P2 — State before events, durably.** Payment state is persisted before any event is emitted
  (CLAUDE.md §5); every emit crosses the **worker-owned outbox via a durable queue message**, so
  a crash cannot drop a terminal event (Architect finding 3).
- **P3 — Idempotency intact.** Deterministic `orderReference` / idemKeys / event ids for verify,
  the owed charge, the lapse, and every new queue message (FR-006, docs/09); redelivered callbacks
  and reaped messages never double-charge or double-emit (AC2).
- **P4 — Provider code stays in `wayforpay`.** `verify()` and Card Verify signing live in the
  provider module; `checkout`/`payment`/`billing` stay processor-agnostic (convention 12).
- **P5 — Raw journal + outbox unchanged.** New events are stored raw before delivery (AC3), fan
  out per sink, reach the stub within 60 s (AC1); `externalUserId` verbatim (AC9).
- **P6 — One active Payment per user.** Soft-cancel/reactivate/card-change never create a second
  active Payment; the past-due card-change **advances the existing Payment by id**, never
  `createOrExtend` (Architect finding 4).

## 3. Decision Drivers (top 3)

- **D1 — Reuse over rebuild.** Every path rides existing infrastructure (outbox, pipeline,
  hosted checkout, `renewal_failed`, the `PAYMENT_CANCEL` queue pattern). Minimizes new surface
  and preserves AC8.
- **D2 — Money-safety.** The only new money movement (past-due owed charge) reuses the proven
  Purchase→callback path with deterministic keys; verify moves no money.
- **D3 — Live-gated provider risk.** Card Verify enablement is unverifiable offline → ship behind
  a flag, degrade cleanly, mirror the existing `SCHEDULER_ENABLED` / `W4P_POLLER_ENABLED` posture.

## 4. Viable Options (with bounded pros/cons)

### Decision 1 — Soft-cancel representation: `cancelRequestedAt` flag vs new `PendingCancellation` status
- **A. Timestamp flag on `payments` (CHOSEN).** `status` stays `Active`; add `cancelRequestedAt`.
  - Pros: no enum churn across shared/backend/frontend; the drift model is untouched; the UI
    derives a "Cancelling" state; `findDue` still reaches the row to emit the terminal signal.
  - Cons: "cancelling" is a *derived* state → the list filter needs a boolean, not an enum value
    (Decision 5). Soft-cancel is only meaningful for `Active` (see below), so the cancel route
    must **guard `status = Active`** (Architect finding 2).
- **B. New `PaymentStatus.PendingCancellation` enum value.** Rejected: touches the numeric enum
  (migration + every switch/label), and `findDue` must add the new status or it silently stops
  emitting the terminal signal — a foot-gun.

### Decision 2 — Card-change routing: `CheckoutSession.kind` discriminator vs a separate table
- **A. Add `kind` + `paymentId` to `checkout_sessions` (CHOSEN).** Reuses the hosted page, the
  Purchase/callback machinery, and session expiry; the callback branches on `kind` (convention 10).
- **B. Separate `card_change_sessions` table + route.** Rejected: duplicates hosted-page +
  callback + expiry machinery; violates D1.

### Decision 3 — Past-due owed charge: hosted priced Purchase vs verify-then-server-CHARGE
- **A. Hosted priced Purchase with the new card (CHOSEN, docs/23 decision 4).** One Purchase both
  tokenizes and collects; the callback advances the existing Payment and resets the ladder.
- **B. Verify first, then a separate CHARGE on the new token.** Rejected: two round-trips + an
  intermediate "verified but uncharged" half-state.

### Decision 4 — Active token rewrite: `updateToken` vs reuse `payment.extend` **(NEW — Architect finding 1)**
- **A. Dedicated `updateToken(id, recToken)` single-column update (CHOSEN).** Writes only
  `recurringTokenRef`.
  - Pros: a *free* card update never shifts the paid-through date; honors P1.
  - Cons: one more repo method.
- **B. Reuse `payment.extend` (data-access.ts:123-135).** Rejected: `extend` rewrites all date
  fields + forces `status=Active, retryAttempt=0`, re-anchoring billing dates to now — a silent
  P1 drift bug on a *free* card change.

### Decision 5 — Event emission from operator routes: direct publish vs durable queue message **(NEW — Critic M1)**
- **A. Enqueue a queue message; the worker handler publishes (CHOSEN).** Reactivate/defer routes
  `enqueue` `PAYMENT_REACTIVATE` / `PAYMENT_DEFER`; worker handlers publish the events — mirroring
  today's `PAYMENT_CANCEL` (contracts.ts:6-8, routes.ts:148, worker-boot.ts:57).
  - Pros: the outbox lives only in the worker runtime; this is the *only* correct path; inherits
    at-least-once redelivery + idempotency (P2/P3).
  - Cons: two new message types + handlers.
- **B. Publish directly from the server route.** Rejected: the server runtime has no outbox — this
  does not compile against the current architecture (Critic M1).

### Decision 6 — "cancelling" filter value: fake enum member vs boolean command field **(NEW — Critic)**
- **A. Separate boolean on the list command (CHOSEN).** `{ statuses?: PaymentStatus[]; cancelling?:
  boolean }`; `cancelling` maps to `status = Active AND cancelRequestedAt IS NOT NULL`.
  - Pros: no non-enum discriminant mixed into a `PaymentStatus[]` (conventions 2/10).
- **B. Synthetic `'cancelling'` string in the status list.** Rejected: crosses the domain boundary
  as a value that is not a `PaymentStatus`.

## 5. Pre-mortem — 3 concrete failure scenarios + mitigations

1. **Charge-after-cancel / dropped terminal event.** `findDue` has no row lock and the cancel
   route (server runtime) races the scheduler (worker runtime, worker-boot.ts:95); worse, a
   direct scheduler `advance`+`publish` is non-atomic (scheduler.ts:85-95) so a crash between them
   drops the terminal `renewal_failed` forever. *Mitigation (Architect finding 3):* add
   `FOR UPDATE SKIP LOCKED` to `findDue`; the cancel-pending branch does **not** publish inline — it
   `enqueue`s an idempotent `PAYMENT_LAPSE` message (idemKey `lapse:<paymentId>`) whose handler
   flips `cancelled` and publishes `renewal_failed(reason:'cancelled')` with a deterministic event
   id, so reaper redelivery is safe (AC2/P2). E2e asserts exactly one event across a forced crash.
2. **Card-change creates a *second* active Payment.** The real vector is
   `createOrExtend → findActiveByExternalUser`, which is **Active-only** (domain.ts:39,
   data-access.ts:91): a past-due card-change finds no active row and inserts a new one while the
   past-due row survives (Architect finding 4; corrects the earlier draft that blamed
   `insertPayment`, which actually writes `charge_fixations`, charge/data-access.ts:122-130).
   *Mitigation:* the card-change success handler advances the existing Payment **by
   `session.paymentId`** (`advanceAfterSuccess(paymentId, …)`), never `createOrExtend`. E2e asserts
   the `payments` row count is unchanged and the token differs.
3. **Deferral drift.** Writing `nextPaymentDate` directly bypasses the anchor. *Mitigation:*
   `/defer` mutates only `currentPeriodEnd`, then re-derives via `period.ts`; a unit test defers
   across a month boundary (Jan 20 +30d) and asserts the derived date equals the anchor-derived,
   clamped value (period.ts:23-40 clamps months).

## 6. Implementation steps (phased; each step cites files, sized for ESLint budgets)

### Phase 0 — Shared schemas & config (no behavior change)
- `packages/shared/src/schemas/event.ts` — add to `EVENT_NAMES` (after line 24): `payment_reactivated`,
  `payment_deferred`, `card_change_succeeded`, `card_change_failed`; a `Schema.Struct` per variant;
  extend the `DomainEvent` union (mirror `payment_cancelled`, line ~146). Payloads:
  - `payment_reactivated`: `{ externalUserId }`
  - `payment_deferred`: `{ externalUserId, newPeriodEnd, days }`
  - `card_change_succeeded`: `{ externalUserId, method }` (`method` = the card method used; for the
    verify path, the method carried in the verify callback / defaulting to the payment's `method`)
  - `card_change_failed`: `{ externalUserId, reason }`
- `packages/shared/src/schemas/payment.ts` — add `cancelRequestedAt: Schema.NullOr(Schema.Date)`
  to `Payment`; `PaymentStatus` enum unchanged (Decision 1A).
- `packages/shared/src/schemas/checkout.ts` — add `CheckoutSessionKind` numeric enum
  (`Checkout=0`, `CardChange=1`) + `kind` and `paymentId: Schema.NullOr(Schema.String)`; extend
  `CreateCheckoutSession`/insert derivations via `Schema.omit`/`pick` (convention 9). The checkout
  `insert` / `NewCheckoutSession` derivation must also set/default the new columns.
- `packages/shared/src/schemas/message.ts` — register the three new queue message types in
  `MESSAGE_TYPES` / `MessageType` (line ~13-20): `PAYMENT_REACTIVATE`, `PAYMENT_DEFER`,
  `PAYMENT_LAPSE` (this is the single source of truth the routes `enqueue` against and the worker
  dispatches on).
- config (`loadConfig`) — add `W4P_CARD_VERIFY_ENABLED` (default false).

### Phase 1 — DB migrations (typed `.ts`, next sequential numbers; server-applied)
- `ALTER TABLE payments ADD COLUMN "cancelRequestedAt" timestamptz` (nullable).
- `ALTER TABLE checkout_sessions ADD COLUMN kind integer NOT NULL DEFAULT 0, ADD COLUMN
  "paymentId" text` (nullable). Column names camelCase + double-quoted (CLAUDE.md §5).

### Phase 2 — Cancellation lifecycle (payment module + scheduler)
- `payment/data-access.ts` — `requestCancel(id)` sets `cancelRequestedAt = now`, **keeps
  `status = active`**, guarded to `status = Active` (reject past_due/cancelled/renewal_failed);
  add `clearCancelRequest(id)`; add `markCancelledLapsed(id)`; add `FOR UPDATE SKIP LOCKED` to
  `findDue` (line 99-107) to close the charge-after-cancel race.
- `payment/routes.ts` — `cancelPayment` (line 120): guard `status = Active`; set the flag;
  `enqueue` `PAYMENT_CANCEL` (emits `payment_cancelled`, unchanged path). Add `reactivatePayment`:
  guard `cancelRequestedAt != null AND status = Active` (else `UnprocessableEntity` 422 — explicitly
  rejects past_due); `clearCancelRequest`; `enqueue` `PAYMENT_REACTIVATE`. Register
  `POST /api/payment/:id/reactivate` (operator token, audited).
- New queue message types **`PAYMENT_REACTIVATE`** + handlers in the worker (worker-boot.ts,
  mirroring `cancelNotify`, cancel.ts:25/worker-boot.ts:57): the handler publishes
  `payment_reactivated` with a deterministic id.
- `billing/scheduler.ts` — before the charge (line 69-96): if `sub.cancelRequestedAt != null`,
  `enqueue` **`PAYMENT_LAPSE`** (idemKey `lapse:<paymentId>`) and skip the charge + ladder; the
  worker handler flips `cancelled` (`markCancelledLapsed`) and publishes
  `renewal_failed(reason:'cancelled')`. No inline publish (P2/pre-mortem 1).

### Phase 3 — Deferral (payment module)
- `payment/domain.ts` — `deferPayment(payment, days)`: validate `1 ≤ days ≤ 30` (typed
  `InvalidDeferral` with `toHttp → 422`, convention 7); new `currentPeriodEnd = old + days`; derive
  `nextPaymentDate` from the new anchor via `period.ts` (P1).
- `payment/data-access.ts` — `defer(id, newPeriodEnd, newNextPaymentDate)` (both computed in
  domain, not SQL).
- `payment/routes.ts` — `POST /api/payment/:id/defer` body `{ days }` (operator token, audited);
  `enqueue` **`PAYMENT_DEFER`**; worker handler publishes `payment_deferred(externalUserId,
  newPeriodEnd, days)`.

### Phase 4 — Payments status filter (backend + frontend)
- `payment/data-access.ts` — `listAll({ statuses?, cancelling? })` → `WHERE status IN ${sql.in(list)}`
  (mind the `sql.in` no-`IN`-keyword quirk, CLAUDE.md §5) and/or `cancelRequestedAt IS NOT NULL`.
- `payment/routes.ts` — `GET /api/payment` decodes repeated `status` + optional `cancelling` query
  params into a domain command (convention 2); `cancelling` is a **boolean**, not a status value
  (Decision 6).
- frontend `payments/PaymentsPage.vue` + `store.ts` + `api.ts` — multi-select status chips
  (Active / Cancelling / PastDue / Cancelled / RenewalFailed) → query params; keep the
  `externalUserId` filter. Labels i18n; enum values from shared `PaymentStatus` (convention 15).

### Phase 5 — WayForPay Card Verify (provider module)
- `wayforpay/client.ts` — add `verify(params)` (near `charge`, line 283): POST Card Verify
  (wiki 852189); deterministic `orderReference` `cardchg_<paymentId>_<…>`; sign via
  `signPurchase`/`signRequest` (convention 12); Approved/Declined is a value, not an Effect error.
  Gate the *call site* on `W4P_CARD_VERIFY_ENABLED`.
- `wayforpay/contracts.ts` — `W4pVerifyResponseSchema`; `mapping.ts` — map verify status + token.

### Phase 6 — Card-change flow (checkout + a dedicated applier)
- `checkout/routes.ts` — `POST /api/payment/card-change` (**service token**) body
  `{ externalUserId }`: resolve the user's Payment; if **none active or past_due** (i.e. only
  `cancelled`/`renewal_failed`, or no payment) → `Conflict` 409 "no re-tokenizable payment; start a
  new checkout". Otherwise create a `card_change` session (`kind=CardChange`, `paymentId` set,
  `amount = 0` if Active else the owed amount), reuse the checkout session TTL/`expiresAt`, return
  `{ checkoutUrl, sessionId, expiresAt }`.
- Provider callback — branch on `session.kind === CardChange` in the applier layer (not the generic
  matcher), keyed on `session.paymentId`, routed through a durable handler (idempotent):
  - **Verify success (Active):** `updateToken(paymentId, recToken)` (Decision 4); publish
    `card_change_succeeded`.
  - **Purchase success (past_due):** `updateToken` + `advanceAfterSuccess(paymentId, anchor)` +
    reset ladder (`retryAttempt=0`, `firstFailureAt=null`, `status=active`); publish
    `recurring_payment_succeeded` with the **full** payload (`amount, currency, method, period,
    source`) **and** `card_change_succeeded` (P2 order; P6 — advance-by-id, never `createOrExtend`).
    Note the builder signature: `recurringPaymentSucceeded(charge, match, paymentId)`
    (charge/domain.ts:66-79) takes a `Charge` + a `recurring`-kind `Match`, **not** a `Payment` — so
    the applier synthesizes those inputs from the card-change callback (the settled `Charge`) and
    the resolved Payment, or adds a thin `cardChangeSucceededPayload(payment)` builder; the executor
    must not pass a `Payment` to the existing signature.
  - **Decline/error:** publish `card_change_failed(reason)`; the Payment is unchanged (a past-due
    one keeps its ladder).
  - *Rationale:* a dedicated applier avoids teaching the generic checkout matcher (which always
    returns `kind:'checkout'`, checkout/domain.ts:39 → `initial_payment_succeeded` + create-or-extend)
    about card-change refs, while still reusing the recurring success builder so behavior matches a
    normal renewal (Critic M2). Considered feeding the collect through `chargeIncomingEvent` ingest
    (billing/events.ts:18) to inherit idempotency; rejected to avoid overloading the matcher.
- frontend `checkout/*` — "update your card" copy when the session is a card-change (0-amount hides
  the price).

### Phase 7 — i18n + doc ripples
- frontend `i18n/locales` en/ru/uk — labels for the 4 new events (sink flow picker derives names
  automatically, docs/22) and the new/derived statuses (incl. "Cancelling").
- Update docs/05 (entities), docs/06 (new endpoints), docs/07 (vocabulary) and docs/09 (new queue
  message types) where these are enumerated.

## 7. Testable acceptance criteria → docs/23 AC map (concrete assertions)

- **C1a** (`payment/test` + e2e): cancel on an Active payment sets `cancelRequestedAt`, leaves
  `status = Active` and all date fields byte-equal, and produces exactly one `payment_cancelled`;
  cancel on a `past_due`/`cancelled` payment returns 422.
- **C1b** (`billing/test` + e2e): at the due date a cancel-pending row enqueues `PAYMENT_LAPSE`
  whose handler emits **exactly one** `renewal_failed` with `reason='cancelled'`, **zero**
  `charge_retry_failed`, **zero** WayForPay `charge` calls, and ends `status = cancelled`; a forced
  reaper redelivery still yields exactly one event.
- **C1c** (`payment/test` + e2e): reactivate within the window clears `cancelRequestedAt`, emits one
  `payment_reactivated`, and the next scheduler pass charges normally; reactivate when
  `cancelRequestedAt = null` or `status ≠ Active` returns 422.
- **C1d** (`payment/test` + frontend test): `GET /api/payment?status=1&status=3` returns only those
  statuses; `?cancelling=true` returns only `status=Active AND cancelRequestedAt IS NOT NULL`;
  chips render from the shared enum.
- **C2a** (`payment/test/period.test.ts` + e2e): `defer(30)` sets `currentPeriodEnd += 30d`,
  `nextPaymentDate` equals the anchor-derived clamped value, `currentPeriodStart` unchanged, emits
  one `payment_deferred` carrying the new period end; `defer(31)` → 422; two sequential defers stack
  and both write audit rows.
- **C3a** (`checkout`/`charge` e2e): card-change on an Active payment runs a 0-amount verify;
  success calls `updateToken` (dates unchanged), emits one `card_change_succeeded`, makes **no**
  `charge` call, and leaves the `payments` row count unchanged.
- **C3b** (e2e): card-change on a `past_due` payment runs a priced Purchase for the owed amount;
  success updates the token, advances the period, resets `retryAttempt/firstFailureAt/status`, and
  emits **both** `recurring_payment_succeeded` (with a full `amount/currency/method/period/source`
  payload) and `card_change_succeeded`; `payments` row count unchanged (advanced by id, not
  create-or-extend).
- **C3c** (e2e): a declined card-change emits one `card_change_failed(reason)` and leaves the
  Payment (and its ladder) byte-unchanged.
- **C3d** (e2e): `POST /api/payment/card-change` returns 200 with a service token; **401** with no
  token and **403** with an operator token; **409** when the user has no active/past_due payment.
- **AC-global** (outbox e2e): each of the 4 new events is stored raw before delivery, fans out to
  every sink, is delivered within 60 s, decodes against its shared struct field-by-field, and
  carries `externalUserId` verbatim.

## 8. Expanded test plan

- **Unit** (hermetic): 4 event-envelope builders (deterministic ids); deferral date math
  (month-boundary clamp, bounds); reactivate/cancel status guards; scheduler cancel-pending
  decision; verify signature field-order; card-change amount selection by status;
  `card_change_succeeded.method` derivation.
- **Integration**: `data-access` on the migrated schema — `requestCancel`/`clearCancelRequest`/
  `markCancelledLapsed`/`defer`/`updateToken`/`listAll({statuses,cancelling})`; session
  `kind`/`paymentId` round-trip; the 4 new queue message types enqueue + handler dispatch.
- **E2E** (real Postgres): the four flows end-to-end with concrete DB + event assertions;
  redelivery/idempotency (pre-mortems 1 & 2); service-token authz + 409 on `/card-change`.
- **Observability**: audit rows for cancel/reactivate/defer/card-change; metrics — cancels,
  reactivations, deferrals, lapses, card-change success/fail; `card_change_failed` delivery is
  operator-visible via existing undelivered-events alerting.

## 9. Risks & mitigations (summary)

- **Card Verify not enabled on the account** → `W4P_CARD_VERIFY_ENABLED` off by default; an Active
  card-change returns a clear "verify unavailable" until confirmed live; the past-due priced path
  works regardless. Confirm on `nexttick_it1` (docs/14 follow-ups).
- **Cross-process cancel race** → `FOR UPDATE SKIP LOCKED` on `findDue` + queue-routed lapse
  (pre-mortem 1).
- **Second active payment** → advance-by-`paymentId`, never `createOrExtend` (pre-mortem 2).
- **Operator mis-defer** → hard 30-day cap in domain, audited.
- **Filter on 100k payments** → indexed `status`, bounded `LIMIT` retained.

## 10. Verification steps (run before claiming any phase done)

`npm run typecheck` + `npm run lint` (hard gates, CLAUDE.md §4); `npm test` (units); e2e runner
against `docker-compose.e2e.yml` for the touched scenarios; manual `/health`. No phase is "done"
until its ACs' tests pass with concrete assertions.

## 11. ADR (Architecture Decision Record)

- **Decision.** Ship the three scenarios as additive paths over existing infrastructure: a
  `cancelRequestedAt` flag with a queue-routed terminal lapse; an anchor-preserving `/defer`; a
  status-branched, service-token card-change that advances the existing Payment by id; four new
  events emitted only through worker-owned queue handlers; a dedicated `updateToken` for free
  re-tokenization.
- **Drivers.** D1 reuse-over-rebuild, D2 money-safety, D3 live-gated provider risk.
- **Alternatives considered.** New `PendingCancellation` enum (rejected — `findDue` foot-gun +
  enum churn); separate card-change table (rejected — duplicated machinery); reuse `payment.extend`
  for token rewrite (rejected — P1 drift); direct route publish (rejected — outbox is worker-only);
  verify-then-server-CHARGE for past-due (rejected — half-state); synthetic `cancelling` enum value
  (rejected — conventions 2/10).
- **Why chosen.** Maximizes reuse and AC8 conformance, keeps the drift-free and one-active-payment
  invariants structural (not branch-defended), and inherits queue idempotency/redelivery for every
  new emit.
- **Consequences.** Four new queue message types + handlers; two migrations; a dedicated
  card-change applier; the scheduler gains one branch and a row lock. Card Verify stays gated until
  live-confirmed.
- **Follow-ups.** Confirm Card Verify on `nexttick_it1`; resolve the hosted-vs-API verify mechanics
  (wiki 852189); decide whether Active card-change should be allowed when the user is `renewal_failed`
  (currently 409 → fresh checkout).

## 12. Open questions

- Exact Card Verify hosted-vs-API mechanics (wiki 852189) — resolve against the live merchant
  before enabling the flag (does not block building the gated path).
- Whether a `renewal_failed` user should be re-tokenizable via `/card-change` (charge the owed
  amount to recover) or forced to a fresh checkout — currently the latter (409).

## 13. Consensus review outcome + changelog

**Iteration 1 — Architect (sound-with-changes, 4 blocking) + Critic (REVISE, 3 must-fix + 4
nice-to-have).** All folded into this revision:

- **Architect-1 (P1 drift):** added Decision 4 — dedicated `updateToken`, never `extend`, for the
  free token rewrite (Phase 5/6, §5.2).
- **Architect-2 (PastDue cancel):** cancel route now guards `status = Active` (Phase 2, Decision 1A,
  AC-C1a).
- **Architect-3 (cancel race + dropped event):** `FOR UPDATE SKIP LOCKED` on `findDue` + queue-routed
  `PAYMENT_LAPSE` handler with a deterministic event id (Phase 2, pre-mortem 1, P2).
- **Architect-4 (second payment):** advance the existing Payment by `session.paymentId` via
  `advanceAfterSuccess`, never `createOrExtend`; corrected the earlier `insertPayment` misattribution
  (Phase 6, pre-mortem 2, P6).
- **Critic-M1 (worker-only outbox):** added Decision 5 + four queue message types
  (`PAYMENT_REACTIVATE`, `PAYMENT_DEFER`, `PAYMENT_LAPSE`, plus reuse of `PAYMENT_CANCEL`) with
  worker handlers; routes `enqueue`, never publish (Phases 2/3).
- **Critic-M2 (recurring-succeeded not free):** Phase 6 now specifies the dedicated applier, the
  recurring builder with a full payload, and advance-by-id.
- **Critic-M3 (AC↔test):** §7 rewritten with concrete per-AC assertions.
- **Nice-to-have:** `card_change_succeeded.method` origin (Phase 0); no-active-payment 409 +
  session expiry (Phase 6); `cancelling` modeled as a boolean (Decision 6); reactivate rejects
  past_due explicitly (Phase 2).

§4 options analysis passed the Critic's principle-consistency and fair-alternative checks in
iteration 1.

**Iteration 2 — verification (Critic): APPROVED-WITH-IMPROVEMENTS.** All 7 gates confirmed CLOSED
against source (each verified, not taken on the plan's word): A1 `updateToken` vs `extend`
(data-access.ts:123-135); A2 cancel guards Active (routes.ts:120-158 had none); A3 `FOR UPDATE SKIP
LOCKED` + durable `PAYMENT_LAPSE` (drop risk real at scheduler.ts:51-52); A4 advance-by-id
(`findActiveByExternalUser` Active-only, data-access.ts:91); M1 enqueue→worker publish
(worker-boot.ts:57); M2 full-payload recurring emit (charge/domain.ts:66-79); M3 concrete per-AC
assertions. `PAYMENT_LAPSE` idemKey + `ON CONFLICT DO NOTHING` (store.ts:65-67) + deterministic event
id keeps AC2 intact. Two MINOR nits raised and now folded into this revision: (1) the explicit
`shared/schemas/message.ts` edit (Phase 0); (2) the `recurringPaymentSucceeded` `Charge`+`Match`
signature clarification (Phase 6). Remaining items are the two live-only follow-ups in §12 (not
blockers to building the gated paths).
