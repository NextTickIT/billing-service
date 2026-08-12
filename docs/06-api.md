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
- `GET /api/payment?status=<n>&status=<n>&cancelling=true` — filter the list by one or more statuses; `cancelling=true` selects active payments pending soft-cancel (docs/23)
- `POST /api/payment/card-change` (auth: service token) — SendPulse initiates a card change for a user; returns a checkout link. Active → 0-amount verify (gated by `W4P_CARD_VERIFY_ENABLED`); past_due/renewal_failed → priced Purchase for the owed amount that revives the same payment; cancelled/none → 409 (docs/23)

The `Payment` entity fields include `currentPeriodStart`, `currentPeriodEnd` (the anchor for drift-free date advancement), `nextPaymentDate`, and `cancelRequestedAt` (set while a soft-cancel is pending). `paid_till` is external (owned by SendPulse) and is not returned here.

## Provider callbacks

- `POST /api/providers/:provider/callback` (auth: provider signature)

## Operator console

All operator endpoints require authentication (operator/support token) and are audited. Routes are served under `/operator/*`.

- `GET /operator/payment?externalUserId=...` (also accepts the `status` / `cancelling` filters above)
- `GET /operator/payment/:id/events`
- `POST /operator/payment/:id/cancel` — soft-cancel: keeps access to period end, then lapses (docs/23)
- `POST /operator/payment/:id/reactivate` — reverse a pending cancellation within the grace window (docs/23)
- `POST /operator/payment/:id/defer` — grant N≤30 free days; extends the paid period (docs/23)
- `GET /operator/quarantine`
- `POST /operator/quarantine/:id/bind` — bind an unmatched charge to a Payment (or create one); the charge is then reprocessed normally
- `GET /operator/deliveries?status=failed` — undelivered outgoing events
