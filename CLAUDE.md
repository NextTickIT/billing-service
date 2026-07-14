# CLAUDE.md — Engineering guidelines for the billing service

The defining guide for working in this repository: what the service is, how it is
built, and the rules every change must hold to. Authoritative and prescriptive. Deep
detail lives in `docs/`; this file states the rules and cites the canonical doc.

## 1. What this service is

A payment gateway that takes ownership of **money and the billing cycle** for
subscriptions and publishes payment events to external systems faster than their own
automations can act on stale state (docs/00). It is **not** the owner of subscription
access, identity, CRM, or analytics — it reports facts about money; an external system
(SendPulse) owns access and `paid_till`.

- Everything external is a **replaceable connector**: a provider connector (WayForPay
  cards/tokenization, Whitepay crypto) and a sink connector (delivers outgoing events).
  Adding a provider or a sink must not touch the core (AC8). (docs/00 §3)
- `externalUserId` is an **opaque** id supplied by the caller and returned on every
  event **without transformation**. No identity matching by email/phone, ever.
  (docs/00 §2, AC9)

### The flows (docs/00 §5, docs/02; conformance map docs/18)

1. **Checkout** — a session (`externalUserId`, amount, period) → a minimal hosted page
   (method choice only, no `paid_till`) → provider webhook → record the payment,
   create/extend the gateway subscription, emit `payment_succeeded`. (FR-001/002/003,
   AC5)
2. **Incoming recurrent events** — provider webhooks and the migration poller normalize
   into one pipeline: raw log → idempotency → match → outgoing event. All sources are
   equal. (FR-007/008/010)
3. **Own billing cycle** — on the due date, charge the stored token; success advances
   the next charge date and emits `payment_succeeded`; failure retries on days
   **0/1/3/5/7**, each emitting `charge_retry_failed`, the day-7 failure emitting
   `renewal_failed` (terminal). (FR-004/005, AC4)
4. **Quarantine** — an unmatched payment is stored raw and quarantined with an operator
   alert; after an operator bind it is reprocessed as if matched. Target: zero
   permanently-unmatched payments. (FR-009, AC6)

### Acceptance criteria (docs/00 §9) — every change keeps all nine

AC1 sink updated ≤ 60 s after a success · AC2 duplicate webhook → no double payment or
event · AC3 every event stored raw, subscription state replayable · AC4 retry ladder
0/1/3/5/7 then final · AC5 checkout → subscription + token · AC6 quarantine → bind →
reprocess, permanent-unmatched counter 0 · AC7 unmigrated payments appear ≤ poll
interval with a visible tail metric · AC8 new provider/sink without core change · AC9
`externalUserId` carried verbatim.

## 2. Architecture & runtime

- **Monorepo** (npm workspaces + turbo): `packages/shared` (schemas — the single
  source of truth for data shapes), `packages/backend` (Fastify + Effect),
  `packages/frontend`.
- **Effect everywhere.** Services are `Context.Tag` + `Layer`; implementations are
  **records of functions** (no classes, no `this`); errors are typed
  (`Data.TaggedError`), never `throw`; effects and async run through `Effect`.
  (docs/10–13)
- **One application runtime**: a single lazy DB-backed `ManagedRuntime` that every
  route runs on. `ManagedRuntime.make` opens no connection until the first `run*`, so
  `buildApp()` and connection-free unit tests stay hermetic; `/health` is a readiness
  probe that runs `SELECT 1` on it. The worker is a separate OS process with its own
  runtime.
- **Autoload**: only `routes.ts` (and optional `*.plugin.ts`) are autoloaded;
  `domain.ts` / `data-access.ts` are plain imports. Migrations are typed `.ts` modules
  in `src/migrations/`, applied at startup by the server (or `npm run db:migrate`),
  never by the worker.
- **Async backbone**: a durable **Postgres-only** work queue (docs/09); the worker
  polls it. No external broker.
- **Config** comes from env; secrets are `Redacted` and never live in source.

## 3. Module & code conventions (docs/16 is canonical)

A module mirrors `auth`: `data-access.ts` / `domain.ts` / `routes.ts` / `contracts.ts`
/ `test/`. The eleven conventions in force:

1. **Comments answer WHY.** WHAT is carried by the name, the structure, and the file
   location; HOW by the function body. A comment exists only for a WHY none of those
   can express — and, rarely, a HOW note when the body is unavoidably subtle. No
   banner / file-header comments.
