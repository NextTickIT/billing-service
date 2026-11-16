# Domain Events

Events are stored durably (outbox) before delivery. Each event is delivered to each connected sink at least once; sinks must be idempotent. Failed deliveries are retried; undelivered events are visible to the operator. Payment events must reach sinks within 60 seconds of payment fixation.

## Event vocabulary

Minimal vocabulary per 00 §6, extensible.

Success and first-payment failure are split **by scenario** so downstream flows can
differ (a "welcome" flow for a first payment vs. a "renewed" flow for a renewal vs. a
"try again" flow for a decline). The pipeline picks the success variant from the match
kind (`checkout` → initial, `recurring` → renewal); see 22.

| Event | When | Required payload fields |
|-------|------|-------------------------|
| `initial_payment_succeeded` | first checkout payment approved (match kind `checkout`) | external_user_id, amount, currency, method, period, source, charge_kind |
| `recurring_payment_succeeded` | a renewal charge approved (match kind `recurring`), incl. an operator-bound quarantine | external_user_id, amount, currency, method, period, source, charge_kind |
| `one_time_purchase_succeeded` | a one-time (non-recurring) checkout approved — a single buy, never renewed (match kind `checkout`, session `recurring = false`) | external_user_id, amount, currency, method, period, source, charge_kind |
| `subscription_migrated` | a checkout created with `reportAs: "renewal"` (origin `migration`) settled — whether it created the payment or stacked onto a live one. Published **in addition** to that charge's success event, right after it, with the **same payload** and its own id `evt_<idemKey>:migrated`. Scheduler renewals never emit it. Not a money kind for the CRM sink (the success event carries the money) | same as the success events |
| `initial_payment_failed` | first checkout payment **declined** for a known session — no retry ladder; the customer re-initiates checkout | external_user_id, amount, currency, method, period, reason, source |
| `charge_retry_failed` | failed intermediate **recurring** charge attempt | external_user_id, attempt number, next retry date, provider reason, amount, currency, method (the payment's terms the retry charges again) |
| `renewal_failed` | final failure of the **recurring** retry cycle (day 7) | external_user_id, reason |
| `payment_created` | new gateway Payment record appeared | external_user_id, amount, currency, method, period |
| `payment_cancelled` | Payment soft-cancelled by an operator (access runs to period end) | external_user_id, reason |
| `payment_reactivated` | a pending cancellation reversed within the grace window (docs/23) | external_user_id |
| `payment_deferred` | operator granted N free days; the paid period was extended (docs/23). Also the **handover** defer (`reason: "handover"`): a card-check payment's first charge moved while the payer is still paid elsewhere — it grants no access | external_user_id, new_period_end, days, revision (the payment's defer revision this defer set, incremented in the date-moving UPDATE; order defers by it, never by delivery); reason optional (`handover`) |
| `external_user_id_changed` | a service rename remapped a user's opaque id (docs/31) — emitted ONLY when the rename opts in (`refireEvents`); `external_user_id` is the NEW id | external_user_id (new), from, to, movedPayments, movedSessions |
| `card_change_succeeded` | a SendPulse-initiated card change tokenized/collected the new card (docs/23) | external_user_id, method |
| `card_change_failed` | a card-change attempt was declined/errored (docs/23) | external_user_id, reason |
| `payment_refunded` | the provider refunded an order that settled a payment; one per order, the callback and poller copies collapse on the id `evt_refund:<orderReference>` (docs/34) | external_user_id (of the reversed charge), amount, currency, source, order_reference, original_event_id; reason optional |
| `subscription_card_checked` | a card check (`firstCharge: "card_check"`) verified the card: the payment exists (Active, token on file), its first plan-price charge is the scheduled one at `next_payment_date` (= the session's `startsAt`). Published after `payment_created`; never with a success event | the success payload with amount 0, `next_amount` = plan price in `currency` (the plan's), period_start/period_end null, checkout_session_id, charge_kind `checkout`; aggregate = the payment |
| `card_check_failed` | a card check did not activate: `late` (verify at ≥ startsAt − 24 h or ≥ payableUntil) or `on_live` (a live subscription exists) close the session; `declined` leaves it open | external_user_id, reason, checkout_session_id, metadata; aggregate = the session |
| `card_check_anomaly` | a callback for an open card-check session that is neither a verified card nor a decline; nothing written | external_user_id, status, reason_code (raw provider values, null when absent), token_present, checkout_session_id, metadata; aggregate = the session |
| `unknown_payment_quarantined` | incoming charge went to quarantine | quarantine record reference |

