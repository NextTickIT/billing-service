# 32 — Payment-method change (previous-method agnostic)

## 1. Motivation

A subscriber must be able to switch their recurring payment between **Card**
(WayForPay, autocharged via a stored `recToken`) and **Crypto** (WhitePay, no
reusable token → a manual prompt each cycle). The existing `/api/payment/card-change`
(docs/23) only re-tokenizes a card; it cannot move a sub onto crypto, nor is it
symmetric. This spec generalizes it into one endpoint that switches to ANY target
method, regardless of the current one (card→crypto, crypto→card, card→card).

Key invariant reused: the scheduler decides autocharge-vs-manual by **token
presence** (`recurringTokenRef === null` → manual crypto prompt; else autocharge),
never by the `method` label. So a coherent switch manipulates the token, not just
the label.

## 2. Trigger & scope

`POST /api/payment/method-change` (service token). Body:

```jsonc
{ "externalUserId": "1001", "method": 1 } // method = DESTINATION: 0 = Card, 1 = Crypto
```

The server resolves the user's ONE recurring payment (`resolveChangeable`): the
newest recurring row, refusing a Cancelled one (or none) with `409`. One-time
payments are never a target. `/api/payment/card-change` is retained as the card-only
special case (`method: 0`, never a flip) for existing SendPulse callers.

## 3. API — discriminated response (`200`)

`MethodChangeResult`, keyed on `kind`:

- `{ "kind": "checkout", "sessionId", "checkoutUrl", "expiresAt" }` — the change
  needs a payment/verify at a link. Issued for → Card (always) and → Crypto while an
  amount is owed. The callback re-tokenizes/switches the SAME payment.
- `{ "kind": "applied", "method": 1 }` — the change took effect server-side with no
  payment. Only case: an up-to-date sub → Crypto (the "flip").

`409 CardChangeUnavailable` when there is no changeable recurring payment.

## 4. Semantics

### 4.1 Decision (`planMethodChange`, checkout/domain.ts)

Previous-method agnostic — branches only on `owed` × target:

| target | owed (past_due / renewal_failed) | not owed (active) |
|--------|----------------------------------|-------------------|
| Card   | checkout, amount = arrears       | checkout, amount = 0 verify (or `cardChangeChargeMinor` if verify off) |
| Crypto | checkout, amount = arrears       | **flip** (no payment) |

An owed change bills the actual arrears and revives the sub in place. Crypto has a
WhitePay minimum, so there is no free 0-amount crypto verify — hence the flip.

### 4.2 Applying a paid change (`applyCardChange`)

The recorded rail is keyed on the event **SOURCE**, not on whether a token came back:

- `whitepay_callback` (crypto) → drop any token + `setMethod(Crypto)` → next renewal
  is a manual crypto prompt.
- any WayForPay source (`wayforpay_callback` / `_charge` / `_poller`) → `setMethod(Card)`
  and store the new token IF present, but **never clear** it — an Approved WayForPay
  charge can omit `recToken` (docs/14), and clearing it would silently strip a live
  card sub. This records what the buyer actually paid even if they switched method on
  the checkout page from what was requested.

### 4.3 The flip (up-to-date → Crypto)

`clearToken` + `setMethod(Crypto)` + enqueue `method_changed`, all in ONE
transaction (so the sub is never switched but unannounced). No-op guard: if already
`Crypto` with a null token, return `applied` without mutating or emitting. The
message idemKey anchors on `currentPeriodEnd` (which the flip does not move), so a
client retry within the period dedupes to one notification.

### 4.4 `method_changed` event

Fired ONLY on the no-payment flip (there is no charge to carry the signal). The paid
paths already emit `card_change_succeeded` (always) and `recurring_payment_succeeded`
(when owed). Wired like `payment_deferred`: `PAYMENT_METHOD_CHANGE` message →
`methodChangeNotify` → `method_changed` DomainEvent (payload `{ method }`).

### 4.5 RenewalFailed revival (deliberate divergence)

`resolveChangeable` accepts a `RenewalFailed` (owed) recurring payment, so a
method-change can revive a terminally-lapsed sub by billing its arrears — a conscious
divergence from `findActiveRecurringByExternalUser`, which treats RenewalFailed as
terminal for the create-or-extend path.

## 5. Interactions & acceptance

- The card-change matcher runs before checkout/recurring, so a change callback never
  falls into create-or-extend. The owed advance is guarded on `owesMoney`, so a
  redelivered callback advances the anchor exactly once.
- The flip only runs on Active subs (future `nextPaymentDate`), so it cannot race a
  due scheduler tick; a tick reads the token at tick time (charge once, or already
  token-less → manual).
- `method_changed` reaches SendPulse ONLY if the operator maps a flow for it via
  `PUT /api/sinks/:code` (name-based dispatch; unmapped events are dropped).

## 6. Deferred / not in scope

- Locking the method on a change session's checkout page (the picker still offers
  both methods; correctness comes from recording what was actually paid).
- Folding `/card-change` into `/method-change` (kept for backward-compat).
- A route-level test of the flip's enqueued payload (no route/DB test harness yet).
