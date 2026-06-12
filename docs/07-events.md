# Domain Events

Events are stored durably before delivery. Consumers must expect at-least-once delivery.

## Event names

- `payment.link.created` payment link generated
- `payment.upcoming` billing date approaching
- `payment.started` charge or checkout started
- `payment.succeeded` payment completed
- `payment.failed` payment failed
- `payment.retry.scheduled` retry time set after failure
- `subscription.activated` first successful payment
- `subscription.renewed` recurring payment succeeded
- `subscription.past_due` first recurring failure
- `subscription.suspended` second recurring failure
- `subscription.restored` recovery payment succeeded
- `subscription.quarantined` grace period after suspension expired
- `subscription.cancelled` subscription ended
- `recurring_token.created` provider token stored
- `recurring_token.cancel_requested` cancellation sent to provider
- `recurring_token.cancelled` token cancelled at provider
- `access.remove_requested` downstream should revoke access
- `access.restore_requested` downstream should restore access

## Event envelope

```json
{
  "id": "evt_...",
  "name": "payment.succeeded",
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "correlationId": "...",
  "aggregateId": "subscription_...",
  "payload": {}
}
```
