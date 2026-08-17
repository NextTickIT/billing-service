# Payment flows — implementation plan

> How we build the three flows the gateway needs, on top of the shared incoming-event
> pipeline everything funnels through. Grounded in the verified research
> ([14](14-wayforpay-research.md)), the poller spec ([15](15-wayforpay-poller-spec.md)),
> the queue design ([09](09-message_queue_recomendations.md)), and the current code
> (auth/health modules, the `TaskRegistry` skeleton, the route DSL).
>
> **The three flows** (from the request):
> 1. **Checkout** — CRM passes `externalUserId`, gets a link; user picks a method; we build
>    a WayForPay hosted payment; on the callback we fix the payment, store the token,
>    create/extend the subscription, emit events.
> 2. **Recurring scheduler** — find subscriptions due, charge the stored token, retry on the
>    0/1/3/5/7 schedule, emit per-attempt events.
> 3. **Legacy poller** — read the WayForPay journal, turn found payments into standard
>    incoming events (detailed in [15](15-wayforpay-poller-spec.md)).

## 1. Decisions locked for this plan

| # | Decision | Resolution | Consequence |
|---|----------|-----------|-------------|
| D-scope | Sequencing | **Backbone first**, then flows | The FR-007 pipeline + FR-011 outbox + doc-09 queue is M1–M2; all flows are consumers of it |
| D-sink | Outgoing delivery | **Stub/logging sink now**; SendPulse later | Outbox + delivery machinery is built and tested; the SendPulse connector is a later isolated slice. AC1 is proven against a fake sink now, end-to-end when SendPulse lands |
| D-card | Subscription cardinality | **One active subscription per `external_user_id`** | `create-or-extend` extends the single active row; a partial unique index enforces "≤1 active per user". Multi-product is deferred |
| D-wfp | WayForPay access | **Test merchant only today** | Signing, parsing, window math, checkout-page assembly, retry logic are all buildable and unit-testable now. Live-verified only for reads against the shared test merchant. **Recurring CHARGE, real `recToken` capture, and regularApi migration-tail are code-complete-but-gated** on production credentials (see §8) |
| D-defaults | Standing conventions | UTC; integer minor units; Postgres-only queue (doc 09); hand-rolled Effect-native WFP client ported from `metatech/analytics`; camelCase DB columns == shared shape | — |
| D-out | Out of scope (MVP) | Crypto/Whitepay, refunds (00 §11.1), mid-cycle card change (§11.2), user-initiated cancel (§11.3), multi-product (§11.5) | Tracked in §9; the schema leaves room but no code |

## 2. Architecture — one path, many sources

Every payment fact (checkout callback, our own CHARGE result, poller finding, any future
webhook) enters the **same pipeline** and is decided in one place:

```
source ──► ingest ──► raw_events (append-only)      [R1, AC3]
                 └──► messages (idempotent enqueue)  [R2, AC2]
                            │  FOR UPDATE SKIP LOCKED  [R3]
                            ▼
                    payment-event handler
                       ├─ match → subscription / checkout session   [FR-007]
                       │     └─ record payment, advance subscription,
                       │        enqueue outgoing domain events
                       └─ no match → quarantine + alert             [FR-009, AC6]
                            │
                            ▼
                    domain_events (outbox) ──► event_deliveries ──► sink(s)   [FR-011, AC1]
```

Design rules that fall out of this and must hold:
- **The poller/scheduler/callback never write payments or domain events directly.** They only
  *ingest* raw incoming events. Matching, subscription mutation, and outgoing events live in
  the one handler ([15](15-wayforpay-poller-spec.md) D4).
- **Idempotency key is per source**, carried as `messages.idem_key` (unique with
  `message_type`). Poller/callback: `w4p:{orderReference}|{transactionType}|{createdDate}`
  (proven in analytics `external-id.ts`). Our CHARGE: the deterministic `orderReference`.
- **Raw is always stored, even on duplicate or parse failure** (00 §8.1/8.3): a duplicate still
  appends a `raw_events` row (own receipt time); a malformed payload is stored and quarantined,
  never dropped.

### Where things live (follows the existing layout)

