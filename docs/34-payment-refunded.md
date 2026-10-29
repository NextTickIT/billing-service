# 34 — `payment_refunded`: a refund as a billing event

A WayForPay refund of an order that settled a payment becomes one `payment_refunded`
domain event. It is delivered to every enabled sink, the CRM included. The CRM stores it
and the subscription dashboards exclude the reversed purchase. The refund changes nothing
else in billing: the Payment, its dates and its status stay as they were (D3 below).

Source: the cross-repo plan "Refunds as billing events, internal accounts as a CRM tag"
(revision 4, 2026-10-26). This page is the billing part of it. The decision numbers (D1…)
are that plan's.

## 1. What happens to a refund

A refund reaches billing as its own charge row, never as a change to the original one
(docs/14 §"Refunds", docs/15). There are two ways in:

| Path | `idemKey` | `source` |
|---|---|---|
| WayForPay callback, `transactionStatus = Refunded` | `w4pcb:<orderReference>\|Refunded` | `wayforpay_callback` |
| Migration poller, `transactionType = REFUND` | `w4p:<orderReference>\|REFUND\|<createdDate>` | `wayforpay_poller` |

The charge row has status `refunded` and `externalRef = orderReference`, the reversed
order. It carries no user. The pipeline (`process` in `charge/domain.ts`) handles it before
any matcher runs, because no matcher accepts a refund:

1. Under the per-order advisory lock (`charge-order:<orderReference>`, the same lock as the
   duplicate-copy guard), find the order's **original**: the charge with the same
   `externalRef`, `status = 'succeeded'`, `"matchResult" = 'matched'`, **joined to its
   `charge_fixations` row**. A duplicate success copy is marked matched without a fixation,
   so the join picks the charge that was actually recorded (`findSettledOriginal`). Should an
   order carry two fixations, one fixed to a payment wins over one bound without, then the
   earliest.
2. If the original exists and its fixation has a `paymentId`: publish `payment_refunded`,
   close the refund charge's quarantine row if an earlier run left one
   (`resolveQuarantineByRefund`, status `resolved`, no bound payment), and mark the refund
   charge `matched`. All three are one transaction, and `matched` is the last write.
3. Otherwise quarantine it exactly as before this change: `quarantine_records` row,
   `matchResult = 'quarantined'`, `unknown_payment_quarantined`. That covers an order
   billing never settled, a success without a fixation, and a success an operator bound
   without a payment (D11).

A refund charge is never bound as a payment, at two points:

- The operator bind route (`POST /api/quarantine/:id/bind`) answers 422 for a refund charge,
  before anything is audited or queued, with the reason "the charge is a refund and cannot
  be bound as a payment; once its original payment is settled, run
  charges:reprocess-refunded". It already refuses a quarantine that is no longer `open`.
- The `payment_rebind` worker handler refuses a charge whose status is `refunded`, for a
  bind queued before the route guard existed or before the refund was attributed. It
  writes nothing, emits nothing, logs `REBIND_REFUSED the charge is a refund; nothing
  written`, and completes the message.

**Provider note.** `w4pStatus` (`wayforpay/mapping.ts`) maps every
`transactionType = 'REFUND'` to `refunded`, whatever its `transactionStatus`. The refund
branch keys on charge status `refunded`, so it inherits that rule: a journal REFUND row the
provider marks declined is treated as a refund too.

## 2. The event

```
id:              evt_refund:<orderReference>
name:            payment_refunded
occurredAt:      the refund charge's occurredAt
correlationId:   the refund charge's idemKey
aggregateId:     the original fixation's paymentId
externalUserId:  the original fixation's externalUserId
payload:
  amount:            integer minor units, ≥ 0: what the provider reported on the refund row
  currency:          0 UAH / 1 USD / 2 EUR, from the refund row
  source:            wayforpay_callback | wayforpay_poller
  orderReference:    the reversed order (chk_… / sub_…)
  originalEventId:   evt_<original idemKey>:succeeded, the reversed success event
  reason:            the provider's reason or reasonCode, as a string; absent when it gave none
```

The shape is `PaymentRefundedEvent` in `shared/src/schemas/event.ts`; the builder is
`paymentRefunded` in `charge/domain.ts`. There is no `idempotencyKey`: the outbox
dedupes on the event id (`ON CONFLICT (id) DO NOTHING`), and the id is keyed on the order.

`originalEventId` is the id of the success event the refund reverses. In the CRM that is
the `payments.external_id` of the purchase, and in analytics its natural key.

`amount` is the magnitude of the provider's figure. Every refund row seen in production
carries a positive amount; a negative one would be sent as its absolute value (D4a).

The CRM wire body, as `crmBody` produces it (snake_case keys; the subject fields are copied
into the payload):

```json
{
  "id": "evt_refund:chk_1",
  "idempotency_key": "evt_refund:chk_1",
  "name": "payment_refunded",
  "occurred_at": "2026-09-06T12:00:00.000Z",
  "external_user_id": "64b7f0c2a1d3e4f5a6b7c8d9",
  "correlation_id": "w4pcb:chk_1|Refunded",
  "aggregate_id": "pay_1",
  "payload": {
    "amount": 223750,
    "currency": 0,
    "source": "wayforpay_callback",
    "order_reference": "chk_1",
    "original_event_id": "evt_w4pcb:chk_1|Approved:succeeded",
    "aggregate_id": "pay_1",
    "correlation_id": "w4pcb:chk_1|Refunded"
  }
}
```

