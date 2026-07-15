# Domain Model

There is no `User` entity. The gateway carries an opaque `external_user_id` (supplied by the calling system) on checkout sessions, payments, and all outgoing events, without transformation (00 §2).

## Entities

- `CheckoutSession` payment intent of the external system: `external_user_id`, amount, currency, period, chosen method
- `Payment` gateway billing agreement: `external_user_id`, amount, currency, period, `currentPeriodStart`, `currentPeriodEnd` (the anchor from which the next payment is calculated — drift-free), `nextPaymentDate` (derived from the anchor; replaces any "next charge date" concept), retry state, token reference. `paid_till` is external (owned by SendPulse), not a field here.
- `Charge` raw incoming event: source, idempotency key, amount, status, raw payload, match result (stored in the `charges` table; the fixation record written on success lives in `charge_fixations`)
- `QuarantineRecord` unmatched incoming event awaiting operator decision, with audit trail
- `PaymentProvider` adapter boundary for WayForPay, Whitepay, etc.
- `RecurringToken` provider token reference for recurring charges
- `DomainEvent` immutable business event for integrations
- `Sink` downstream consumer such as SendPulse
- `EventDelivery` outbox delivery record for a domain event per sink
- `AuditLog` support and compliance audit trail

## Payment statuses

- `active` paid and in good standing; next charge scheduled
- `past_due` charge failed; inside the retry window (days 0–7)
- `renewal_failed` final retry failed; gateway takes no further action (a new checkout payment creates/extends a Payment record)
- `cancelled` ended by operator or provider event

## Checkout session statuses

- `created` session recorded, link issued
- `pending` payment started at provider
- `completed` payment succeeded
- `expired` session timed out

## Quarantine record statuses

- `open` awaiting operator decision
- `resolved` bound to a Payment (or a Payment was created) and reprocessed normally

## Recurring token statuses

- `missing` no token on file
- `active` token valid for recurring charges
- `cancel_requested` cancellation sent to provider
- `cancelled` token cancelled
- `expired` token expired at provider
- `invalid` token rejected or unusable

## Date model

`currentPeriodStart` and `currentPeriodEnd` are set when a payment is fixed. `nextPaymentDate` is always derived from `currentPeriodEnd` (the anchor) — never accumulated from the previous `nextPaymentDate` — so drift is structurally impossible. Dates clamp to the last valid day of the target month (e.g. Jan 31 → Feb 28/29).