| Concern | Location | Pattern anchor |
|---|---|---|
| Generic queue (raw/messages/attempts/status) | `infra/queue/` + real `infra/task-registry.ts` | doc 09; skeleton at `task-registry.ts:32` |
| Payment pipeline (ingest, match, quarantine) | `modules/payments/` | module = `data-access.ts`/`domain.ts`/`contracts.ts`/`errors.ts` (auth module) |
| Outbox + delivery + sinks | `modules/outbox/` + `infra/sinks/` | `Context.Tag` service, record of functions |
| WayForPay client (signature, client, types, errors) | `modules/wayforpay/` | port `analytics/packages/clients/wayforpay/src/*` |
| Checkout (sessions, public page, callback) | `modules/checkout/` (routes) | route DSL `infra/http/route.ts`; `modules/auth/routes.ts` |
| Recurring scheduler | `modules/billing/` (worker task) | `Effect.repeat` + `Schedule` launched from `worker.ts` |
| Migration poller | `modules/wayforpay/poller.ts` (worker task) | [15](15-wayforpay-poller-spec.md) |
| Shared contracts/enums | `packages/shared/src/schemas/*` | `Schema.Struct`, type derived; extend `subscription.ts`, `event.ts` |
| Config | `config.ts` `loadConfig()` + per-module injected slice | `AuthConfig` at `auth/domain.ts:26` |
| Migrations | `src/migrations/000N_*.ts` | `0001_auth.ts` (camelCase, double-quoted) |

## 3. Milestones

Each milestone is independently commit-worthy (per the "commit every finding/code" rule), lands
with its own migration + unit tests, and states its acceptance. Order respects dependencies.

### M1 — Durable queue backbone (doc 09)

Turn the `TaskRegistry` skeleton (`task-registry.ts:32`, currently an in-memory map + a
`runDispatcher` that logs and `Effect.never`s) into the real Postgres queue.

- **Migration `0002_queue.ts`**: `raw_events`, `messages` (`UNIQUE(message_type, idem_key)`,
  `status`, `attempt_count`, `retry_at`, `locked_by/at`), `attempts`, `message_status_events`
  (append-only status log, R6). Indexes from doc 09 (`messages_claimable`).
- **`infra/queue/ingest.ts`**: one-transaction ingest (`INSERT … ON CONFLICT DO NOTHING
  RETURNING id` → duplicate detection; always append `raw_events`; `NOTIFY new_message`).
- **`infra/queue/dispatcher.ts`**: claim (`FOR UPDATE SKIP LOCKED`), run the registered handler,
  complete in one tx (attempt row + status transition + `messages` update per handler verdict),
  reaper for stale `in_progress` (>5 min), `LISTEN/NOTIFY` + 1–5 s poll fallback.
- **`TaskRegistryLive`**: `register(messageType, handler)`, `runDispatcher()` for real; handlers
  own their retry policy (return `retry_at` or terminal `fail`).
- **Tests (unit, stubbed `SqlClient`)**: dedupe on idempotency key; duplicate still logs raw;
  claim exclusivity; retry scheduling; reaper requeue; status log is append-only.
- **Acceptance**: enqueue-twice → one message, two raw rows (AC2 foundation); a handler that
  fails then succeeds shows two `attempts` and the correct final status.

### M2 — Payment pipeline + outbox + stub sink (FR-007/009/010/011)

The domain path on top of M1. No provider specifics yet — a `test` source drives it.

- **Migration `0003_payments.ts`**: `incoming_payment_events` (source, idem_key, amount minor,
  currency, status, raw JSONB, match_result), `payments`, `quarantine_records` (status
  open/resolved + audit), `domain_events` (outbox envelope per [07](07-events.md)),
  `event_deliveries` (per-sink, status, retry, `UNIQUE(event_id, sink)`), `audit_log`.
- **`modules/payments/`**: `ingestIncomingPayment` (writes raw + enqueues `payment_event_received`);
  the handler → **match** (checkout session by our order ref; subscription by our recurring order
  ref; else no-match) → on match record `payment` (idempotent on source key), mutate subscription
  (M5/M6 hooks), enqueue outgoing events; on no-match → `quarantine_records` + `unknown_payment_quarantined`.
