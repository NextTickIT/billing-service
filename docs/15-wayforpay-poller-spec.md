# WayForPay Migration Poller Spec (Planner Input)

> Spec for **FR-008: WayForPay migration poller** — the long-lived worker that reads the
> WayForPay operation journal every few minutes and converts found payments into standard
> incoming payment events (FR-007), so charges made by WFP-managed legacy recurrents
> (500+, callback URL not repointable) become visible to the gateway.
>
> **Status:** ready for planning. Grounded in verified research
> ([14-wayforpay-research.md](14-wayforpay-research.md)) **plus a live probe of the real
> API** (2026-07-12, public test merchant `test_merch_n1`) — the mechanism is proven to
> work, see "Empirical findings" below. Nothing here is committed yet (session rule).

## Goal

A worker-side poller that:

1. Periodically queries `TRANSACTION_LIST` (POST `https://api.wayforpay.com/api`) over a
   sliding, overlapping time window.
2. Converts each relevant journal entry into a standard **IncomingPaymentEvent** and feeds
   it to the FR-007 pipeline (raw log → idempotency → match → outbox). The poller itself
   never writes payments or domain events directly.
3. Exposes **freshness** and **migration-tail** metrics (FR-008).
4. Rate-limits itself; WayForPay documents no server-side limits (verified).

## Empirical findings (live probe, must shape the plan)

Probe: `TRANSACTION_LIST` + `CHECK_STATUS` against the shared test merchant. Results:

- The documented signature works: HMAC-MD5 over `merchantAccount;dateBegin;dateEnd`
  (Unix seconds) → `reasonCode 1100 Ok`, transactions returned.
- **Response is wider than the docs**: apiVersion 1 already returns `baseAmount`,
  `baseCurrency`, `settlementReference`, `clientName`, `clientPhone`, `clientEmail`,
  `clientComment`, `prroLink`, `prroNumber` on top of the documented fields. Parser must
  tolerate unknown fields (parse-don't-validate on the fields we use, passthrough raw).
- **Types are stringly**: `amount: "10.10"` (string decimal), `createdDate: "1752011286"`
  (string epoch seconds). Convert deliberately; store money in minor units.
- **The journal mixes operation types**: saw `transactionType: PURCHASE` and `SETTLE`
  (a settlement op, `Declined`, reasonCode 1126). The poller must filter by
  `transactionType` and treat unknown types as ignorable-but-logged.
- **`CHECK_STATUS` trap**: for an orderReference that TRANSACTION_LIST had just returned,
  CHECK_STATUS answered `reasonCode 1127 "Order Not Found"` **with
  `transactionStatus: "Declined"`**. Branch on `reasonCode` first; `transactionStatus`
  alone lies for not-found. Consequence: CHECK_STATUS is not a reliable confirmation
  layer for journal entries — TRANSACTION_LIST is the source of truth.
- No `recToken` in the journal (also verified in docs) — the poller cannot harvest tokens.
- **Window cap is real and exactly 31 days** (probe 2026-07-13): spans > 31d fail with
  `reasonCode 1109 "Format Error.dateEnd:Period shall not exceed 31.041666666667 days"`
  (31d + 1h grace). Historical windows are accepted arbitrarily far back (probed to 2014),
  so **backwards backfill in ≤31d chunks is possible**; journal retention depth is unknown.
- **Test account ignores date filters**: 1-day windows in 2014/2020 return the same two
  2025 transactions — the shared demo account serves a canned journal. Real filtering
  behavior must be validated on the production merchant account, and the client must
  **defensively filter returned rows to the requested window** (out-of-window rows are
  deduped by the idempotency key anyway).
- **Identity fields for CRM matching are populated on payment rows** (probe 2026-07-13):
  a `PURCHASE` row carried `email`, `phone`, `clientName`, `clientEmail`, `clientPhone`,
  and masked `cardPan` (`50****0000`); the `SETTLE` row had them empty/null.
  **Production correction** (analytics recon): on the real account `email`/`phone` are
  often EMPTY — the test account misleads here. Matching ladder for incoming legacy
  payments: (1) parse `_WFPREG-<regularId>-<n>` from the orderReference → original ref →
  CRM record (deterministic; proven 100% on primary payments via
  `orderReference == SendPulse orderId`), (2) normalized email/phone when present
  (probe format `380…` without `+` — normalize to E.164), (3) masked PAN + amount +
  cadence as a weak heuristic, (4) FR-009 quarantine with operator binding as the
  designed fallback.

## Reference implementation: metatech/analytics (READ THIS FIRST)

`~/Projects/metatech/analytics` already solved this problem for the analytics importer,
**validated against the real production merchant account** (nexttickit; recon docs
`docs/recon/wayforpay-api-surface.md` + `docs/recon/live-findings.md`, live data
2026-07-05; client code `packages/clients/wayforpay/`). Port, don't reinvent. Facts it
established on production data that override earlier assumptions here:

- **Refund = separate journal row** (`transactionType: REFUND`, own `createdDate`, same
  orderReference); the original PURCHASE status did NOT change in 36/36 cases. Late
  refunds land in the current polling window at their own date — no re-scan of old
  windows needed for them.
- **Their proven event identity**: `orderReference|transactionType|createdDate`
  (`external-id.ts`) — supersedes this spec's earlier `orderReference+status` key.
- **Recurring reference format decoded**: WFP-initiated charges use
  `<originalRef>_WFPREG-<regularId>-<chargeNumber>` (also `invoice_<ts>_WFPREG-…`;
  chargeNumber can be non-integer, e.g. `1.1`). Parser: `subscription-registry.ts`
  (`/^(.+)_WFPREG-(\d+)-(.+)$/`). The subscription registry is built by parsing the
  statement — 796 unique regularIds found, up to 23 charges each (incl. Declined retries).
- **CRM matching is orderReference-first, NOT email/phone**: on production data W4P
  `email`/`phone` are often EMPTY (test account misleads here). Primary payments:
  W4P `orderReference` == SendPulse payment `orderId` (UUID), fill rate 100%, 84/84
  matched. Renewals: parse `_WFPREG-` → original ref → deal/contact. Beware SendPulse
  **echo-deals**: each successful WFP CHARGE spawns a NEW SP deal+payment with a fresh
  UUID that never existed in W4P — dedupe renewals against CHARGE rows or revenue counts
  double.
- **regularApi works in production**: `merchantPassword` is valid and already available
  to the org (analytics project env `WAYFORPAY_MERCHANT_PASSWORD`) — the "phase 2
  credential blocker" is soft. `reasonCode 4100` = Ok, `4107` = closed-but-valid (both
  carry subscription state).
