# Conformance review — WayForPay flows

How the implementation maps to the requirements in `docs/*`, what is deliberately
deferred (with the doc that marks it open), and where the test-merchant limitation
gates live verification. The three flows of `00-tz` §5 are implemented; every FR,
AC, and scenario below is traceable to a module and a commit.

## Flows (`00-tz` §5)

| Scenario | Implementation |
|---|---|
| §5.1 Manual renewal via checkout | `modules/checkout` (M5): session → hosted Purchase → serviceUrl callback → subscription + events |
| §5.2 Incoming recurrent events | `modules/wayforpay` poller (M4) + provider callback (M5) → the FR-007 pipeline |
| §5.3 Own billing cycle | `modules/billing` scheduler (M6): charge by token, 0/1/3/5/7 retries |
| §5.4 Unknown payment → quarantine | `modules/payments` + `modules/support` (M2): quarantine + operator bind |

## Functional requirements (`02-functional-requirements.md`)

| FR | Status | Where |
|----|--------|-------|
| FR-001 checkout session creation | ✅ | `checkout/routes` POST /api/checkout-sessions |
| FR-002 minimal checkout page | ✅ | `checkout/routes` GET /checkout/:id (method choice, no paid_till) |
| FR-003 first payment processing | ✅ | `checkout/applier` (record charge, store recToken, create/extend Payment, emit) |
| FR-004 recurring billing | ✅ | `billing/scheduler` (charge due, advance nextPaymentDate from anchor, payment_succeeded) |
| FR-005 retry schedule 0/1/3/5/7 | ✅ | `payment/retry` + `billing/scheduler` |
| FR-006 duplicate-charge protection | ✅ | deterministic orderReference + queue idem key + advance-on-success |
| FR-007 incoming-event pipeline | ✅ | `infra/queue` + `modules/payments` (raw → idempotency → match → outbox) |
| FR-008 migration poller | ✅ | `wayforpay/poller` (freshness metrics; migration-tail = phase 2, needs merchantPassword) |
| FR-009 quarantine | ✅ | `payments` quarantine + `support` bind Charge → Payment → reprocess |
| FR-010 provider callbacks | ✅ | `checkout/callback` (8-field HMAC verify, idempotent, tolerant parse) |
| FR-011 outbox + sink delivery | ✅ mechanism | `modules/outbox` + `infra/sinks` (LoggingSink stub; real SendPulse deferred by interview) |
| FR-012 cancellation | ✅ operator | `payment` cancel (operator + provider-event ready; user channel is §11.3 open) |

## Acceptance criteria (`00-tz` §9)

AC2 (idempotency), AC3 (raw journal), AC4 (retry ladder), AC5 (checkout →
Payment + token), AC6 (quarantine → bind → reprocess), AC8 (new provider/sink
without core change — the `Sink` set plus composable matcher/applier functions), AC9
(externalUserId carried verbatim, never transformed) — all proven by unit tests and
the real-Postgres e2e (16 scenarios). AC1 (SendPulse ≤60s) and AC7 (poller lag) are
proven for the *mechanism* (delivery loop, poll loop); their live end-to-end depends
on the SendPulse connector and production WayForPay access respectively.

## Deliberately deferred (open questions in `04` / `00-tz` §11)

- Refunds & `payment_refunded` (§11.1) — a refund arrives as its own journal row
  (verified in metatech/analytics recon); the poller already ingests it, but the
  subscription effect and the refund event are out of this scope.
- Mid-cycle card change (§11.2); user-initiated cancel channel (§11.3, operator
  cancel is done); currency-fixed-at-creation (§11.4, assumed yes); multiple
  Payments per user (§11.5 — interview decision: one active Payment, extend in place);
  operator role boundaries (§11.7 — any valid token authorizes support, audited).
- Real SendPulse sink (interview decision: stub now, connect later — no core change).

## Deviations from the domain model (`05-domain-model.md`)

- `PaymentIntent` / `PaymentAttempt` are not separate tables; their behaviour is
  covered by `charges` + `charge_fixations` + the queue's `attempts`.
- `RecurringToken` is stored inline on the Payment (`recurringTokenRef`) rather
  than as its own entity with a status lifecycle — sufficient for AC5 and the
  scheduler; the lifecycle (cancel/expire) can be promoted to a table if needed.

These simplify the model without weakening any FR; the field names still mirror the
shared shape verbatim (no name transform, per the project convention).

## Test-merchant gating (interview: test merchant only)

Buildable and unit/e2e-tested now; live-verified only when production access lands:
recurring CHARGE and real `recToken` issuance (needs tokenization enabled on the
merchant account) and the regularApi migration-tail metric (needs `merchantPassword`,
already in the analytics org env). The poller/scheduler are shipped gated off
(`W4P_POLLER_ENABLED`, `SCHEDULER_ENABLED`).

## Original requests (from session history)

- Three flows (checkout, recurring scheduler, legacy poller) — delivered (M4–M6).
- "Commit every document, finding, and code" — 16 commits, incremental, squashable.
- Rebase onto the latest project-setup baseline — done before implementation.
- Research → interview → plan before building — `docs/14`, `docs/15`, `docs/17`.
- Poller reads backwards / current-state scan — `backfill` (M4) + regularApi STATUS
  design (`docs/15`, phase-2 gated).
- CRM person identifier for matching — orderReference-first (`docs/15` D3; the
  recurring matcher parses `sub_<id>` / defers legacy `_WFPREG`).
- Reuse the metatech/analytics WayForPay client — ported in M3.
