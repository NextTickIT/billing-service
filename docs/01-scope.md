# Scope

Minimal recurring payment processing service for subscriptions.

## Goal

Build a service that tracks:

- who paid and who did not pay
- when the next payment is due
- retry and suspension state
- integration events for downstream consumers

## In scope

1. Recurent payment lifecycle
2. Payment link generation
3. First payment flow
4. Monthly recurring payment flow
5. Retry after failed payment
6. Provider callback processing
7. Domain events for SendPulse integration
8. Minimal support read API
9. WayForPay first provider adapter
10. Whitepay future provider adapter boundary

## Out of scope

1. Full SendPulse replacement
2. Full Telegram bot implementation
3. Full admin panel
4. Accounting and tax reporting
5. Refund management
6. Raw card storage
7. Production deployment automation
8. Suspension lifecycle, after repeated failure

## Main architecture rule

- Payment state and subscription state belong to this service.
- SendPulse may remain a communication channel, but it must **not** be the source of truth for billing.
