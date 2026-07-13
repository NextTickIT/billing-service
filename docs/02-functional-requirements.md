# Functional Requirements

## Summary

- FR-001 Checkout session creation
- FR-002 Checkout page
- FR-003 First payment processing
- FR-004 Recurring billing
- FR-005 Failed payment retry schedule
- FR-006 Duplicate charge protection
- FR-007 Incoming payment event pipeline
- FR-008 WayForPay migration poller
- FR-009 Unmatched payment quarantine
- FR-010 Provider callbacks
- FR-011 Event outbox and sink delivery
- FR-012 Subscription cancellation

---

## FR-001 Checkout session creation

The external system must be able to create a checkout session with `external_user_id`, amount, currency, and period, and receive a payment link.

The gateway treats `external_user_id` as an opaque value and returns it in all events without transformation. No identity matching by email or phone.

## FR-002 Checkout page

The checkout page must be minimal: payment method choice (card / crypto) and a pay button.

The page must not display paid_till or any access data.

Card payments must be tokenized; the token reference is stored by the gateway.

## FR-003 First payment processing

On a successful payment for a checkout session, the service must:

- record the payment
- store the recurring token reference (for card payments)
- create the gateway subscription, or extend an existing one; next charge date = payment date + period
- emit `subscription_created` (for new subscriptions) and `payment_succeeded`

## FR-004 Recurring billing

The scheduler must find subscriptions due for charging and charge the stored token through the provider connector.

On success: shift the next charge date by the subscription period and emit `payment_succeeded`.

## FR-005 Failed payment retry schedule

After a failed recurring charge, the service must retry on a fixed schedule: days 0, 1, 3, 5, 7 from the first failure.

- Each failed attempt emits `charge_retry_failed` (attempt number, next retry date, provider reason).
- The day-7 failure is final: emit `renewal_failed`. After that the gateway takes no further action on the subscription; the external system decides the fate of access.

## FR-006 Duplicate charge protection

The service must not create two successful internal charges for the same subscription and billing period.

## FR-007 Incoming payment event pipeline

All incoming payment events — provider webhooks, migration poller findings, and any future source — must pass through the same path:

raw append-only log → idempotency check → matching to a subscription or checkout session → outgoing events.

Repeated delivery of the same event (by the source idempotency key) must not create a second payment or repeated outgoing events.

## FR-008 WayForPay migration poller

A long-lived poller must read the WayForPay operation journal every few minutes and convert found payments into standard incoming payment events (FR-007).

The poller must expose freshness and migration-tail metrics (count of not-yet-migrated recurrents) to the operator.

## FR-009 Unmatched payment quarantine

If an incoming event matches no subscription and no checkout session:

- the raw event is stored in any case
- the event enters the quarantine queue and the operator is alerted
- the operator can manually bind the event to a subscription (or create one); after binding, the event is reprocessed normally, including outgoing events
- every manual action is audited: who, when, what
- target metric: zero forever-unbound payments

## FR-010 Provider callbacks

- Provider callbacks must be verified where the provider API supports verification.
- Callback processing must be idempotent.
- Parsing must be tolerant: an unexpected field must not lose the event — raw is always stored, problem events go to quarantine, never dropped.

## FR-011 Event outbox and sink delivery

All domain events must be stored durably before delivery to sinks.

- Each event is delivered to each connected sink at least once; sinks must be idempotent.
- Failed deliveries are retried; undelivered events are visible to the operator.
- Delivery to SendPulse must happen within 60 seconds of payment fixation.

## FR-012 Subscription cancellation

The service must support cancelling a subscription by an operator or by a provider event, emitting `subscription_cancelled`.

The user-initiated cancellation channel is an open question (see 04).