- **`modules/outbox/`**: append domain events; a delivery task drains `event_deliveries` per sink
  with retry; operator visibility query (`GET /api/support/deliveries?status=failed`).
- **`infra/sinks/`**: `Sink` service interface + `LoggingSink` (records delivery, no external
  call). SendPulse is a future `Sink` impl — **no core change** (AC8).
- **Support endpoints** (behind support token, audited): `GET /api/support/quarantine`,
  `POST /api/support/quarantine/:id/bind` — bind → reprocess through the same handler.
- **Tests**: replay a source event → zero new payments/events (AC2); no-match → quarantine + one
  event; bind → reprocess emits outgoing events (AC6); delivery retried until acked, SLA metric.
- **Acceptance**: AC2, AC3, AC6, AC8 provable with the `test` source and `LoggingSink`; AC1
  provable end-to-end once a real sink exists.

### M3 — WayForPay client module (port from analytics)

Port the Effect-native client — it already matches our stack (`Effect.fn`, `Schema`,
`Data.TaggedError`). Source: `~/Projects/metatech/analytics/packages/clients/wayforpay/src/`.

- **Port verbatim (adapt imports)**: `signature.ts` (HMAC-MD5, explicit field-order table),
  `errors.ts` (`W4pTransportError/ResponseError/ApiError/WindowTooLargeError/OrderNotFoundError`),
  `windows.ts` (≤30-day chunking; 1109 cap is real, [14](14-wayforpay-research.md) addendum),
  `external-id.ts` (`ref|type|createdDate` idem key), `types.ts` (permissive schemas: money/dates
  string-or-number, `onExcessProperty: preserve`).
- **Extend the signature table** for the write flows (from [14](14-wayforpay-research.md) §"API surface"):
  - Purchase / CHARGE: `merchantAccount;merchantDomainName;orderReference;orderDate;amount;currency;productName…;productCount…;productPrice…`
  - serviceUrl callback verify (8 fields): `merchantAccount;orderReference;amount;currency;authCode;cardPan;transactionStatus;reasonCode`
  - callback ack signature: `orderReference;status;time`
- **Client service** (`modules/wayforpay/client.ts`): the injected-interface pattern from analytics
  wrapped as an Effect service (`Context.Tag` + `Layer`), so poller/scheduler/checkout depend on
  the tag. Methods: `transactionList`, `checkStatus`, `regularStatus` (read, live-tested now);
  `charge`, `buildPurchase` (write, gated). Transport-only transient retry + injected rate limiter.
- **Port helpers** `@guild/core` relies on (`truncateBody`, `RateLimiter`, `retryTransient`,
  `isTransientStatus`) into `infra/` (small, no external dep).
- **Config slice** (`W4pConfig`, injected like `AuthConfig`): `W4P_MERCHANT_ACCOUNT`,
  `W4P_SECRET_KEY` (`Redacted`), `W4P_MERCHANT_PASSWORD` (`Redacted`, optional), `W4P_API_URL`,
  `W4P_DOMAIN_NAME`, poller/rate-limit knobs.
- **Tests**: signature reproduces the official worked example + the probe's accepted hashes;
  permissive decode tolerates the wider-than-documented fields; 1109/1127 → typed errors.
- **Acceptance**: `transactionList` against `test_merch_n1` returns rows (mechanics, not data);
  signature vectors pass.

### M4 — Flow 3: migration poller ([15](15-wayforpay-poller-spec.md))

Implement exactly the resolved decisions D1–D5 in doc 15.

- **Migration `0004_w4p_poller.ts`**: `w4p_poller_state` (watermark per provider account).
- **`modules/wayforpay/poller.ts`**: `Effect.repeat(Schedule.fixed(interval))` launched from
  `worker.ts`; each tick queries `[watermark - overlap, min(now, watermark + maxWindow)]`, filters
  by `transactionType`, maps rows → `ingestIncomingPayment` (M2), advances watermark only after
  durable ingest. Idem key = `external-id.ts`. Metrics: freshness (`now - max(processingDate)`),
  per-tick ingested/duplicate/skipped.
- **Backfill task** (operator-triggered): walk backwards in ≤31-day chunks (`windows.ts`) until N
  empty chunks; reuses the M2 ingest path; records deepest reachable date.
