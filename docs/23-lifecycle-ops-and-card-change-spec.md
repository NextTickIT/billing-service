# 23 — Operator lifecycle ops & SendPulse-initiated card change

Three operator/integration scenarios the gateway is missing: a **soft cancellation** that
lapses access at period end (not instantly), a **deferral** that grants free days, and a
**SendPulse-initiated card change** that re-tokenizes (or collects an owed charge) without
building a new billing flow from scratch. Each rides the existing pipeline, outbox, and
checkout infrastructure — no core rewrite (AC8). Crystallized from a deep-interview
(9 rounds, final ambiguity 17%); provenance in the appendix.

Extends the event vocabulary of [07](07-events.md) / [22](22-scenario-payment-events.md),
the date model of [CLAUDE.md §6], and the WayForPay surface of [14](14-wayforpay-research.md).

## Why

- **Cancel is too blunt today.** `POST /api/payment/:id/cancel` flips status to `cancelled`
  immediately; `findDue` then silently drops it (`status IN (Active, PastDue)`), so the user
  loses the period they already paid for and SendPulse gets no clean "renewal will not
  happen" signal at term. Operators need to cancel *at end of the paid period*.
- **No retention lever.** There is no way to grant a user extra days (goodwill, support
  resolution) without charging them.
- **Card changes are stranded.** A user whose card expires or fails has no path to update it
  except a full new priced checkout. SendPulse (the access owner) needs to trigger a
  re-tokenization — free when the user is current, and collecting the arrears when they are
  behind — and learn the outcome.

## Scope — three components

| # | Component | New surface | Reuses |
|---|-----------|-------------|--------|
| 1 | **Cancellation lifecycle** (soft-cancel + reactivate + status filter) | `cancelRequestedAt` flag, `/reactivate`, scheduler branch, UI filter | existing cancel route, `renewal_failed`, `payment_cancelled` |
| 2 | **Payment deferral** | `/defer`, `payment_deferred` event | `payment/period.ts` anchor derivation, audit log |
| 3 | **SendPulse-initiated card change** | `/card-change` (service token), WFP `verify()`, `card_change_succeeded/failed` events, `CheckoutSession.kind` | hosted checkout page, Purchase/callback pipeline, `payment.extend` token-update path |

---

## Component 1 — Cancellation lifecycle (soft-cancel to period end)

**Model.** Cancellation is a *scheduled* end, not an instant kill. The user keeps the access
they paid for until `currentPeriodEnd`; at the due date we stop instead of charging.

### Behavior

1. **On operator cancel** (`POST /api/payment/:id/cancel`, operator token, audited):
   - Set `cancelRequestedAt = now` (payment stays `status = active`; access continues).
   - Emit `payment_cancelled` immediately (informational — unchanged from today).
   - Do **not** set `status = cancelled` yet, and do **not** touch dates.
2. **At the due date** (scheduler reaches it because it is still `active`):
   - If `cancelRequestedAt IS NOT NULL`: **do not charge, run no retry ladder.** Emit the
     existing terminal `renewal_failed` with `reason = 'cancelled'`, then set
     `status = cancelled`. This is the "payment failed with no tries" the requester asked
     for; SendPulse already treats `renewal_failed` as a terminal lapse, so no new sink flow
     is needed.
3. **Reactivate** (`POST /api/payment/:id/reactivate`, operator token, audited):
   - Allowed **only** while `cancelRequestedAt IS NOT NULL AND status = active` (i.e. the paid
     period is still running and the terminal lapse has not fired). Clears
     `cancelRequestedAt`; the next scheduled charge proceeds "as if everything is OK."
   - Emit a new `payment_reactivated` event so SendPulse reverses the earlier
     `payment_cancelled`.
   - After the due-date lapse (`status = cancelled` / `renewal_failed` sent) reactivation is
     **impossible** — recovery is a fresh checkout (consistent with `renewal_failed` being
     terminal).

### Why a flag, not a new status

Keeping `status = active` + a `cancelRequestedAt` timestamp (rather than a
`pending_cancellation` enum value) means `findDue` is unchanged (it must still reach the
payment to emit the terminal signal), the drift-free date model is untouched, and there is no
enum/migration churn across shared/backend/frontend. The UI derives a **"Cancelling"** display
state from `status = active AND cancelRequestedAt IS NOT NULL`.

