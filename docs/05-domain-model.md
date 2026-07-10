# Domain Model

There is no `User` entity. The gateway carries an opaque `external_user_id` (supplied by the calling system) on checkout sessions, subscriptions, and all outgoing events, without transformation (00 §2).

## Entities

- `CheckoutSession` payment intent of the external system: `external_user_id`, amount, currency, period, chosen method
- `Subscription` gateway billing agreement: `external_user_id`, amount, currency, period, next charge date, retry state, token reference
- `BillingPeriod` paid or due period for a subscription
- `PaymentIntent` internal intent to collect payment
- `PaymentAttempt` single charge attempt against an intent
- `IncomingPaymentEvent` raw incoming event: source, idempotency key, amount, status, raw payload, match result
- `QuarantineRecord` unmatched incoming event awaiting operator decision, with audit trail
- `PaymentProvider` adapter boundary for WayForPay, Whitepay, etc.
- `RecurringToken` provider token reference for recurring charges
- `DomainEvent` immutable business event for integrations
- `Sink` downstream consumer such as SendPulse
- `EventDelivery` outbox delivery record for a domain event per sink
- `AuditLog` support and compliance audit trail

## Subscription statuses

- `active` paid and in good standing; next charge scheduled
- `past_due` charge failed; inside the retry window (days 0–7)
- `renewal_failed` final retry failed; gateway takes no further action (a new checkout payment creates/extends a subscription)
- `cancelled` ended by operator or provider event

## Checkout session statuses

- `created` session recorded, link issued
- `pending` payment started at provider
- `completed` payment succeeded
- `expired` session timed out

## Payment intent statuses

- `created` intent recorded, not yet sent to provider
- `pending` awaiting provider result
- `succeeded` payment completed
- `failed` payment failed
- `cancelled` intent cancelled before completion
- `expired` link or intent timed out
- `unknown` provider state not yet reconciled

## Payment attempt statuses

- `created` attempt recorded
- `pending` in flight with provider
- `succeeded` charge succeeded
- `failed` charge failed
- `cancelled` attempt cancelled
- `expired` attempt no longer valid
- `unknown` awaiting callback or reconciliation

## Quarantine record statuses

- `open` awaiting operator decision
- `resolved` bound to a subscription (or a subscription was created) and reprocessed normally

## Recurring token statuses

- `missing` no token on file
- `active` token valid for recurring charges
- `cancel_requested` cancellation sent to provider
- `cancelled` token cancelled
- `expired` token expired at provider
- `invalid` token rejected or unusable