`payment_created` for a card check carries the plan's `amount`/`currency` and
`first_charge: "card_check"` (no money moved). The success of the order that first credited such a
payment a period (scheduled, `/prolong`, manual renewal or an arrears card change) adds
`card_check_first_charge: true` to its success payload; the crediting transaction records
that order (`payments."firstMoneyRef"`), so exactly one success carries it. A small
card-change charge credits no period (`period_end` null) and is never marked. A copy of a
scheduled charge's receipt that carries no snapshot (the poller's, which shares the
scheduler's queue key) waits — retried by the queue — until the scheduler's approval has
committed, then reports the window that approval recorded in the `scheduler.advance`
ledger. The CRM wire shape of each is pinned by
`packages/shared/test/fixtures/wire/*.json` (checked against the builders by
`sinks/test/wire-fixtures.test.ts`); the CRM sink delivers the three card-check kinds and a
handover `payment_deferred` only on `validated`, retrying `unregistered`.

**`periodStart` / `periodEnd`** on the success events give the payment's paid-through
coverage after the charge, not always the slice this charge bought. `periodEnd` is the new
end. `periodStart` is where the continuous coverage ending there began. A charge that opens
a fresh window has its own slice start there: a first payment, or a renewal paid at or after
the old end, which is every on-time scheduled renewal. A charge stacked onto time still
running keeps the earlier start of the whole coverage: a renewal paid early, or a prolong
checkout. That charge's own slice is [the previous success event's `periodEnd`,
`periodEnd`]. The anchors come from `stackAnchors` (`payment/domain.ts`).

A checkout created with `startsAt` (docs/06) that **creates** a payment anchors it at
`max(paidAt, startsAt)`, so `periodStart` is that instant and `periodEnd` /
`nextPaymentDate` run a full period (× cycles, + promo bonus) from it. A charge that stacks
onto a live payment ignores `startsAt`.

**`checkoutSessionId`** (`checkout_session_id` on the CRM wire, optional) on the success
events (`initial_`/`recurring_`/`one_time_purchase_succeeded`, `subscription_migrated`) is
the id of the checkout session that settled the charge: the session actually paid, so a
re-issued link reports its replacement's id, not the lapsed one. Present whenever a
checkout or card-change session settled the charge (`chargeKind: checkout`); absent for a
`scheduled` renewal and for an operator bind of a quarantined charge (no session settled
it, even when its reference makes `chargeKind` `checkout`). Additive; existing consumers
ignore it.

**`nextAmount`** (`next_amount` on the CRM wire) on the success events is what the next
scheduled charge takes by itself, in minor units of the event's `currency`: the payment's
renewal terms after this charge while a card token is on file (`autochargeAmount` in
`payment/domain.ts`). It can differ from `amount`: a multi-cycle or intro-priced charge
renews at one cycle's terms. It is null when the next renewal will not autocharge (a
token-less crypto payment gets a `payment_manual_required` prompt whose page may offer
several cycle counts) and when there is no next charge (a one-time purchase, an operator
bind). Events stored before the field existed lack it.

**`chargeKind`** (`charge_kind` on the CRM wire) on the three success events says what
STARTED the charge (owner decision 2026-10-21): `scheduled` for billing's own renewal
charge of the stored token, `checkout` for any payment through a checkout session (a first
payment, a plain checkout, a manual-renewal link, a card change that moved money). It is
the origin, not the path that settled the charge. The scheduler's own call, the WayForPay
callback and the poller all carry the same orderReference, so a scheduled renewal is
`scheduled` whichever of them brings it in, while `source` names that path. The pipeline
sets it once from the match kind (`chargeKindOf` in `charge/domain.ts`): `recurring` (an
order the scheduler minted, `sub_…`) → `scheduled`; `checkout` and `card_change` (a
session) → `checkout`. So a manual renewal reports `recurring_payment_succeeded` with
`chargeKind: checkout`. An operator-bound quarantine matched nothing, so its orderReference
decides (`boundChargeKind`). A billing renewal order (`sub_…`) or a WayForPay-managed
regular payment (`…_WFPREG-…`, docs/15) → `scheduled`; anything else → `checkout`.

Recurring failures keep the two-event ladder (`charge_retry_failed` per attempt on days
0/1/3/5/7, then `renewal_failed`); a first-payment failure is a **single** terminal
signal with no automated retry — recovery is the customer re-initiating a new checkout.

## Event envelope

```json
{
  "id": "evt_...",
  "name": "initial_payment_succeeded",
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "correlationId": "...",
  "externalUserId": "sendpulse:123",
  "aggregateId": "payment_...",
  "payload": {}
}
```

- `externalUserId` is carried verbatim from the calling system in every event (AC9). It is `null` only for `unknown_payment_quarantined`, where the user is by definition unknown.
- `occurredAt` is UTC.
- Amounts in payloads are integer minimal currency units.
