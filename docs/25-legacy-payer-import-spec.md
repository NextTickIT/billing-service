# Legacy Payer Import

Import historical payers so we hold their identity and payment history in one
place, while never charging anyone who is already charged outside our gateway.

## Motivation

This service owns the recurrent payment lifecycle for **our** WayForPay checkout.
Historically, people were charged through **SendPulse's** WayForPay integration
(and other external channels). Those recurring charges run outside this service.
We are migrating away from SendPulse, so we must:

- see every historical payer here, with full payment history
- never double-charge a payer whose recurring charge lives outside our gateway
- avoid echoing our domain events back to the SendPulse sink they came from

## Core distinction

Every imported recurrent payment agreement gets a `billingOwnership`:

- `managed` — our WayForPay checkout. We own the recurring token on our merchant.
  Chargeable, retryable, suspendable, cancellable by us.
- `external` — SendPulse's WayForPay integration (or another legacy channel).
  Charged outside our gateway. Read-only here: tracked and visible, never billed.

Ownership follows the recurring agreement, not the person. A person must have at
most one **active** recurrent agreement at a time — here or in legacy (see
Single active agreement).

## Source classification

Each imported payment carries an origin `source`:

- `wayforpay` — obtained from our WayForPay merchant account → `managed`
- `legacy_sendpulse` — seen only in SendPulse's CRM / SP's WFP integration → `external`
- other legacy channels (`whitepay`, `paypal`, `telegram_stars`, `crypto_manual`)
  → `external`

Primary classifier: **WayForPay merchant identity** (confirmed distinct). Our
checkout and SendPulse's WFP integration use **different** WayForPay merchant
accounts, so merchant identity separates them cleanly: transactions on our
merchant are `managed`; payments seen only through SendPulse's merchant (surfaced
via the SendPulse CRM) are `external`. Money truth is each merchant's WayForPay
`TRANSACTION_LIST`; the SendPulse CRM is used for legacy/non-WFP channels and
person linkage.

## Collection mode

A `managed` agreement collects differently depending on the recurring token:

- token present → `auto`: recurring auto-charge on the due date.
- token missing → `manual`: collect via a manual payment method (payment link,
  crypto-style manual flow). We never auto-charge without a token.

`external` agreements are not collected here at all.

## Import mechanism

Standalone re-integration. This service ships its **own** SendPulse client and
WayForPay adapter (code and patterns may be borrowed from the analytics project,
but no shared DB and no shared infrastructure).

A worker import command:

1. Pulls contacts + payments from SendPulse CRM and/or our WFP merchant.
2. Resolves identity by priority: Telegram > Email > Phone.
3. Classifies each agreement `managed` vs `external` by origin/merchant.
4. Upserts `User`, the recurrent payment agreement, and read-only payment history.
5. Records money in minor units (bigint), timestamps in UTC.
6. Is idempotent: re-runnable, upsert by external id + content hash, no duplicates.

## Capability matrix

External (legacy) agreements:

| Capability                         | managed | external |
| ---------------------------------- | ------- | -------- |
| Visible in support read API        | yes     | yes      |
| Read-only payment history          | yes     | yes      |
| Payment link generation            | yes     | no       |
| Payment intent / attempt creation  | yes     | no       |
| Picked by recurring scheduler      | yes     | no       |
| Charge / retry / suspend by us     | yes     | no       |
| Cancel by us                       | yes     | no       |
| Events delivered to SendPulse sink | yes     | no       |

`external` agreements are excluded from the scheduler, never receive a payment
link or intent, and the cancel action is unavailable for them. For `managed`
agreements, payment link / intent creation serves the `manual` collection mode.

## Single active agreement

A person must hold at most one **active** recurrent agreement at any time, counting
both `managed` and `external`. This invariant spans the legacy boundary: an active
legacy agreement blocks creating a second active managed one, except during a
controlled takeover (below).

## Legacy takeover and overlap

When a person's `external` (legacy) agreement errors or lapses, we may create a
`managed` agreement here to take over billing. Because legacy sync is not
instantaneous, there is a brief window where the person has an active `managed`
agreement here **and** a still-active `external` agreement in legacy.

- This overlap is detected on import/reconcile and on managed activation.
- It fires a **support-notification event** (`subscription.legacy_overlap_detected`)
  so an admin can reconcile — typically by stopping the legacy charge, which we
  cannot cancel ourselves (external cancel is unavailable).
- The overlap event is delivered to the support/admin sink, **never** to SendPulse.
- Once the legacy agreement is confirmed inactive, the invariant is restored.

## Event handling for legacy source

Domain events for `external` agreements may still be written to the outbox for our
own audit and read API, but **delivery to the SendPulse integration sink is
suppressed** — we do not echo events back to the system we imported them from.
Delivery suppression is per-integration and keyed off the agreement `source`.

## Domain model impact

- `User` — add `source` (origin). Keep external identifiers (`sendpulse:...`).
- `Subscription` (recurrent payment agreement) — add `billingOwnership`
  (`managed` | `external`), `collectionMode` (`auto` | `manual`, managed only),
  `source`, `importedAt`, `externalRef`.
- Legacy payment history — read-only records (`amountMinor`, `currency`,
  `provider`, `merchant`, `status`, `occurredAt`, `externalId`), separate from
  internally created `PaymentIntent` / `PaymentAttempt`.
- `RecurringToken` — `external` agreements have no usable token on our merchant.
- `EventDelivery` — support per-integration suppression for `external` source.
- `Integration` — add a support/admin sink to receive
  `subscription.legacy_overlap_detected`; SendPulse sink never receives it.

## Functional requirements

- FR-013 Import all historical payers with identity and payment history.
- FR-014 Classify each agreement `managed` vs `external` by payment origin/merchant.
- FR-015 Guardrails: `external` agreements never get a link, intent, attempt,
  scheduler pick, charge, or cancel.
- FR-016 Store legacy payment history as read-only, in minor units, UTC.
- FR-017 Suppress domain-event delivery to the SendPulse sink for `external` source.
- FR-018 Import is idempotent and re-runnable.
- FR-019 Enforce at most one active recurrent agreement per person across
  `managed` and `external`.
- FR-020 Legacy takeover: on legacy failure/lapse, allow creating a `managed`
  agreement for the person.
- FR-021 Detect `managed`↔`external` overlap and fire
  `subscription.legacy_overlap_detected` to the support sink (not to SendPulse).
- FR-022 A `managed` agreement with no recurring token collects via a manual
  payment method (payment link / crypto-style), never auto-charge.

## Open questions

- Are existing SendPulse/WFP recurring tokens migratable to `managed`? (see 04)
- Which non-WFP legacy channels must be imported now vs later?
- Can an `external` agreement later convert to `managed` via re-authorization?
- Cancel unavailable: hide the action, or show it disabled with a reason?

## Out of scope

- Charging legacy payers or migrating their tokens.
- Two-way sync back to SendPulse.
- Analytics dashboards (that lives in the analytics project).
