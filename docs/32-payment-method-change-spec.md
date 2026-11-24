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

The server resolves the user's recurring payment (`resolveChangeable` →
`changeablePayment`): the newest recurring row that is not Cancelled (RenewalFailed
included), or `409` when there is none — after a rename a user can hold an older live
payment behind a newer cancelled one. One-time
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

`flipToCrypto`: under the payment row lock, `clearToken` + `setMethod(Crypto)` + enqueue
`method_changed`, all in ONE transaction (so the sub is never switched but unannounced).
No-op guard: if already `Crypto` with a null token, return `applied` without mutating or
emitting. Otherwise the locked row must be `Active` with `nextPaymentDate` strictly in the
future by a fresh clock read, else `409` (see §5). The caller names the message idemKey: the
`method: 1` request anchors on `currentPeriodEnd` (which the flip does not move), so a client
retry within the period dedupes to one notification; the page flip keys on its session (§7).

### 4.4 `method_changed` event

Fired ONLY on the no-payment flip (there is no charge to carry the signal). The paid
paths already emit `card_change_succeeded` (always) and `recurring_payment_succeeded`
(whenever the charge moved money). That success carries `creditsPeriod: true` only when
the change credited a period (arrears collected); a charge that only re-tokenized the card
(the minimal tokenizing charge with verify off, or a priced change on a payment that owed
nothing) carries `creditsPeriod: false`, null `periodStart`/`periodEnd` and the unchanged
`nextPaymentDate` (docs/07). Wired like `payment_deferred`: `PAYMENT_METHOD_CHANGE` message →
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
- An Active sub is not necessarily before its due date: the scheduler takes a due row
  (`nextPaymentDate <= now`), releases its lock and then charges the token it read. So the
  flip requires, under the row lock, `nextPaymentDate` strictly in the future, and answers
  `409` for a due sub (on both the `method: 1` request and the page pick). A tick that
  locks the row after a flip reads it token-less → manual prompt.
- `method_changed` reaches SendPulse ONLY if the operator maps a flow for it via
  `PUT /api/sinks/:code` (name-based dispatch; unmapped events are dropped).

## 6. Deferred / not in scope

- Locking the method on a change session's checkout page (the picker still offers
  both methods; correctness comes from recording what was actually paid). A Crypto pick
  on a change link minted WITH a method is still a crypto purchase, never the page flip.
- Folding `/card-change` into `/method-change` (kept for backward-compat).
- A route-level test of the `method: 1` flip's enqueued payload. It shares
  `flipToCrypto` with the page flip, which `test/e2e/method-change.e2e.ts` covers (§7).

## 7. Method-less request — the payer picks on the page

The bot may send only the contact: `{ "externalUserId": "1001" }` (no `method`). The
answer is then always `{ "kind": "checkout", "sessionId", "checkoutUrl", "expiresAt" }`:
a `CardChange` session with `method = null` (nothing preselected, `lockMethod = false`),
priced by `planMethodChange(payment, undefined, …)`:

| sub state | amount | origin | page | Card pick | Crypto pick |
|-----------|--------|--------|------|-----------|-------------|
| owed (past_due / renewal_failed) | arrears | `card_change_arrears` | picker | Purchase of the arrears | WhitePay order for the arrears |
| active | 0 (verify on) or `cardChangeChargeMinor` | `card_change` | picker (no auto-verify) | verify / tokenizing Purchase | **flip**, no payment |

Paid picks land through the existing applier (§4.2), which records the method actually
paid. The page auto-starts the verify only for a 0-amount change session that carries a
method, so a session minted WITH a method behaves exactly as before.

**The page flip** (`isPageFlip`: `CardChange` + origin `card_change` + stored method null +
Crypto picked). `POST /api/checkout-sessions/:id/pay` then, in ONE transaction:
`claimAsApplied` (`created` → `completed`, method = Crypto, only while the stored method is
null), then run the flip of §4.3 (`flipToCrypto`, shared with the `method: 1` path). A sub
that owes, is gone or is due answers `409` and rolls the claim back — the link's verify
price cannot collect arrears, ask for a new one. The message idemKey is
`method-change:<sessionId>`, so each link announces its own switch: crypto → card → crypto
through three links sends two `method_changed`. It answers the new `PayInstruction` member
`{ "kind": "applied", "method": 1 }` and the page shows "Payment method changed." A double
click loses the claim (`409`) and flips nothing twice; the completed link cannot be paid
again. `CheckoutSessionPublic.cryptoSwitches` tells the page that a Crypto pick is this
switch: with Crypto selected it hides the amount and labels the button "Change payment
method" instead of "Pay".