- **Migration-tail metric** (regularApi `STATUS`): **gated on `merchantPassword`** — ships when the
  credential lands (D-wfp); MVP exposes freshness only ([15](15-wayforpay-poller-spec.md) OQ2).
- **Acceptance**: AC7 (mechanics); idempotent ticks (replay → 0 new); `SETTLE`/unknown types
  skipped+counted; watermark holds on failure.

### M5 — Flow 1: checkout (FR-001/002/003, AC5)

- **Migration `0005_checkout.ts`**: `checkout_sessions` (externalUserId, amount, currency, period,
  chosen method, status created/pending/completed/expired, provider order ref, expiry); extend
  `subscriptions` (M6 shares) with `recurring_tokens` (token ref, mask, status per
  [05](05-domain-model.md)).
- **`modules/checkout/`**:
  - `POST /api/checkout-sessions` (service token) → session + unguessable link + expiry
    ([06](06-api.md)); `externalUserId` opaque, echoed verbatim (AC9).
  - `GET /checkout/:sessionId` (public) → minimal page: method choice (**card only for MVP**;
    crypto shown-disabled), pay button, **no paid_till** (FR-002).
  - `POST /api/checkout-sessions/:id/select` → build a signed **Purchase** (hosted page,
    `secure.wayforpay.com/pay`), **no `regularMode`** (avoid a WFP-managed schedule —
    [14](14-wayforpay-research.md) TL;DR gotcha); return the auto-submit form params.
  - `POST /api/providers/:provider/callback` (provider signature) → verify 8-field HMAC, write raw,
    **ack** `{orderReference,status:"accept",time,signature}`, ingest into the M2 pipeline.
    At-least-once for 4 days → idempotent (AC2).
- **On matched success** (in the M2 handler): record payment, **store `recToken`** as a
  `recurring_token` on the subscription, **create-or-extend** the single active subscription
  (next charge = payment date + period), emit `subscription_created` (new) + `payment_succeeded`.
- **Gating (D-wfp)**: real `recToken` capture needs tokenization enabled on the prod account
  (unverified, [14](14-wayforpay-research.md)); the callback path is fully testable with a
  synthetic signed callback now.
- **Acceptance**: AC5 (link → method → pay → subscription + event; token stored), AC9.

### M6 — Flow 2: recurring scheduler (FR-004/005/006, AC4)

- **Migration `0006_billing.ts`**: extend `subscriptions` with `next_charge_date`, `status`
  (active/past_due/renewal_failed/cancelled), retry state (first-failure date, attempt index);
  `charges` with `UNIQUE(subscriptionId, period)` to enforce **FR-006** (no two successful charges
  per subscription-period). Partial unique index: ≤1 `active` subscription per `externalUserId`
  (D-card).
- **`modules/billing/scheduler.ts`**: `Effect.repeat(Schedule.fixed(...))` from `worker.ts`; each
  tick claims due rows (`status IN (active,past_due) AND next/retry_date <= now
  FOR UPDATE SKIP LOCKED`). Per subscription: **CHARGE** by `recToken` with deterministic
  `orderReference = sub_{subscriptionId}_{periodKey}_{attempt}` (dedup, rc 1112 =
  already-charged, not an error). Feed the CHARGE result **into the M2 pipeline** as a
  `wfp_charge_response` source so payment fixation + events stay single-path.
  - success → advance `next_charge_date` by period (**month-end clamp**: Jan 31 → Feb 28,
    [04](04-open-questions.md)); `payment_succeeded`.
  - failure → advance retry per `RETRY_SCHEDULE_DAYS` (`subscription.ts:58`); emit
    `charge_retry_failed` (attempt, next date, provider reason); **day-7 → `renewal_failed`**,
    then hands off (gateway stops).
- **Gating (D-wfp)**: CHARGE is unverifiable against the test merchant → unit-test the loop with a
  stubbed client (schedule arithmetic, retry ladder, dedupe, dup-charge guard); live-verify when
  prod credentials + a token exist.
- **Acceptance**: AC4 (0/1/3/5/7 schedule, day-7 `renewal_failed`, each failure an event);
  FR-006 dup guard holds under replay.