2. **Domain code takes domain commands**, never transport types (`Body` / `Request` /
   headers). Routes decode HTTP into a command; status codes, encoding, and header
   parsing stay in routes.
3. **Authorization is a domain concern** — `requireRole(actor, role)` fails with
   `Forbidden`; transport only extracts the credential and resolves an `Actor`.
4. **No production code that exists only for tests** — no in-memory repos or fakes in
   `src`. Unit-test the pure and resource-free; cover resource-bound behavior in e2e.
5. **Test placement** — `modules/{m}/test/*.test.ts` are hermetic units (run by
   `npm test`); `*.e2e.ts` are scenarios (e2e runner only). Test files never ship.
6. **`shared` is sliced by entity** — `shared/src/schemas/{entity}.ts` owns that
   entity's schemas, enums, and constants. A **public** shape (API request/response, a
   domain event, a persisted entity) lives in its shared slice, **never** in a module;
   a module's `contracts.ts` is only for shapes that must not be public (auth's
   `Redacted` secret-carrying bodies).
7. **Errors own their HTTP mapping** — typed errors expose `toHttp()`; transport maps
   any failure with `toHttp?.() ?? { status: 500 }`, so an unmapped error is a 500.
8. **Routes use the colocated DSL** — method / path / input / output / handler declared
   via `makeRoute(runtimeOf)`; it decodes (400 on a schema miss), runs on the module
   runtime, encodes, and maps errors.
9. **Derived, not duplicated, types** — reuse via `Omit` / `Pick` / `Schema.extend`;
   never hand-write a type that mirrors an existing schema; derive SQL column lists
   from `Schema.fields`.
10. **Shapes that vary by a discriminant are a discriminated union** — on `name` /
    `kind` / `_tag` (`DomainEvent`, `MatchResult`, the typed errors); never a wide base
    with optional fields or a `Record` payload. Carve-out: deliberately opaque payloads
    (raw provider data, the post-jsonb `StoredEvent`) stay `Record<string, unknown>`.
11. **Domain steps are functions, not injected services** — a matcher / applier is a
    plain function composed at the runtime root and passed in; reach for `Context.Tag` +
    `Layer` only for a real resource (Sql, the queue, the outbox) or a genuine swap
    boundary.
12. **Provider-specific code lives in the provider module** — signing, callback
    parsing, the hosted Purchase form, the API client live in `wayforpay` (future
    `whitepay`); `checkout` and the pipeline stay processor-agnostic and import the
    provider surface. A new provider is a new module (AC8), not edits across
    `checkout` / `payments`.
13. **Extract shared logic; keep domain functions in `domain.ts`** — logic used by
    more than one module goes to a common `infra/` home, never copy-pasted (e.g.
    `requireRow`, the PG error mapping in `infra/db`); a module's matchers / appliers /
    builders live in its `domain.ts`, not one-function files.

## 4. Type system & lint (both are hard gates — run before claiming done)

`tsconfig.base.json` is strict; write to it from the start:

- `exactOptionalPropertyTypes` — derive types from schemas
  (`Schema.Schema.Type<typeof X>`); a hand-written `{ f?: T }` is not assignable from a
  decoded `{ f?: T | undefined }`.
- `noUncheckedIndexedAccess` — an index access is `T | undefined`; guard, `?.`, or
  destructure.
- `noPropertyAccessFromIndexSignature` — index-signature keys use bracket access.
- `useUnknownInCatchVariables` — a caught value is `unknown`; normalize it before use.
- `verbatimModuleSyntax` — type-only imports use `import type`.

`eslint.config.js` budgets, which fail the build: `complexity ≤ 10`, `max-depth ≤ 3`,
`max-lines-per-function ≤ 60`, `max-statements ≤ 15`, `max-params ≤ 4`,
`max-nested-callbacks ≤ 3`, plus `strictTypeChecked` + `stylisticTypeChecked`. Keep
functions small: extract named helpers, pass a single options object past four params,
hoist nested callbacks. Run `npm run lint` and `npm run typecheck`.

## 5. Data, persistence & the work queue

- **Amounts are integer minimal currency units; all timestamps are UTC.** (docs/00 §8,
  docs/03)
- Enums are **numeric at rest** (stored as numbers) mirrored by `Schema.Enums`. DB
  columns are **camelCase and double-quoted** in SQL, mirroring the shared schema with
  no name transform (unquoted camelCase folds to lowercase in Postgres).
