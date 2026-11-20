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
  Deploy note (migration 0027): every row existing when it runs is backfilled as sent,
  since pre-upgrade history cannot tell a released hand-out from an untouched link. It must
  run with no old-version API or worker still writing (the standard full-path deploy
  replaces them first); rows an old process writes after the backfill are not covered.
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
contact's live subscription ignores it. Every replacement of a lapsed link (clone or re-mint)
keeps it. An `Idempotency-Key` replay with a different `startsAt` is **409**. A retry under
an existing `Idempotency-Key` is replayed before any validation, so an identical retry after
`startsAt` / `payableUntil` have passed still returns the same session.

`payableUntil` (optional, ISO-8601 instant): makes the checkout a **bounded offer** that
closes at that instant. `now < payableUntil ≤ now + 62 days`, otherwise **422**
(`payableUntil must be in the future`, `payableUntil must be at most 62 days ahead`). The
session's `expiresAt` is `payableUntil` instead of the usual TTL, and a bounded session is
**never** re-issued, cloned or re-minted: from `payableUntil` on — or once it lapses —
`POST /api/checkout-sessions/:id/pay` answers **410** `{"error":"this checkout is closed","code":"checkout_closed"}`
and writes nothing. While it is live, a Pending bounded session can be paid again (same
order reference). The WayForPay order timeout is capped so the provider order never
outlives `payableUntil` (at least 1 s). WayForPay does not sign `orderTimeout`, so a payer can
extend it in the browser: the deadline is enforced by billing at `/pay` and by the default
provider timeout, and is **not cryptographically binding at the provider**. A determined
payer can still pay late, so callers must handle a settlement after `payableUntil`. The public read returns `payableUntil` and
`startsAt`; the page shows a closed state once `payableUntil` has passed and, while
`startsAt` is ahead, the line "Your paid period starts {date}".

`lockMethod` (optional, default `false`): locks the payer to `method`, which is then
required (400 without it). The page hides the method picker (`methodLocked: true` on the
public read) and `/pay` with another method is **400** `method_locked`, exactly like a
`/prolong` link. A lapsed unbounded link cloned on re-issue stays locked; a re-mint at a
live subscription's terms keeps the lock too, and when that subscription pays by another
method the replacement is refused (**409**) rather than unlocked.

`firstCharge` (optional, `now` default | `card_check`): a **card check** verifies the card
and charges nothing now; the first plan-price charge is the ordinary scheduled one at
`startsAt`. It requires `recurring`, `startsAt`, `method: 0` and `lockMethod: true`, and
forbids `promo`, `options` and `renewal` (400). Admitted only while
`W4P_CARD_CHECK_ENABLED=true` — otherwise **422** `{"code":"card_check_disabled"}`; the env
gates admission only, an issued session keeps its mode. `firstCharge` is part of the
Idempotency-Key identity (a reuse with another mode is 409). `/pay` on a card-check session
always hands out the Card Verify form; a lapsed card-check link is never re-issued (409),
the caller opens a new attempt. The callback is settled by the card-check dispatch
only (docs/07 `subscription_card_checked` / `card_check_failed` / `card_check_anomaly`).
The public read carries `firstCharge` and `closedReason` (status 4 = Closed).

Response: session ID, payment link URL, expiry, and `firstCharge` (the stored mode).

### `POST /api/checkout-sessions/:id/close`

Auth: service token. Closes a **card-check** session that is still Created/Pending
(`closedReason: "superseded"`): 200 `{"status":"closed","closedReason":…}`, 200 again when
already Closed, 409 once Completed (the verify activated), 422 for a session that is not a
card check, 404 when unknown.

### `POST /api/payment/prolong`

Auth: service token. Mints a hosted pay link that extends the contact's live (Active or
PastDue) subscription. The link offers the cycle options configured by
`MANUAL_RENEWAL_CYCLE_OPTIONS` (1 / 3 / 6 months in production), paid as n × amount
under ref `chk_<id>_c<n>`. The method stays locked to the subscription's, as before.

### `POST /api/payment/apply-offer`

Auth: service token (no BFF secret). Idempotency-Key required (422 without one). Body
`{"buyerId":"<buyer uuid>","externalUserId":"<contact>"}` (the CRM calls it for the bot;
a `buyerId` that is not a UUID is 422).
Applies the paid, unrefunded payments bought under `buyerId` whose `metadata.campaign`
is `bf2026`, in one transaction:

- each must be a recurring subscription, else 409 `not_recurring`;
- `metadata.extend_days`: whole days, 1..400, a number or a digit string, else 422;
- the contact holds an **Active** recurring payment (a member): it is pushed out by the
  days (the defer write: both dates, audit, `payment_deferred` with `reason: campaign`, no
  30-day cap), and
  the purchase's subscription is cancelled terminally — `result: "extended"`;
- otherwise the purchase's subscription is the contact's, as it is (Active, its card
  token, its renewal terms) — `result: "created"`. A **PastDue** contact payment is
  cancelled terminally first, so it stops dunning;
- the purchase moves to the contact (`external_user_id_changed`, `source: campaign`).

200 `{"result","paymentId","periodEnd","nextPaymentDate","nextPaymentDate_formatted"}`
(the contact's live subscription; `_formatted` is DD.MM.YYYY in Kyiv). Each payment is
applied once whatever the key (`payments."campaignApplied"`): a repeat for the same
contact answers the first result again, for another contact is 409 `conflict`;
nothing under `buyerId` is 404. Events for a UUID-shaped `externalUserId` (a site buyer
not yet a SendPulse contact) are not delivered to SendPulse.

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
- `POST /operator/payment/:id/defer` — grant N≤30 free days; extends the paid period (docs/23). Answers `{status, newPeriodEnd, revision}`. A card-check payment whose first charge is due and has taken no money is refused, under the payment lock, with 422 `charge_in_flight` (the scheduler may be charging it); every other payment defers as before.
- `POST /api/payment/:id/defer` with `{"reason":"handover","deferTo":<ISO>}` and an Idempotency-Key — the **handover defer**, on the shared service token (no BFF secret). Only for a card-check payment that is Active and has taken no money; `deferTo` must be after the current next charge (otherwise `{"status":"unchanged"}`, nothing written), at most 30 d past it and at most 62 d from now. Refusals are 422 with `code` `invalid_request` / `not_active` (+ `paymentStatus`) / `not_card_check` / `charged` (the payment took money that credited a period: `payments."firstMoneyAt"`, set in the crediting transaction, the scheduler's approval included — a small card-change charge does not count) / `charge_in_flight` (the first charge is due, so the scheduler may be charging it now; retry later, the protection is not over) / `out_of_bounds`; a missing or invalid token is 401; `{days}` with the service token is 401. The checks run inside the idempotency ledger's fresh execution, so a committed request always replays its saved answer.
- `GET /operator/quarantine`
- `POST /operator/quarantine/:id/bind` — bind an unmatched charge to a Payment (or create one); the charge is then reprocessed normally
- `GET /operator/deliveries?status=failed` — undelivered outgoing events
