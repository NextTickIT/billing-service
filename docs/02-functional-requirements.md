# Functional Requirements

## Summary

- FR-001 User creation
- FR-002 Subscription creation
- FR-003 Payment link generation
- FR-004 First payment
- FR-005 Recurring billing
- FR-006 Duplicate charge protection
- FR-007 Failed payment retry
- FR-008 Suspension
- FR-009 Quarantine
- FR-010 Recovery
- FR-011 Provider callbacks
- FR-012 Event outbox

---

## FR-001 User creation

The service must create or reuse a user by internal or external identifiers.

## FR-002 Subscription creation

The service must create a subscription for a user.

Initial status: `pending_payment`.

## FR-003 Payment link generation

The service must generate a payment link for a subscription.

Each payment link must be connected to one payment intent.

## FR-004 First payment

After successful first payment, the service must:

- activate the subscription
- store the paid period
- store the provider payment ID
- emit domain events

## FR-005 Recurring billing

The scheduler must find subscriptions due for monthly billing and create payment attempts.

## FR-006 Duplicate charge protection

The service must not create two successful internal charges for the same subscription and billing period.

## FR-007 Failed payment retry

After the first failed recurring payment, the service must:

- keep access active
- move subscription to `past_due`
- schedule retry after 24 hours

## FR-008 Suspension

After the second failed payment attempt, the service must:

- move subscription to `suspended`
- emit access removal event

## FR-009 Quarantine

If the subscription is not restored within 7 days after suspension, the service must move it to `quarantine`.

## FR-010 Recovery

The service must support creating a recovery payment link.

After successful recovery payment, the service must restore the subscription if the business rule allows it.

## FR-011 Provider callbacks

- Provider callbacks must be verified where the provider API supports verification.
- Callback processing must be idempotent.

## FR-012 Event outbox

All domain events must be stored durably before delivery to integrations.
