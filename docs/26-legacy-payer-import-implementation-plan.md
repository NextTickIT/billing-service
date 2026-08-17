# Legacy Payment Import — Implementation Plan (RALPLAN-DR)

**Status:** `pending approval`
**Mode:** reconciled against the merged codebase (docs 05/06/07/16/19–24) and the
real schema/modules, not the pre-WFP stubs.
**Source of truth:** [25-legacy-payer-import-spec.md](25-legacy-payer-import-spec.md).

---

## 1. Requirements summary

Import SendPulse-charged users as read-only `external` **Payments** + **Charge**
history, never billable here, migratable to `managed` only through checkout. Import
is **event-silent** (emits nothing to any sink) and runs as a full backfill then
incremental syncs, reusing the analytics source and mapping (standalone — rules
reused, not code/DB). Grounded facts that shape the plan:

- Single billable merchant; no merchant field on payments/charges
  (`packages/backend/src/config.ts`) → the `managed`/`external` split is by data
  **source**, and the legacy source is **SendPulse CRM** (it carries `contact_id`).
- One-active-per-user is already a DB constraint
  (`payments_one_active_per_user`, migration `0009`/`0006`).
- Token-less Payments are already scheduler-excluded (`payment/data-access.ts`
  `findDue` → `recurringTokenRef IS NOT NULL`).
- Import emits no events, so no sink suppression is needed; managed events
  (including the migration event) deliver to the SendPulse sink normally.
- Nouns are `Payment` / `Charge` / `ChargeFixation` / `externalUserId`
  (`packages/shared/src/schemas/{payment,charge}.ts`).

---

## 2. Principles

- **P1** Reuse the existing seams; add the smallest new surface. The incoming
  pipeline, one-active constraint, scheduler token-filter, and checkout applier
  already carry most of the behaviour.
- **P2** `external` is an **origin marker on Payment**, orthogonal to `PaymentStatus`
  (never a new status).
- **P3** Import is a pure normalise-then-upsert; deterministic; no `Date.now`/random
  in mapping (inject a clock), per [16](16-conventions.md).
- **P4** SendPulse-source code lives in its own module (§12), mirroring `wayforpay`.
- **P5** Never write "subscription" in new prose or schema names (Payment / Charge /
  recurrent payment).

---

## 3. Decision drivers

- **D1** No double billing — hard safety property.
- **D2** Minimal schema churn on a live, implemented codebase.
- **D3** Idempotent, re-runnable import (migration tail re-reads).
- **D4** SendPulse must not receive echoes of its own history.

---

## 4. Decisions

### Decision 1 — Legacy data source

- **Option 1A (CHOSEN)** — read **SendPulse CRM payments** (`/crm/v1/payments/all`);
  they carry `contactId` → `externalUserId`, plus amount/currency/method/order/status.
- Option 1B — poll a second WayForPay merchant journal (`TRANSACTION_LIST`). Rejected:
  W4P rows lack the SendPulse `contact_id`, so charges can't be attributed to
  `externalUserId`; also needs multi-merchant config the code doesn't have.

### Decision 2 — How `external` is modelled

- **Option 2A (CHOSEN)** — `Payment.origin: PaymentOrigin { Managed=0, External=1 }`
  + a new `charges.source = sendpulse_legacy`. Read-only, token-less.
- Option 2B — a separate `external_payments` table. Rejected: duplicates the read
  API, the one-active constraint, and the migration/supersede path.

### Decision 3 — Events to the SendPulse sink

- **Option 3A (CHOSEN)** — **import emits no events**; external Payments are never
  billed/cancelled, so they generate none. Managed events (including the migration in
  Decision 4) deliver to SendPulse normally. No suppression mechanism is built.
- Option 3B — publish external events to the outbox and add an origin-suppression
  guard in the connector. Rejected: unnecessary once import is event-silent.

### Decision 4 — Migration / overlap

- **Option 4A (CHOSEN)** — on a successful checkout for a user holding an active
  external Payment, supersede it (`Cancelled`, reason `migrated`) and create the
  managed Payment in one transaction; the ordinary managed event (`payment_created` /
  `initial_payment_succeeded`) delivered to the SendPulse sink is the only overlap
  signal.
- Option 4B — block the checkout and force operator action first. Rejected: worse UX;
  the user paying us is the signal to take over.

---

## 5. Pre-mortem

- **Scenario 1** — re-import double-counts history. *Mitigation:* dedup `Charge` by
  `idemKey = sp:{paymentId}`; `ON CONFLICT DO NOTHING` (mirrors `charges_idem_key`).
- **Scenario 2** — an external Payment gets charged. *Mitigation:* `recurringTokenRef`
  is `NULL` by construction (already filtered by `findDue`) **and** an explicit
  scheduler assertion test (AC-4).