- In `@effect/sql-pg`, `sql.in(list)` renders values **without** the `IN` keyword —
  write `` `"col" IN ${sql.in(list)}` `` (otherwise Postgres parses `"col"(…)` as a
  function call).
- **Never store card numbers, CVV, or raw credentials**; provider tokens are sensitive;
  logs carry no card data, secrets, or raw tokens. (docs/03 Security/Privacy)
- **Durable queue invariants** (docs/09) — do not weaken:
  - **Three-layer idempotency**: ingest dedup (`UNIQUE(messageType, idemKey)` +
    `INSERT … ON CONFLICT DO NOTHING`); claim exclusivity (`FOR UPDATE SKIP LOCKED` +
    a same-statement flip to `in_progress`); handler idempotency (deterministic ids so
    an at-least-once redelivery from the reaper is safe). (AC2)
  - **Mutable working row, append-only logs**: `messages` holds the current `status`
    cache; `raw_events` / `attempts` / `message_status_events` are append-only. Read
    the cache for current state, never scan a log; every status change appends its log
    row in the **same statement** (`infra/queue/store.ts` claim / complete /
    reapStale). (AC3)
  - The dispatcher captures `exit` (typed failures **and** defects), so a throwing
    handler is recorded as a failed attempt, never a process crash.
- **Raw journal of everything, before processing** (append-only) — every incoming and
  outgoing event is stored raw so any subscription is replayable and any incident
  auditable. (docs/00 §8, AC3)
- **Consistency**: one clear current status per subscription; never two successful
  charges for one period by internal logic; subscription state is updated **before**
  events are emitted. (docs/03)

## 6. Domain model (docs/05)

- No `User` entity; `externalUserId` is opaque and carried verbatim.
- Live entities: `CheckoutSession`, `Subscription`, `IncomingPaymentEvent`,
  `QuarantineRecord`, the recurring token (inline as `recurringTokenRef`),
  `DomainEvent`, `EventDelivery`, `AuditLog`. `PaymentIntent` / `PaymentAttempt` /
  `BillingPeriod` from docs/05 are not separate tables — their behavior is covered by
  `incoming_payment_events` + `payments` + the queue's `attempts` (docs/18).
- Subscription status: `active` / `past_due` (retry window) / `renewal_failed`
  (terminal; a new checkout creates/extends) / `cancelled`. Checkout status: `created`
  / `pending` / `completed` / `expired`.
- One active subscription per `externalUserId` (extend in place — interview decision,
  docs/18). Retry schedule is fixed: `RETRY_SCHEDULE_DAYS = [0,1,3,5,7]` (owned by the
  subscription slice).
- Billing dates advance by whole periods and **clamp to the last valid day** of the
  target month (e.g. Jan 31 → Feb 28), computed in the canonical billing timezone
  (`subscription/period.ts`; docs/04, docs/17).

## 7. Events & outbox (docs/07, docs/00 §6)

- Vocabulary (extensible): `payment_succeeded`, `charge_retry_failed`,
  `renewal_failed`, `subscription_created`, `subscription_cancelled`,
  `unknown_payment_quarantined`. `DomainEvent` is a discriminated union on `name` with a
  typed payload per variant; `externalUserId` is null only for a quarantine.
- **Outbox**: publishing stores the event and fans out one `EventDelivery` per sink; the
  queue drives delivery. Delivery is **at-least-once** to every sink; sinks are
  idempotent on their side; failed deliveries retry and stay visible to the operator.
  SLA: each sink within **60 s** of payment fixation (AC1). The stub sink is named
  `sendpulse` so the real connector swaps in with no data migration.

## 8. Payments & WayForPay (docs/14, docs/15)

- Provider logic (signing, callback parsing, the Purchase form, the API client) lives
  in the `wayforpay` module; `checkout` and the FR-007 pipeline are
  **processor-agnostic** and import the provider surface (docs/16 §12).
- **We own the billing cycle**: the Purchase is built **without** `regularMode` — we
  hold the token and run our own schedule; WayForPay must not create a managed one.
- **Deterministic keys** so re-observation dedupes (FR-006): `orderReference =
sub_<subscriptionId>_<…>`; charge idemKey `w4p:<orderReference>|CHARGE|<createdDate>`;
  callback idemKey `w4pcb:<orderReference>|<status>`. The scheduler and the poller derive
  the same key.
- HMAC-MD5 signing uses explicit, sourced field-order tables — never reorder them.
- **Tolerant parsing**: a provider's unexpected field never drops an event — the raw is
  always stored, the problematic goes to quarantine, never to `/dev/null` (docs/00 §8).