## 4. Data model additions (summary)

Extend `packages/shared/src/schemas/` (single source of truth; DB columns mirror these camelCase
names, double-quoted, per `0001_auth.ts`):

- `subscription.ts`: add `period` (ISO-8601 duration, e.g. `P1M`), `status`, `nextChargeDate`,
  retry state, `recurringTokenRef`, timestamps. Add `RecurringToken`, subscription `Status` enum.
- new `checkout.ts`: `CheckoutSession` + status enum.
- new `payment.ts`: `IncomingPaymentEvent`, `Payment`, `QuarantineRecord`.
- `event.ts`: the `DomainEvent` envelope + `EventName` union ([07](07-events.md)); keep
  `SINK_DELIVERY_SLA_SECONDS`.

## 5. Config additions (`loadConfig`, all `process.env` reads stay here)

`W4P_MERCHANT_ACCOUNT`, `W4P_SECRET_KEY`*, `W4P_MERCHANT_PASSWORD`* (optional), `W4P_API_URL`
(default `https://api.wayforpay.com/api`), `W4P_DOMAIN_NAME`, `W4P_POLL_INTERVAL_SECONDS`,
`W4P_WINDOW_OVERLAP_SECONDS`, `W4P_MAX_WINDOW_SECONDS`, `W4P_RATE_LIMIT_*`,
`CHECKOUT_SESSION_TTL_SECONDS`, `SCHEDULER_INTERVAL_SECONDS`. (`*` = `Redacted`.) Each module gets
an injected config slice service (the `AuthConfig` pattern), never reads env directly.

## 6. Observability (00 §8.5)

Operator-visible + alerted: quarantine depth, failed deliveries, subscriptions in retry, poller
freshness/lag, migration tail. Counters emitted per tick/handler; surfaced via the support
endpoints and logs (metrics backend TBD, out of this plan's scope).

## 7. Testing strategy (mirrors auth's two tiers)

- **Unit** (colocated, vitest, stubbed `SqlClient`/client/fetch): signature vectors, window math,
  dedupe, retry ladder, month-end clamp, 1109/1127 branches, `SETTLE` filtering, match/quarantine,
  outbox delivery/retry.
- **e2e** (`*.e2e.ts`, gated): reads against `test_merch_n1` (assert mechanics, never its data —
  it serves canned rows & ignores date filters, [14](14-wayforpay-research.md) addendum); pipeline
  e2e against a real Postgres.

## 8. Gating on production WayForPay access (D-wfp)

Buildable & unit-testable now; **live-verified only when prod access lands**:

| Needs | Credential/enablement | Blocks (live only) |
|---|---|---|
| Journal reads, checkout-page assembly, signatures | test merchant (have) | nothing — buildable now |
| Recurring CHARGE, real `recToken` capture | prod merchant + secretKey **+ tokenization enabled on account** (unverified) | M6 live; M5 token capture live |
| Migration-tail metric, legacy subscription state | `merchantPassword` (regularApi) — analytics already has it | M4 tail metric |

**Action to unblock**: get prod `merchantAccount`/`secretKey`, confirm tokenization is enabled with
WFP, and copy `WAYFORPAY_MERCHANT_PASSWORD` from the analytics env into this project's secrets. Until
then M5/M6 land behind their unit tests and a config flag; the poller runs read-only.

## 9. Deferred (open questions, not in MVP)

Refunds & `payment_refunded` (00 §11.1); mid-cycle card change (§11.2); user-initiated cancel &
its effect on the next charge (§11.3); currency fixed-at-creation (§11.4 — assumed yes); multiple
subscriptions per user / multi-product (§11.5 — schema leaves room, D-card ships single-active);
checkout-link lifetime/anti-guessing specifics (§11.6); operator role boundaries (§11.7). Each is a
later slice; none blocks M1–M6.

## 10. Commit plan

One or more commits per milestone (schema, then module, then tests), documents included, squashed
at landing but kept as history now. Suggested branch flow: keep `implement-way-for-pay`; land M1–M2
(the backbone) before opening the flow milestones so they rebase cleanly onto a stable pipeline.