- **Scenario 3** — supersede races the SendPulse-side charge → brief double bill.
  *Mitigation:* the migration event tells SendPulse to reconcile; the residual window
  is inherent (we cannot cancel SendPulse's merchant) and accepted.
- **Scenario 4** — import accidentally emits history events. *Mitigation:* the import
  path never calls `publish`; an e2e asserts zero domain events / sink deliveries from
  an import run.

---

## 6. Implementation phases

### Phase 0 — Schema & vocabulary (`shared` + migration)

- `packages/shared/src/schemas/payment.ts` — add `PaymentOrigin` enum + `origin`
  field on `Payment`/`CreatePayment`; derive DTOs via `Omit`/`extend` (§9).
- `packages/shared/src/schemas/charge.ts` — add `sendpulse_legacy` to the source
  vocabulary.
- New migration `0014_payment_origin.ts` — `ALTER TABLE payments ADD COLUMN origin
  smallint NOT NULL DEFAULT 0` (no backfill; existing rows are `Managed`), plus a
  `legacy_sync_state` table (`source text PK, watermark timestamptz`) for
  backfill-then-incremental.

### Phase 1 — SendPulse CRM read module

- New `packages/backend/src/modules/legacy/` (sibling to `wayforpay`, §12): a
  read-only SendPulse CRM client (`client.ts`, OAuth/Bearer, `/crm/v1/payments/all`),
  a `mapping.ts` (SendPulse payment → normalized `Charge` with
  `source=sendpulse_legacy`, `externalUserId=sendpulse:{contactId}`,
  `idemKey=sp:{paymentId}`), a `derive.ts` (infer external Payment `status`/`period`
  from the payment stream — SendPulse status codes + recency + cadence, default
  `P1M` — reusing analytics' rules), `config.ts` (`SENDPULSE_API_TOKEN`, rate limit),
  `contracts.ts`. Parse via `Schema`, not casts.

### Phase 2 — Import command + applier

- `modules/legacy/import.ts` — per `contactId`: upsert `external` Payment
  (`origin=External`, token `null`, `status`/`period` from `derive.ts`) via a new
  `PaymentRepo.upsertExternal`, then fix each mapped `Charge` as a `ChargeFixation`.
  Idempotent; **emits no domain events**.
- Full backfill on first run, then incremental by the `legacy_sync_state` watermark.
- Register a worker command in the worker boot (`packages/backend/src/worker-boot.ts`)
  and task registry (`infra/task-registry.ts`); gated by an env flag, default off.

### Phase 3 — External guardrails

- `modules/payment/routes.ts` + `cancel.ts` — `cancel`/`reactivate`/`defer` reject
  `origin=External` with a typed `409` (own `toHttp()`, §7).
- Add an explicit test that `findDue` excludes `origin=External` (already true via
  the null-token filter).

### Phase 4 — Migration / supersede

- `modules/payment/domain.ts` `createOrExtend` — when the current active Payment is
  `origin=External`, supersede it (`markCancelledLapsed`-style with reason
  `migrated`) and insert the managed Payment in the same transaction.
- The migration flows through the existing checkout applier, so the ordinary managed
  event (`payment_created` / `initial_payment_succeeded`) is emitted to the SendPulse
  sink as usual — no extra overlap channel.

### Phase 5 — Read API

- `modules/payment/routes.ts` — include `origin` in payment views; ensure
  `GET /operator/payment` and `GET /api/payment` surface it.

---

## 7. AC map

| AC   | Phase(s) |
| ---- | -------- |
| AC-1 | 0, 2     |
| AC-2 | 1, 2     |
| AC-3 | 1, 2     |
| AC-4 | 3        |
| AC-5 | 3        |
| AC-6 | 0, 4     |
| AC-7 | 4        |
| AC-8 | 2        |
| AC-9 | 1, 2     |

---

## 8. Test plan

- **Unit** (`*.test.ts`, hermetic): mapping (SendPulse payment → Charge, minor
  units, idemKey), status/period derivation, `PaymentOrigin` guardrail predicates,
  supersede decision in `createOrExtend`.
- **Integration/e2e** (`*.e2e.ts`, real Postgres): backfill then incremental import
  creates external Payment+fixations and is idempotent on re-run; an import run emits
  zero domain events; one-active constraint across managed+external; scheduler skips
  external; `cancel` on external → 409; checkout supersedes an active external and
  creates managed atomically, emitting the managed event.

---

## 9. Risks

- SendPulse CRM export authorization/fields want a live pass ([04](04-open-questions.md)).
- The SendPulse-status → `PaymentStatus` collapse and fallback `period` need tuning on
  real data.
- Backfill volume: the first full import may be large; chunk and rate-limit.

---

## 10. Verification / Definition of Done

- No phase is done until its ACs' tests pass. Hard gates: `npm run typecheck`,
  `npm run lint`, `npm test` green; e2e suite green for the import/supersede/sink
  scenarios. Import proven idempotent by a double-run e2e.

---

## 11. ADR

- **Decision.** Model legacy payers as read-only `external` Payments sourced from
  SendPulse CRM, non-billable and **event-silent on import**, migratable only via
  checkout.
- **Drivers.** D1 no double billing; D2 minimal churn; D3 idempotency; D4 no echoes.
- **Alternatives considered.** Second WFP merchant journal (1B); separate table (2B);
  an origin-suppression connector guard (3B); block-and-operator migration (4B).
- **Why chosen.** SendPulse CRM is the only source with the `contact_id` linkage; the
  origin marker reuses the existing constraint, scheduler filter, and checkout applier;
  import is event-silent, so no suppression is needed.
- **Consequences.** One new column, one new source value, a small `legacy_sync_state`
  table, one new read module; no sink/connector changes. A brief external↔managed
  overlap is inherent (we cannot cancel SendPulse's merchant); the migration event
  tells SendPulse to reconcile.
- **Follow-ups.** OQ-1..OQ-6 resolved in [25 §7](25-legacy-payer-import-spec.md);
  residual live-data tuning of status/period.

---

## 12. Open questions

~~OQ-1..OQ-6~~ resolved in [25 §7](25-legacy-payer-import-spec.md). Residual: the
exact SendPulse-status → `PaymentStatus` collapse and fallback `period` want a
live-data pass ([04](04-open-questions.md) §Data).
