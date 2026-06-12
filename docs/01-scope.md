# Scope

Minimal recurring payment processing service for subscriptions.

## Goal

Build a service that tracks:

- who paid and who did not pay
- when the next payment is due
- retry and suspension state
- integration events for downstream consumers

## In scope

1. User import and external user creation API
2. Subscription lifecycle
3. Payment link generation
4. First payment flow
5. Monthly recurring payment flow
6. Retry after failed payment
7. Suspension after repeated failure
8. Quarantine after expiration period
9. Provider callback processing
10. Domain events for future SendPulse integration
11. Minimal support read API
12. WayForPay first provider adapter
13. Whitepay future provider adapter boundary

## Out of scope

1. Full SendPulse replacement
2. Full Telegram bot implementation
3. Full admin panel
4. Accounting and tax reporting
5. Refund management
6. Raw card storage
7. Production deployment automation

## Main architecture rule

- Payment state and subscription state belong to this service.
- SendPulse may remain a communication channel, but it must **not** be the source of truth for billing.