- Provider quirks: money/date fields arrive as string or number (coerce); an unknown
  currency defaults to UAH while the raw payload keeps the truth; a **Declined** charge
  is a valid response the scheduler branches on, not an Effect error.
- **Rate-limit** every WayForPay call (docs/03 Capacity).
- The migration poller is a **long-lived** component (monitoring, alerts, a
  migration-tail metric visible to operators), not a stopgap; a separate
  operator-triggered backfill reads the journal in ≤ 31-day chunks until it runs dry.
  Migration happens only by user action (re-tokenizing via checkout); the old-recurrent
  tail may live for years and is never force-cancelled. Poller and scheduler ship
  **gated off** (`W4P_POLLER_ENABLED`, `SCHEDULER_ENABLED`) pending production access.

## 9. API & security (docs/06, docs/03)

- Endpoints: `GET /health` (none); `POST /api/checkout-sessions` (service token) and
  `GET /checkout/:id` (public, unguessable id); `GET /api/subscriptions/:id` and
  `?externalUserId=` (service token); `POST /api/providers/:provider/callback` (provider
  signature); `/api/support/*` (support token, **audited**) — subscriptions read/cancel,
  quarantine list/bind, deliveries.
- Admin and support APIs require authentication; service-to-service requires a token;
  provider callbacks are verified by signature. Secrets stay outside source.

## 10. Non-functional requirements (docs/03)

- **Capacity**: up to 100k active clients, ~1 scheduled payment per period; ~10 support
  users. Limit WayForPay calls.
- **Performance**: support UI 1–2 s; status API < 500 ms–1 s; callback accept+store
  < 2 s; delivery ≤ 60 s; the scheduler drains all due within 24 h even if all 100k fall
  due the same day.
- **Reliability**: no loss of payment, callback, attempt, subscription, or event state
  across restart; the scheduler is restart-safe; duplicate callbacks never corrupt state.
- **Auditability**: audit payment attempts, callbacks, subscription status changes, retry
  scheduling, manual operator actions, and checkout creation.
- **Observability**: structured logs and correlation ids; metrics for successful /
  failed / pending payments, retries, callback errors, scheduler errors, quarantine
  size, undelivered events, subscriptions in retry, poller freshness, and migration
  tail. **Each operator queue has an alert.**
- **Backup**: daily backup to external storage is acceptable for MVP.

## 11. Testing

- **Unit** (`*.test.ts`): hermetic, no Postgres, run by `npm test`; cover pure and
  resource-free logic. Use real calendar dates (leap day is `2024-02-29`; `2026-02-29`
  does not exist and builds an `Invalid Date`). When a repo interface gains a method,
  update every fake in the same change.
- **E2E** (`*.e2e.ts`): the whole system against **real Postgres in Docker**
  (`docker-compose.e2e.yml`), one throwaway database per scenario. Assert concrete
  values, not just "no throw" — that is what earns their cost.

## 12. Workflow

- **Never amend or rewrite git history** — only add a commit or `git revert`. No
  `git commit --amend`, no history-rewriting rebase/reset, even to fix a previous
  commit; the user performs any amend.
- Commit each document, finding, and code change incrementally; keep commits atomic.
- Do not weaken a load-bearing invariant (§5) or an acceptance criterion (§1) to make a
  change compile or a test pass — fix the change instead.

## 13. Deferred / open (docs/04, docs/00 §11, docs/18)

Refunds and `payment_refunded`; mid-cycle card change; a user-initiated cancel channel
(operator cancel is done); currency fixed at creation (assumed yes); multiple
subscriptions per user (decision: one active, extend in place); checkout-link security
bounds; operator role boundaries. The real SendPulse sink (stub now). Live-only until
production WayForPay access lands: recurring CHARGE, real `recToken` issuance, and the
regularApi migration-tail metric.

## 14. Deep specs

Scope/ТЗ `docs/00`–`docs/01`, functional requirements `docs/02`, NFRs `docs/03`, open
questions `docs/04`, domain model `docs/05`, API `docs/06`, events `docs/07`, vertical
slice `docs/08`, queue `docs/09`, project setup `docs/10`–`docs/11`, auth
`docs/12`–`docs/13`, WayForPay research + poller `docs/14`–`docs/15`, conventions
`docs/16`, payment-flows plan `docs/17`, conformance map `docs/18`.
