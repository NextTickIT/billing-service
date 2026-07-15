# Domain Events

Events are stored durably (outbox) before delivery. Each event is delivered to each connected sink at least once; sinks must be idempotent. Failed deliveries are retried; undelivered events are visible to the operator. Payment events must reach sinks within 60 seconds of payment fixation.

## Event vocabulary

Minimal vocabulary per 00 §6, extensible.

| Event | When | Required payload fields |
|-------|------|-------------------------|
| `payment_succeeded` | successful payment fixed (checkout, own billing cycle, external source) | external_user_id, amount, currency, method, period, source |
| `charge_retry_failed` | failed intermediate charge attempt | external_user_id, attempt number, next retry date, provider reason |
| `renewal_failed` | final failure of the retry cycle (day 7) | external_user_id, reason |
| `payment_created` | new gateway Payment record appeared | external_user_id, amount, period |
| `payment_cancelled` | Payment stopped (operator / provider event) | external_user_id, reason |
| `unknown_payment_quarantined` | incoming charge went to quarantine | quarantine record reference |

## Event envelope

```json
{
  "id": "evt_...",
  "name": "payment_succeeded",
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