- **History depth on the real account**: journal reachable from 2026-03-25; full backfill
  in 30-day chunks yielded 3996 transactions (PURCHASE 2634, CHARGE 1325, REFUND 37).
- **WFP charge batch timing**: daily ~05:30–06:05 UTC, ~4s between charges — poll
  frequency matters most in that window.
- **`baseCurrency` is always UAH** (settlement); transactions are mostly USD — store both
  `amount/currency` and `baseAmount/baseCurrency`.
- **Implementation patterns worth porting verbatim**: contiguous non-overlapping 30-day
  chunks for backfill (`windows.ts`); incremental = re-read the last closed window + new
  range, cursor stores covered range (`import.ts`); permissive response schemas — all
  fields optional, money/dates string-or-number, unknown keys preserved into RAW
  (`types.ts`); typed errors incl. `W4pWindowTooLargeError` (1109) and
  `W4pOrderNotFoundError` (1127) (`errors.ts`); transport-only transient retry + injected
  rate limiter; client as a plain injected interface for trivial test doubles
  (`client.ts`).

## Resolved Decisions (load-bearing — do not re-ask)

### D1 — Journal API and source of truth
`TRANSACTION_LIST` is the journal and the source of truth. No CHECK_STATUS confirmation
pass (see trap above). regularApi `STATUS` is *not* part of the MVP loop (needs the
separate `merchantPassword` credential; see Open Questions).

### D2 — Sliding window with overlap, watermark in Postgres
Poller state = single row (per provider account): `watermark` (epoch seconds of the last
window end we fully processed). Each tick queries
`[watermark - overlap, min(now, watermark + maxWindow)]`, then advances the watermark to
the queried `dateEnd` only after all rows are durably ingested. Overlap absorbs
late-arriving entries (probe showed `processingDate` lagging `createdDate` by ~96s;
docs give no ordering guarantee). Crash-safe: re-ingesting an overlap window is a no-op
thanks to idempotency keys.

