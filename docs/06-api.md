# API Draft

Public and support HTTP surface. Authentication requirements are noted per section.

## Health

- `GET /health` (auth: none)

## Checkout sessions

- `POST /api/checkout-sessions` (auth: service token)
- `GET /api/checkout-sessions/:id` (auth: service token) — read a session by ID
- `GET /checkout/:sessionId` (auth: none — public checkout page on `bill.nexttick.it`, unguessable session ID)

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

## Payment (gateway billing record)

- `GET /api/payment/:id` (auth: service token)
- `GET /api/payment?externalUserId=...` (auth: service token)

The `Payment` entity fields include `currentPeriodStart`, `currentPeriodEnd` (the anchor for drift-free date advancement), and `nextPaymentDate`. `paid_till` is external (owned by SendPulse) and is not returned here.

## Provider callbacks

- `POST /api/providers/:provider/callback` (auth: provider signature)

## Operator console

All operator endpoints require authentication (operator/support token) and are audited. Routes are served under `/operator/*`.

- `GET /operator/payment?externalUserId=...`
- `GET /operator/payment/:id/events`
- `POST /operator/payment/:id/cancel`
- `GET /operator/quarantine`
- `POST /operator/quarantine/:id/bind` — bind an unmatched charge to a Payment (or create one); the charge is then reprocessed normally
- `GET /operator/deliveries?status=failed` — undelivered outgoing events
