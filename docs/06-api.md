# API Draft

Public and support HTTP surface. Authentication requirements are noted per section.

## Health

- `GET /health` (auth: none)

## Checkout sessions

- `POST /api/checkout-sessions` (auth: service token)
- `GET /checkout/:sessionId` (auth: none — public checkout page, unguessable session ID)

### `POST /api/checkout-sessions`

Request body:

```json
{
  "externalUserId": "sendpulse:123",
  "amount": 30000,
  "currency": "UAH",
  "period": "P1M"
}
```

Response: session ID, payment link URL, expiry.

## Subscriptions

- `GET /api/subscriptions/:id` (auth: service token)
- `GET /api/subscriptions?externalUserId=...` (auth: service token)

## Provider callbacks

- `POST /api/providers/:provider/callback` (auth: provider signature)

## Support / operator

All support endpoints require authentication (support token) and are audited.

- `GET /api/support/subscriptions?externalUserId=...`
- `GET /api/support/subscriptions/:id/events`
- `POST /api/support/subscriptions/:id/cancel`
- `GET /api/support/quarantine`
- `POST /api/support/quarantine/:id/bind` — bind an unmatched payment to a subscription (or create one); the event is then reprocessed normally
- `GET /api/support/deliveries?status=failed` — undelivered outgoing events
