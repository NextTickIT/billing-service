# Legacy Payment Import — Implementation Plan (RALPLAN-DR)

**Status:** `pending approval`
**Mode:** reconciled against the merged codebase (docs 05/06/07/16/19–24) and the
real schema/modules, not the pre-WFP stubs.
**Source of truth:** [25-legacy-payer-import-spec.md](25-legacy-payer-import-spec.md).

---

## 1. Requirements summary

Import SendPulse-charged users as read-only `external` **Payments** + **Charge**
history, never billable here, never echoed to the SendPulse sink, migratable to
`managed` only through checkout. Grounded facts that shape the plan:

- Single billable merchant; no merchant field on payments/charges
  (`packages/backend/src/config.ts`) → the `managed`/`external` split is by data
  **source**, and the legacy source is **SendPulse CRM** (it carries `contact_id`).
- One-active-per-user is already a DB constraint
  (`payments_one_active_per_user`, migration `0009`/`0006`).
- Token-less Payments are already scheduler-excluded (`payment/data-access.ts`
  `findDue` → `recurringTokenRef IS NOT NULL`).
- Sink filtering is by event **name** only, plus a null-`externalUserId` skip
  (`modules/sinks/sendpulse.ts`); there is no origin/source suppression yet.
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

### Decision 3 — SendPulse-sink suppression

- **Option 3A (CHOSEN)** — extend the SendPulse connector guard to no-op on
  `external`-origin events (belt-and-braces; import itself is event-silent for
  history). Same shape as the existing null-`externalUserId` skip.
- Option 3B — a per-sink event-routing (allowlist) table. Rejected as
  over-engineering for one rule (see OQ-6 — we may emit nothing sink-facing at all).

### Decision 4 — Migration / overlap

- **Option 4A (CHOSEN)** — on a successful checkout for a user holding an active
  external Payment, supersede it (`Cancelled`, reason `migrated`) and create the
  managed Payment in one transaction; raise an operator-only overlap notification.
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
  *Mitigation:* operator overlap notification + audit; documented as inherent to
  external cancel being impossible.
- **Scenario 4** — a legacy event leaks to SendPulse. *Mitigation:* origin guard in
  the connector + a delivery test asserting zero SendPulse calls for external events.

---

## 6. Implementation phases

### Phase 0 — Schema & vocabulary (`shared` + migration)

- `packages/shared/src/schemas/payment.ts` — add `PaymentOrigin` enum + `origin`
  field on `Payment`/`CreatePayment`; derive DTOs via `Omit`/`extend` (§9).
- `packages/shared/src/schemas/charge.ts` — add `sendpulse_legacy` to the source
  vocabulary.
- New migration `0014_payment_origin.ts` — `ALTER TABLE payments ADD COLUMN origin
  smallint NOT NULL DEFAULT 0`. No backfill needed (existing rows are `Managed`).

### Phase 1 — SendPulse CRM read module

- New `packages/backend/src/modules/legacy/` (sibling to `wayforpay`, §12): a
  read-only SendPulse CRM client (`client.ts`, OAuth/Bearer, `/crm/v1/payments/all`),
  a `mapping.ts` (SendPulse payment → normalized `Charge` with
  `source=sendpulse_legacy`, `externalUserId=sendpulse:{contactId}`,
  `idemKey=sp:{paymentId}`), `config.ts` (`SENDPULSE_API_TOKEN`, rate limit),
  `contracts.ts`. Parse via `Schema`, not casts.

### Phase 2 — Import command + applier

- `modules/legacy/import.ts` — per `contactId`: upsert `external` Payment
  (`origin=External`, token `null`) via a new `PaymentRepo.upsertExternal`, then
  fix each mapped `Charge` as a `ChargeFixation`. Idempotent.
- Register a worker command in the worker boot (`packages/backend/src/worker-boot.ts`)
  and task registry (`infra/task-registry.ts`); gated by an env flag, default off.

### Phase 3 — External guardrails

- `modules/payment/routes.ts` + `cancel.ts` — `cancel`/`reactivate`/`defer` reject
  `origin=External` with a typed `409` (own `toHttp()`, §7).
- Add an explicit test that `findDue` excludes `origin=External` (already true via
  the null-token filter).

### Phase 4 — Migration / supersede + overlap

- `modules/payment/domain.ts` `createOrExtend` — when the current active Payment is
  `origin=External`, supersede it (`markCancelledLapsed`-style with reason
  `migrated`) and insert the managed Payment in the same transaction.
- Emit the operator overlap notification (OQ-4: audit row and/or a new operator-only
  event); never routed to SendPulse.

### Phase 5 — SendPulse-sink suppression

- Carry origin on the stored event (payload `source`/`origin`) for any external event
  the system emits; `modules/sinks/sendpulse.ts` `deliver()` — add
  `if (isExternalOrigin(event)) return;` beside the existing null-`externalUserId`
  guard.

### Phase 6 — Read API

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
| AC-8 | 5        |
| AC-9 | 1, 2     |

---

## 8. Test plan

- **Unit** (`*.test.ts`, hermetic): mapping (SendPulse payment → Charge, minor
  units, idemKey), `PaymentOrigin` guardrail predicates, supersede decision in
  `createOrExtend`, connector origin-skip.
- **Integration/e2e** (`*.e2e.ts`, real Postgres): import creates external
  Payment+fixations and is idempotent on re-run; one-active constraint across
  managed+external; scheduler skips external; `cancel` on external → 409; checkout
  supersedes an active external and creates managed atomically; zero SendPulse
  deliveries for an external-origin event.

---

## 9. Risks

- SendPulse CRM export authorization/fields unresolved (OQ-2, [04](04-open-questions.md)).
- External Payment status/period semantics (OQ-1, OQ-3) affect import mapping.
- Overlap-notification transport (OQ-4) touches the event/audit surface.

---

## 10. Verification / Definition of Done

- No phase is done until its ACs' tests pass. Hard gates: `npm run typecheck`,
  `npm run lint`, `npm test` green; e2e suite green for the import/supersede/sink
  scenarios. Import proven idempotent by a double-run e2e.

---

## 11. ADR

- **Decision.** Model legacy payers as read-only `external` Payments sourced from
  SendPulse CRM, non-billable and sink-suppressed, migratable only via checkout.
- **Drivers.** D1 no double billing; D2 minimal churn; D3 idempotency; D4 no echoes.
- **Alternatives considered.** Second WFP merchant journal (1B); separate table (2B);
  per-sink event-routing table (3B); block-and-operator migration (4B).
- **Why chosen.** SendPulse CRM is the only source with the `contact_id` linkage; the
  origin marker reuses the existing constraint, scheduler filter, and checkout applier;
  suppression mirrors an existing connector skip.
- **Consequences.** One new column, one new source value, one new read module, one
  connector guard. A brief external↔managed overlap is inherent (we cannot cancel
  SendPulse's merchant) and is handled by operator notification.
- **Follow-ups.** OQ-1..OQ-6 in [25](25-legacy-payer-import-spec.md).

---

## 12. Open questions

Carried from [25 §7](25-legacy-payer-import-spec.md): OQ-1 external status/refresh,
OQ-2 SendPulse export contract, OQ-3 period inference, OQ-4 overlap transport,
OQ-5 multiple products per user, OQ-6 whether import emits any sink-facing events.