### Scheduler change

`billing/scheduler.ts` gains one branch before the charge call: a due payment with
`cancelRequestedAt` set skips `wayforpay.charge`, emits `renewal_failed(reason:'cancelled')`
through the same publish path, and marks `cancelled`. State is updated **before** the event is
emitted (consistency rule, CLAUDE.md §5).

### Payments-list status filter (UI)

- `PaymentsPage.vue`: add **multi-select status chips** — Active, Cancelling, PastDue,
  Cancelled, RenewalFailed — that pass a `status` query param to the list endpoint so filtering
  spans **all** payments, not just the loaded 500. The existing `externalUserId` filter stays.
- `GET /api/payment` gains an optional repeated `status` query param (numeric `PaymentStatus`
  values, plus a synthetic `cancelling` handled server-side as `active + cancelRequestedAt`).
  `listAll` gains a `WHERE status IN (…)` clause; empty filter = today's behavior.
- Labels are i18n (en/ru/uk), values come from the shared `PaymentStatus` enum (CLAUDE.md §3
  convention 15).

---

## Component 2 — Payment deferral (grant N free days)

**Model.** Deferral extends the paid period as a goodwill grant, preserving the drift-free
anchor.

### Behavior

- `POST /api/payment/:id/defer` (operator token, audited), body `{ days: number }`,
  `1 ≤ days ≤ 30`. **Repeatable** (each application ≤ 30 days); every application is written to
  the audit log with operator + reason.
- Effect: `currentPeriodEnd += days`; **re-derive** `nextPaymentDate` from the new
  `currentPeriodEnd` via `payment/period.ts` (never hand-set — the anchor stays the single
  source of truth, so drift is still structurally impossible). `currentPeriodStart` unchanged.
- Emit a new `payment_deferred` event carrying `externalUserId` + the new `currentPeriodEnd`
  (the new paid-through date) so SendPulse extends `paid_till`. There is no existing event that
  extends access without a payment, so this is a required new vocabulary item; reusing
  `recurring_payment_succeeded` with `amount = 0` was rejected (it would misreport a charge).
- **Scope:** active payments. Deferring a `past_due` payment (the "pause the retry ladder"
  variant) is **out of scope** here — arrears recovery is the card-change / retry path.

---

## Component 3 — SendPulse-initiated card change

**Model.** SendPulse (the access owner) triggers a hosted flow to update the stored card. The
mechanism is **status-dependent**:

| Current payment state | Mechanism | Money moves? | On success |
|-----------------------|-----------|--------------|------------|
| `active` (current, nothing owed) | **Card Verify** (WFP wiki 852189), 0-amount | No | rewrite `recurringTokenRef` only |
| `past_due` **or** `renewal_failed` (money owed) | **priced Purchase for the owed amount** with the new card | Yes (the arrears) | **keep the same payment**: rewrite token, collect, advance the period, **reset the retry ladder**, set `active`, emit `recurring_payment_succeeded` |

The requester's rule — *"if a recurrent payment is past-due, instead of the verify call it should
be charged the proper amount right away"* — is captured by this branch: an owing payment skips
verify and runs the real Purchase, whose callback both tokenizes and collects. A **terminally
failed** (`renewal_failed`) recurrent payment is handled the **same way** — the card change
**revives the same payment in place** (never a new record); it is *not* forced to a fresh checkout.
Only a `cancelled` payment (a deliberate stop) or a user with no payment is refused.

### Flow