`payment_refunded` is a money kind for the CRM sink (`MONEY_KINDS`, `sinks/crm.ts`). Only a
`validated` answer counts as delivered. An `unregistered` or `rejected` answer fails the
delivery permanently, because the reports exclude a purchase only on a validated refund.

No receipt email is sent for a refund: the receipt sink has no copy for the name (D7). The
SendPulse sink runs a flow for it only if an operator maps one in the console.

## 3. Boundary: one refund per order (D4)

This release reports **one refund per order**. The event id is `evt_refund:<orderReference>`,
so every copy of a refund of one order is one event:

- The callback copy and the poller copy of the same refund are two charge rows with two
  keys. Both reach the pipeline and both publish the same id; the outbox keeps the first.
- A second refund of the same order, for example a second partial refund, never reaches the
  pipeline by callback. Its callback key `w4pcb:<ref>|Refunded` is the same as the first
  one's. The queue drops the second message on that key (`infra/queue/store.ts`, ingest
  dedup), and the `charges` row is unique on it.
- The poller could bring a second refund as a new row, because its key carries the
  refund's own `createdDate`. It would still publish `evt_refund:<ref>`, which already
  exists, so nothing new reaches a sink.

Reporting partial or repeated refunds needs a provider operation identity at ingestion,
which the callback key does not have today. That is a follow-up, not this change.

## 4. Decisions in force here

- **D1.** Only `payment_refunded`. Billing has no chargeback status; `payment_chargeback`
  stays unimplemented.
- **D3.** No effect on access. The Payment, `currentPeriodEnd`, the schedule and SendPulse
  flows are unchanged. How a refund should affect a subscription is still an open owner
  question (docs/04).
- **D4 / D4a.** One refund per order (§3). `amount` is the provider's refund amount,
  zero allowed.
- **D7.** No receipt email; the console labels the event in en/ru/uk.
- **D8.** The backfill in §5.
- **D11.** A refund whose original was bound without a payment (`paymentId` null) is
  quarantined. `aggregateId` is mandatory and means the subscription; there is no honest
  fallback.

## 5. Operations

Three different repairs exist. Pick the one that matches where the refund stopped.

### 5.1 Reprocess the charge: `charges:reprocess-refunded`

For refunds that sit in quarantine: the ones that arrived before this release, and any
refund that arrived before its original settled. It runs every
`charges WHERE status = 'refunded' AND "matchResult" = 'quarantined'` through the normal
pipeline, oldest first, and prints one line of counters:

```sh
# in the worker image (production)
node packages/backend/dist/worker.js charges:reprocess-refunded
# from a checkout, against the database in the environment
npm run charges:reprocess-refunded -w @billing-service/backend
```

```
charges:reprocess-refunded {"selected":4,"unresolved":0,"skipped":1,"emitted":3,"duplicate":0,"failed":0}
```

| Counter | Meaning |
|---|---|
| `selected` | quarantined refund charges found |
| `unresolved` | still quarantined: no fixed original, or its `paymentId` is null (D11). Decided first, whoever owns the original |
| `skipped` | left untouched: the original's `externalUserId` is neither a 24-hex bot id nor a UUID (a smoke-test order) |
| `emitted` | a new `payment_refunded` row was stored |
| `duplicate` | the event id was already stored by another copy of the same refund, or another worker settled this charge meanwhile |
| `failed` | that charge's settlement failed and rolled back whole; its error is logged as `REFUND_BACKFILL_FAILED` and the others go on |

Each charge is settled in its own transaction, the same one the pipeline runs: lock the
charge, look up the original under the order lock, then publish, resolve and mark matched.
The counter is what that transaction reports, so a concurrent copy cannot be miscounted.

A new event fans out to every enabled sink like any other. A second run selects only what
stayed quarantined, so it emits nothing. The events carry the refund's own `occurredAt`,
which may be weeks old; the CRM refuses only moments in the future.

Expected first run in production (2026-10-26 data): `selected 4, emitted 3, skipped 1`. The
skipped one is the July smoke-test refund (`smoke-…`). The 22.09 original belongs to a
calibration-site UUID, a real buyer, and is emitted.

Check each emitted ref by following it, not by the totals: the `domain_events` row, its
`event_deliveries` row for `crm` with status `delivered`, the CRM `events` row stored as
`validated`, and finally the reversed purchase shown as excluded («Виключено — повернення
коштів») in the next analytics run of «Підписки по людях», and no longer counted in
«Підписки по датах».

### 5.2 Retry a delivery

For an event that is stored in billing but whose CRM delivery failed, for example because
the CRM answered `unregistered` before its registry knew the kind. That failure is
permanent for a money kind, so the delivery dead-letters. Billing has no requeue for a
dead letter (docs/33 §7). List the failed deliveries with the docs/33 §2 step 2 query and
hand the event ids to the B5 backfill (docs/33 §9), which re-posts them from outside this
repo. Reprocessing the charge (§5.1) does not help: the event already exists, so it would
count as `duplicate` and create no delivery.

### 5.3 Replay the CRM consumer

For an event the CRM stored but did not act on. That is CRM-side work. Registering a kind
in the CRM later does not re-deliver rows that its consumers' cursors have already passed,
so the CRM owner replays those consumers. Billing has nothing to resend in this case.

## 6. Deploy order

The CRM must register `payment_refunded` (guildmaster `crmEvents.ts`, a billing kind)
**before** this billing release emits anything. An unregistered refund is stored by the
CRM as `unregistered`, which billing treats as a failed delivery (§2), and recovering it
takes §5.2 plus §5.3. Order: the CRM release, then the analytics release, then this one,
then §5.1. The preflight POST for the new kind is in docs/33 §7(e).