### D3 — Event identity (idempotency key)
`w4p:{orderReference}|{transactionType}|{createdDate}` — the key proven in production by
metatech/analytics (`external-id.ts`). One orderReference legitimately yields multiple
rows (PURCHASE and its later REFUND share the ref but differ in type and createdDate);
each is a distinct incoming event, while re-reads of the same row dedupe.
(Supersedes the earlier `orderReference+status` idea, which assumed refunds mutate the
original row — live data shows they don't.)

### D4 — Poller emits, pipeline decides
The poller writes only raw incoming events (docs/09 queue: `raw_events` → `messages`).
Matching to subscriptions, quarantine (FR-009), and outbox events stay in the FR-007
pipeline. The poller has no domain logic beyond field mapping + filtering.

### D5 — Client is hand-rolled, Effect-native
No official Node SDK exists (verified). The WayForPay HTTP client lives in the provider
adapter boundary (`PaymentProvider`, docs/05), implemented as an Effect service like
`Hasher`/`TaskRegistry`, with the signature helper as a pure function unit-tested against
the documented worked example and the probe.

## Constraints the plan MUST honor (from docs 08/09/10/11 + current code)

- Module convention: `packages/backend/src/modules/<name>/` with
  `config.ts / contracts.ts / data-access.ts / domain.ts / errors.ts` (routes optional —
  health is route-only; this module is worker-only). Suggested: `modules/wayforpay/`
  (client + signature + types) consumed by a poller task registered in the worker.
- Dependency direction: api → application → domain; domain must not know HTTP/W4P/Postgres.
- Worker runtime: `src/worker.ts` + `TaskRegistry` seam (currently a skeleton). The poller
  is an `Effect` scheduled loop (`Effect.repeat` + `Schedule`) launched from the worker,
  not a cron process.
- Config via `loadConfig()` pattern: `W4P_MERCHANT_ACCOUNT`, `W4P_SECRET_KEY`
  (`Redacted`), `W4P_API_URL` (default `https://api.wayforpay.com/api`),
  `W4P_POLL_INTERVAL_SECONDS`, `W4P_WINDOW_OVERLAP_SECONDS`, `W4P_MAX_WINDOW_SECONDS`.
- Migrations: numbered files like `src/migrations/0001_auth.ts` → `000N_w4p_poller.ts`
  (poller state + raw incoming events tables, if FR-007 tables don't exist yet).
- NFR: client-side rate limiter around every W4P call (03-nfr); no documented server
  limits exist, so be conservative and make it configurable.
- Testing, two tiers like auth: unit tests with a stubbed transport (signature vectors,
  window arithmetic, dedupe, 1127 branch, SETTLE filtering, string parsing); optional
  gated e2e against the shared test merchant (it is public and noisy — assert mechanics,
  not data).

## Proposed Scope / Deliverables

1. `modules/wayforpay/`: signature helper (pure), request/response contracts (probe-true:
   string decimals, string epochs, unknown-field tolerant), Effect client service
   (TRANSACTION_LIST first; CHARGE/CHECK_STATUS shapes stubbed for later flows).
2. Poller task: window arithmetic + watermark persistence + filter/map to raw incoming
   events + metrics counters (freshness = `now - max(processingDate)` seen; lag gauge;
   per-tick ingested/duplicate/skipped counts).
3. Migration for `w4p_poller_state` (+ raw event table if FR-007 hasn't landed).
4. Worker wiring via TaskRegistry (or directly in worker main until the dispatcher is real).
5. Unit tests incl. signature test vector from official docs worked example.

## Open Questions (planner to resolve; recommended default in **bold**)

1. Poll cadence / overlap / max window: **tick 120s, overlap 900s, max window 6h**
   (FR-008 says "every few minutes"; no documented caps — stay conservative).
2. Migration-tail metric needs regularApi `STATUS` per legacy recurrent, which needs
   `merchantPassword` (second credential, not yet provisioned): **phase 2, separate
   task**; MVP ships freshness metrics only.
3. Raw event storage: reuse FR-007 tables if the pipeline lands first, else create
   provider-agnostic `incoming_payment_events` now: **create now, pipeline consumes later**
   (poller is the first event source; unblocks FR-007 shape).
4. Backfill on first run (watermark bootstrap): **start from deploy time minus 24h for
   the steady-state loop, plus a separate operator-triggered backfill task** that walks
   backwards in ≤31-day chunks (cap empirically confirmed, rc=1109 beyond it) until the
   journal is exhausted or a configured horizon is hit. Backfill reuses the same
   ingest/dedupe path, so it can run before, after, or concurrently with the live poller.
   Retention depth is unknown — the backfill must treat "N consecutive empty chunks" as
   the stop signal and record the deepest reachable date as a metric.
5. Current-state scan at cutover: there is **no list-all API** for regular subscriptions,
   and the workaround is **proven in production** (analytics `subscription-registry.ts` +
   `import.ts`): parse `_WFPREG-<regularId>-` out of the backfilled journal (796 unique
   regularIds found), then regularApi `STATUS` per original orderReference
   (`4100` Ok / `4107` closed — both valid) to get
   `mode/nextPaymentDate/lastPayedDate/lastPayedStatus`. The `merchantPassword` needed
   for regularApi **already exists in the org** (analytics env
   `WAYFORPAY_MERCHANT_PASSWORD`) — get it into this project's secrets, then this is no
   longer phase 2.

## Acceptance Criteria (sketch)

- Signature helper reproduces the official docs' worked example hash and the probe's
  accepted signatures.
- Ticks are idempotent: replaying any window produces zero new events.
- A status change on a known orderReference produces exactly one new event.
- `SETTLE`/unknown transaction types are skipped and counted, never ingested as payments.
- reasonCode≠1100 responses raise typed errors (`W4pApiError`), never partial ingestion;
  watermark does not advance on failure.
- Freshness metric exposed; poller survives W4P downtime (retry with backoff, bounded).

## Risks

- Shared/undocumented behavior: no documented rate limits, window caps, or pagination —
  a huge window could truncate silently (unverifiable). Mitigation: small `maxWindow`,
  monitor per-tick counts, ask WFP support (gaps list in docs/14).
- Journal completeness for WFP-initiated recurring charges is asserted by docs/00-tz §7
  operationally but not provable from public docs; validate against the real merchant
  account's journal during rollout before trusting it for user-facing state.
- Shared test account is public: e2e assertions must not depend on its data.
