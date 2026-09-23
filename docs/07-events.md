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
| `initial_payment_succeeded` | first checkout payment approved (match kind `checkout`) | external_user_id, amount, currency, method, period, source |
| `recurring_payment_succeeded` | a renewal charge approved (match kind `recurring`), incl. an operator-bound quarantine | external_user_id, amount, currency, method, period, source |
| `one_time_purchase_succeeded` | a one-time (non-recurring) checkout approved — a single buy, never renewed (match kind `checkout`, session `recurring = false`) | external_user_id, amount, currency, method, period, source |
| `initial_payment_failed` | first checkout payment **declined** for a known session — no retry ladder; the customer re-initiates checkout | external_user_id, amount, currency, method, period, reason, source |
| `charge_retry_failed` | failed intermediate **recurring** charge attempt | external_user_id, attempt number, next retry date, provider reason |
| `renewal_failed` | final failure of the **recurring** retry cycle (day 7) | external_user_id, reason |
| `payment_created` | new gateway Payment record appeared | external_user_id, amount, period |
| `payment_cancelled` | Payment soft-cancelled by an operator (access runs to period end) | external_user_id, reason |
| `payment_reactivated` | a pending cancellation reversed within the grace window (docs/23) | external_user_id |
| `payment_deferred` | operator granted N free days; the paid period was extended (docs/23) | external_user_id, new_period_end, days |
| `external_user_id_changed` | a service rename remapped a user's opaque id (docs/31) — emitted ONLY when the rename opts in (`refireEvents`); `external_user_id` is the NEW id | external_user_id (new), from, to, movedPayments, movedSessions |
| `card_change_succeeded` | a SendPulse-initiated card change tokenized/collected the new card (docs/23) | external_user_id, method |
| `card_change_failed` | a card-change attempt was declined/errored (docs/23) | external_user_id, reason |
| `unknown_payment_quarantined` | incoming charge went to quarantine | quarantine record reference |

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
