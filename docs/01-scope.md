# Scope

Payment gateway that owns money and the billing cycle for subscriptions (see [00-tz.md](./00-tz.md)).

## Goal

Build a service that tracks:

- who paid and who did not pay
- when the next charge is due
- retry state of the billing cycle
- integration events for downstream consumers

## In scope

1. Recurring payment lifecycle (gateway-owned billing cycle: card token, next charge date, retries)
2. Checkout session creation and minimal checkout page (card / crypto method choice, no paid_till shown)
3. First payment flow with card tokenization
4. Recurring charge by stored token on schedule
5. Retry after failed charge on days 0/1/3/5/7, ending in final `renewal_failed`
6. Provider callback processing (idempotent, raw-logged)
7. Incoming payment event pipeline, uniform for any source
8. WayForPay migration poller with freshness and migration-tail metrics
9. Quarantine for unmatched incoming payments with operator binding
10. Domain events and sink delivery for SendPulse integration (≤ 60 seconds)
11. Minimal support/operator read API
12. WayForPay first provider adapter; Whitepay (crypto) adapter boundary

## Out of scope

1. Identity resolution — the gateway carries an opaque `external_user_id` only
2. Access lifecycle (paid_till, grace, suspension) — the external system decides from money events
3. Tariff catalog (amount and period are supplied at checkout-session creation)
4. Showing paid_till on the checkout page
5. Full SendPulse replacement, CRM, bot, analytics
6. Raw card storage
7. Accounting and tax reporting
8. Production deployment automation

Refunds are an open question (see [04-open-questions.md](./04-open-questions.md)), to be resolved before implementation.

## Main architecture rule

- Payment state and the billing cycle (subscription schedule, retries, tokens) belong to this service.
- Access state (paid_till, access status) belongs to the external system; the gateway reports money facts via events.
- SendPulse may remain a communication channel, but it must **not** be the source of truth for billing.
