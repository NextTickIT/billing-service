# Legacy Payer Import — Implementation Plan

Staged plan for the spec in [25-legacy-payer-import-spec.md](./25-legacy-payer-import-spec.md).
Delivered as vertical slices (see [08-vertical.md](./08-vertical.md)) on this
service's lean stack: Node.js 20, ESM, `node --test`, no heavy framework.
Analytics patterns (identity priority, content-hash idempotency, minor units) are
reused as approach only — its Effect/Drizzle stack and its DB are not.

## Principles

- Each milestone is a complete slice (api → application → domain → infrastructure)
  with an observable result.
- Money in minor units (integer), timestamps UTC, derive deterministic.
- Import idempotent and re-runnable.
- Legacy source never becomes the source of truth for billing.

## Milestones

### M1 — Domain vocabulary and storage

- Add `User.source`; `Subscription.billingOwnership` (`managed`|`external`),
  `collectionMode` (`auto`|`manual`), `source`, `importedAt`, `externalRef`.
- Read-only legacy payment history store: `amountMinor`, `currency`, `provider`,
  `merchant`, `status`, `occurredAt`, `externalId`, `source`.
- Persistence: PostgreSQL tables + migrations. Idempotency key on
  (`source`, `externalId`, `contentHash`); constraint reserving one active
  agreement per person.
- Observable: schema applied; query returns imported records.
- FR-013, FR-016.

### M2 — Legacy source client (standalone)

- Own SendPulse read client + WayForPay merchant read adapter (own copy of the
  approach, not shared code/infra).
- Data sources (pull-based, no request logs): our WayForPay merchant API
  `TRANSACTION_LIST` (date-windowed, ≤~31-day windows) for card-payment truth,
  `CHECK_STATUS` for refunds/late mutations, `regularApi STATUS` for recurring
  state; SendPulse CRM `GET /crm/v1/payments/all` for legacy/non-WFP channels and
  person linkage.
- Rate limiter / queue for WayForPay and SendPulse calls (NFR capacity).
- Config: `SENDPULSE_API_TOKEN`, WFP merchant credentials, secrets outside source.
- Observable: fetch contacts + payments and dump raw responses.

### M3 — Import worker command

- Worker command `import:legacy` (separate process, restart-safe).
- Normalize payments to minor units, UTC; parse via explicit schema, not casts.
- Identity resolution by priority Telegram > Email > Phone; composite user key.
- Idempotent upsert of `User` + agreement + payment history.
- Observable: run import → users, agreements, and history appear.
- FR-013, FR-016, FR-018.

### M4 — Classification: managed vs external

- Classifier by WayForPay merchant identity (distinct merchant accounts,
  confirmed): our merchant → `managed`; SendPulse's merchant / other legacy
  channels → `external`.
- Set `billingOwnership` and `source` per agreement.
- Set `collectionMode` for `managed`: `auto` if a usable recurring token exists,
  else `manual`.
- Observable: imported agreements tagged correctly; report of counts per class.
- FR-014, FR-022 (mode assignment).

### M5 — External guardrails (non-billable)

- Scheduler excludes `external` agreements.
- Application + domain reject payment link, intent, attempt, charge, and cancel
  for `external`; persistence constraints back the rules.
- Observable: any attempt to bill/cancel an external agreement is rejected;
  support API still shows it read-only.
- FR-015.

### M6 — Single active agreement and overlap

- Enforce at most one active agreement per person across `managed` + `external`.
- Detect overlap on import/reconcile and on managed activation.
- Fire `subscription.legacy_overlap_detected` for support reconciliation.
- Observable: activating a managed agreement while legacy is active raises the
  event and is surfaced to support.
- FR-019, FR-020, FR-021.

### M7 — Event delivery suppression

- Per-integration delivery filter keyed off agreement `source`.
- `external` events are written to the outbox but not delivered to the SendPulse
  sink. `subscription.legacy_overlap_detected` is delivered to the support sink
  only.
- Observable: external events present in outbox, zero SendPulse deliveries.
- FR-017, FR-021.

### M8 — Manual collection for managed-without-token

- Due `managed` agreement with `collectionMode = manual` generates a manual
  payment method (payment link / crypto-style flow) instead of an auto-charge.
- Observable: a due managed-no-token agreement yields a manual link, not a charge.
- FR-022.

### M9 — Support read API

- Extend `GET /api/users/:id/payments` to return legacy history plus
  `billingOwnership`, `collectionMode`, and `source`.
- Observable: support sees unified managed + legacy history for a person.

## Testing

- `node --test` units: classifier, identity resolution, idempotent upsert,
  single-active invariant, external guardrails, delivery suppression.
- Deterministic inputs; no `Date.now` / random in pure logic (inject clock).
- Fixtures: anonymized legacy payment + contact samples committed to the repo.

## Sequencing

- Core path: M1 → M2 → M3 → M4.
- Rules: M5, M6, M7, M8 (depend on M4; independent of each other).
- Read surface: M9 (depends on M1, M4).

## Risks and dependencies

- Merchant-identity classifier is confirmed viable: our checkout and SendPulse's
  WFP integration use distinct WayForPay merchant accounts.
- Recurring-token migratability decides how many `managed` agreements are `auto`
  vs `manual` (open question in 04).
- Legacy channel scope (which non-WFP channels to import now) affects M2/M3.
- Sync lag defines the overlap window handled by M6.
