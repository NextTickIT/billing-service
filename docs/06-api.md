# API Draft

Public and support HTTP surface. Authentication requirements are noted per section.

## Health

- `GET /health` (auth: none)

## Checkout sessions

- `POST /api/checkout-sessions` (auth: service token)
- `GET /api/checkout-sessions/:id` (auth: service token as `Authorization: Bearer`, or the
  BFF secret for the hosted page; a missing or invalid credential is 401) — read a session
  by ID, read-only, the same body either way: `status` (0 created, 1 pending, 2 completed,
  3 expired), `expiresAt`, the terms and options, `startsAt`, `payableUntil`,
  `methodLocked`, and `everSentToProvider` (true once the session was claimed for payment — its order handed to
  a provider: the first claim stamps `firstSentToProviderAt`, which no release ever
  clears — or while it is Pending or Completed; false only for a session never claimed). Never `externalUserId` or `origin`.
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

Optional: `method` (defaults to Card; see `lockMethod` below), `recurring` (defaults to `true`), and
`successUrl`/`failureUrl` (http(s) post-payment redirects). `period` (ISO-8601 duration)
is **required for a recurring checkout** but **optional for a one-time purchase**
(`recurring: false`) — a one-time never renews, so it has no cadence.

`reportAs` (optional): `"initial"` or `"renewal"`; any other value is 400. `"renewal"`
requires `recurring: true` (otherwise 400) and changes only the outcome event names of
that link to `recurring_payment_succeeded` / `recurring_payment_failed`;
`payment_created` still fires for a new row. `"initial"` means "report as a first sale":
it is the explicit form of the default (same as omitting the field), is allowed on any
checkout, and exists because SendPulse cannot omit a JSON property conditionally, so its
flows send the field every time.

`startsAt` (optional, ISO-8601 instant): when the paid period of a subscription this
checkout **creates** begins, if later than the payment. Recurring checkouts only, and
`now ≤ startsAt ≤ now + 62 days`; otherwise **422** with the broken rule as `error`
(`startsAt is only allowed on a recurring checkout`, `startsAt must not be in the past`,
`startsAt must be at most 62 days ahead`). On settlement the new payment's
`currentPeriodStart` is `max(paidAt, startsAt)` and `currentPeriodEnd` /
`nextPaymentDate` = that + period × cycles (+ promo bonus). A payment that stacks onto the
contact's live subscription ignores it. A lapsed link re-issued as a clone keeps it; a link
re-minted at a live subscription's terms drops it (paying it stacks anyway). An
`Idempotency-Key` replay with a different `startsAt` is **409**.

`payableUntil` (optional, ISO-8601 instant): makes the checkout a **bounded offer** that
closes at that instant. `now < payableUntil ≤ now + 62 days`, otherwise **422**
(`payableUntil must be in the future`, `payableUntil must be at most 62 days ahead`). The
session's `expiresAt` is `payableUntil` instead of the usual TTL, and a bounded session is
**never** re-issued, cloned or re-minted: from `payableUntil` on — or once it lapses —
`POST /api/checkout-sessions/:id/pay` answers **410** `{"error":"this checkout is closed","code":"checkout_closed"}`
and writes nothing. While it is live, a Pending bounded session can be paid again (same
order reference). The WayForPay order timeout is capped so the provider order never
outlives `payableUntil` (at least 1 s). The public read returns `payableUntil` and
`startsAt`; the page shows a closed state once `payableUntil` has passed and, while
`startsAt` is ahead, the line "Your paid period starts {date}".

`lockMethod` (optional, default `false`): locks the payer to `method`, which is then
required (400 without it). The page hides the method picker (`methodLocked: true` on the
public read) and `/pay` with another method is **400** `method_locked`, exactly like a
`/prolong` link. A lapsed unbounded link cloned on re-issue stays locked; a re-mint at a
live subscription's terms uses that subscription's method and is not locked.

Response: session ID, payment link URL, expiry.

### `POST /api/payment/prolong`

Auth: service token. Mints a hosted pay link that extends the contact's live (Active or
PastDue) subscription. The link offers the cycle options configured by
`MANUAL_RENEWAL_CYCLE_OPTIONS` (1 / 3 / 6 months in production), paid as n × amount
under ref `chk_<id>_c<n>`. The method stays locked to the subscription's, as before.

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