1. **Initiation** — `POST /api/payment/card-change` (**service token, SendPulse-only**; no
   operator-console trigger), body `{ externalUserId }`. Resolve the user's recurrent payment,
   create a `CheckoutSession` with `kind = 'card_change'` and `paymentId` set, and branch by state:
   - `active` → `amount = 0`, verify mode;
   - `past_due` or `renewal_failed` (money owed) → `amount = <owed>` (the payment's charge amount);
   - `cancelled`, or no payment → **refuse (409)** — a deliberate stop is not re-tokenizable; start
     a fresh checkout.
   Return `{ checkoutUrl, sessionId, expiresAt }`. SendPulse presents the URL to the user.
2. **Hosted page** — reuse the checkout page (copy = "update your card"). Verify mode submits a
   WayForPay **Card Verify** request; the owed-money mode submits the normal Purchase for the owed
   amount.
3. **Callback** — the provider callback is routed by `session.kind`:
   - `card_change` + verify success → write `recurringTokenRef` on the referenced payment via a
     dedicated token-only update (never the date-rewriting `extend`); emit `card_change_succeeded`.
   - `card_change` + owed-money Purchase success (`past_due` **or** `renewal_failed`) → **keep the
     same payment**: write token, advance `currentPeriodStart/End`, reset `retryAttempt = 0` /
     `firstFailureAt = null` / `status = active`, emit `recurring_payment_succeeded` (existing)
     **and** `card_change_succeeded`. State updated before events (consistency rule).
   - any decline / error → emit `card_change_failed` with the provider `reason`; the payment is
     unchanged (an owing one keeps its state; a `past_due` one keeps its ladder).
4. **Result signalling** — SendPulse initiated the change, so it receives **both**
   `card_change_succeeded` and `card_change_failed` for explicit tracking (chosen over
   failure-only or polling).

### WayForPay `verify()`

Add `verify()` to `wayforpay/client.ts` implementing Card Verify (wiki 852189) — the documented
"tokenize without a purchase" path ([14](14-wayforpay-research.md) TL;DR §1). Deterministic
`orderReference` (`cardchg_<paymentId>_<…>`) and idemKeys, consistent with FR-006. **Live-only
gate:** Card Verify account enablement and exact hosted-vs-API mechanics must be confirmed
against the production merchant (`nexttick_it1`) before enabling — ship behind a flag
(e.g. `W4P_CARD_VERIFY_ENABLED`), matching the existing "gated pending production access"
posture for recurring CHARGE / poller. `recToken` issuance itself is already confirmed live
(docs/14 addendum, 2026-07-27).

---

## Event vocabulary additions

Four new names in `packages/shared/src/schemas/event.ts` (`EVENT_NAMES`, a struct per variant,
the `DomainEvent` union). The outbox is name-agnostic and the frontend sink-flow picker derives
its list from `EVENT_NAMES`, so delivery, idempotency, the 60 s SLA, and the picker all pick
these up automatically (as in [22](22-scenario-payment-events.md)); only i18n labels
(en/ru/uk) are hand-added.

| Event | Fires when | Payload |
|-------|------------|---------|
| `payment_reactivated` | operator reactivates within the grace window | `externalUserId` |
| `payment_deferred` | operator defers by N days | `externalUserId`, `newPeriodEnd` |
| `card_change_succeeded` | card-change session tokenizes (verify) or collects (past-due) | `externalUserId`, `method` |
| `card_change_failed` | card-change session declines/errors | `externalUserId`, `reason` |

`renewal_failed` is **reused** (reason `'cancelled'`) for the soft-cancel lapse — no new name.

## Data model changes

- `payments`: add `cancelRequestedAt timestamptz NULL` (soft-cancel grace flag). New migration.
- `checkout_sessions`: add `kind` (enum: `checkout` | `card_change`, numeric at rest) and
  `paymentId text NULL` (the Payment a card-change targets). New migration; existing rows default
  to `checkout` / null.
- No change to the drift-free date fields; deferral mutates `currentPeriodEnd` through the
  existing `period.ts` derivation.

## API additions / changes

| Method / path | Auth | Change |
|---------------|------|--------|
| `POST /api/payment/:id/cancel` | operator (audited) | **semantics change**: set `cancelRequestedAt`, emit `payment_cancelled`, keep `status = active` |
| `POST /api/payment/:id/reactivate` | operator (audited) | **new**: grace-window-only un-cancel + `payment_reactivated` |
| `POST /api/payment/:id/defer` | operator (audited) | **new**: `{ days ≤ 30 }`, extend period, `payment_deferred` |
| `GET /api/payment` | service/operator | **new** optional repeated `status` filter param |
| `POST /api/payment/card-change` | **service token** | **new**: `{ externalUserId }` → `{ checkoutUrl, sessionId, expiresAt }` |
| provider callback | signature | route by `session.kind`; card-change branch updates token / collects |

## Non-goals

- Refunds / `payment_refunded` (still deferred).
- **Operator-console** card-change trigger (SendPulse-only by decision).
- Deferring a `past_due` payment / pausing the retry ladder.
- **Reactivating** (un-cancelling) a payment after the period has lapsed — that path is
  grace-window-only. (Distinct from card change: a terminally-failed `renewal_failed` payment
  *can* be revived by a card change that pays the arrears — see Component 3.)
- Reviving a `cancelled` payment via card change (a deliberate stop → fresh checkout; 409).
- Minimal-charge or full-re-checkout tokenization fallbacks (Card Verify is the chosen path;
  fallback only revisited if account enablement fails).

## Acceptance criteria

- [ ] AC-C1a: Cancel sets `cancelRequestedAt`, emits `payment_cancelled`, leaves `status = active`
      and dates untouched; the user is still charged nothing early and access continues.
- [ ] AC-C1b: At the due date, a cancel-pending payment emits exactly one `renewal_failed`
      (`reason='cancelled'`), **no** `charge_retry_failed`, no WFP charge call, and ends
      `status = cancelled`.
- [ ] AC-C1c: Reactivate within the window clears the flag, emits `payment_reactivated`, and the
      next scheduled charge runs normally; reactivate after lapse is rejected.
- [ ] AC-C1d: The payments list filters by multi-selected statuses (incl. the derived
      "Cancelling") via a backend param across all payments.
- [ ] AC-C2a: Defer(N≤30) sets `currentPeriodEnd += N`, re-derives `nextPaymentDate` from the
      anchor (no drift), leaves `currentPeriodStart`, emits `payment_deferred(newPeriodEnd)`, and
      is audited; N>30 is rejected; repeat deferrals stack and each is audited.
- [ ] AC-C3a: Card-change on an `active` payment runs a 0-amount Card Verify; success rewrites
      `recurringTokenRef` and emits `card_change_succeeded`; no money moves; no new Payment.
- [ ] AC-C3b: Card-change on a `past_due` **or** `renewal_failed` payment runs a priced Purchase
      for the owed amount; success keeps the **same** payment record (no new row), rewrites the
      token, advances the period, resets the ladder, sets `active`, and emits both
      `recurring_payment_succeeded` and `card_change_succeeded`.
- [ ] AC-C3c: A declined card-change emits `card_change_failed(reason)` and leaves the payment
      unchanged (a `past_due` ladder continues; a `renewal_failed` payment stays failed).
- [ ] AC-C3d: `POST /api/payment/card-change` requires a service token (operator/anon → 401/403);
      a `cancelled` payment or a user with no payment → 409.
- [ ] AC-global: All four new events are stored raw in the outbox before delivery (AC3), fan out
      to every sink, and reach the stub sink within 60 s (AC1); `externalUserId` is verbatim (AC9).

## Invariants preserved

Drift-free dates (deferral re-anchors), one active Payment per user, state-before-events,
three-layer queue idempotency, deterministic provider keys, no core edits for the new
event names (AC8), raw-journal-before-processing (AC3).

---

## Appendix — Interview provenance

- Type: brownfield · Rounds: 9 · Final ambiguity: **17%** (threshold 20%, source: default).
- Topology (locked Round 0): 3 active components — Cancellation lifecycle, Payment deferral,
  SendPulse-initiated card change. No deferrals.

| # | Decision | Resolution |
|---|----------|------------|
| 1 | Cancel model | Soft-cancel to period end (not instant) |
| 2 | Proactive tokenize mechanism | Card Verify (true 0-amount) |
| 3 | Deferral model | Grant N free days (extend period) + event |
| 4 | Owed charge after failed due | Past-due skips verify → charge owed amount right away |
| 5 | Soft-cancel due-date event | Reuse `renewal_failed` (`reason='cancelled'`) |
| 6 | Card-change API + reporting | Return URL; emit both success + failure events |
| 7 | Deferral signal | New `payment_deferred` event (carries new period end) |
| 8 | Reactivate | Grace-window only + `payment_reactivated`; terminal after lapse |
| 9 | Bounds / auth / filter | Defer ≤30 repeatable audited · card-change service-token-only · multi-select status chips (backend param) |
