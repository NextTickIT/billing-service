# Domain Model

## Entities

- `User` customer identified internally or by external ID (see open questions)
- `Subscription` recurring billing agreement and lifecycle state
- `BillingPeriod` paid or due period for a subscription
- `PaymentIntent` internal intent to collect payment (or memory collection)
- `PaymentAttempt` single charge attempt against an intent
- `PaymentLink` user-facing URL for completing payment
- `PaymentProvider` adapter boundary for WayForPay, Whitepay, etc.
- `RecurringToken` provider token for recurring charges
- `DomainEvent` immutable business event for integrations
- `EventDelivery` outbox delivery record for a domain event
- `Integration` downstream consumer such as SendPulse (or memory collection)
- `AuditLog` support and compliance audit trail

## Subscription statuses

- `pending_payment` created, awaiting first payment
- `active` paid and in good standing
- `past_due` first recurring failure; retry scheduled
- `suspended` second failure; access removal requested
- `quarantine` suspended beyond grace period
- `cancelled` ended by user or support
- `expired` natural end of subscription term

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

## Recurring token statuses

- `missing` no token on file
- `active` token valid for recurring charges
- `cancel_requested` cancellation sent to provider
- `cancelled` token cancelled
- `expired` token expired at provider
- `invalid` token rejected or unusable
