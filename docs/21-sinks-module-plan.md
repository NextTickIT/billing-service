# docs/21 — Sinks module: operator-managed config + real SendPulse connector

**Status:** `pending approval` (RALPLAN consensus). Extends docs/07 (events/outbox), honors
CLAUDE.md §3 conv.12 (connector code stays in its module), §5 (secrets redacted), §9
(operator auth), AC8 (new sink = no core change).

## 1. Goal

Today the only sink is a stub: `infra/sinks.ts` `loggingSink` (named `sendpulse`, always
on, just logs). Deliver three things:

1. A **real SendPulse sink** that, per outgoing event, runs a SendPulse Telegram **flow**.
2. An operator-console **"Sinks" module** — the arsenal of connected sinks — where each
   sink is configured: `enabled`, a **write-only auth token**, and a map of
   **{event → flow_id}**.
3. **Hot reload**: an operator config change takes effect on running workers **without a
   restart**.

## 2. RALPLAN-DR summary

**Principles**
- P1 — **Config is data, not deploy.** Sink enablement/token/flow-map live in the DB and
  are operator-editable; no redeploy to change routing.
- P2 — **The core never learns a provider.** SendPulse HTTP/auth/shape live only in
  `modules/sinks/sendpulse.ts`; the outbox stays provider-agnostic (conv.12, AC8).
- P3 — **At-least-once, fail-visible.** Delivery keeps the durable-queue guarantees; a sink
  failure is recorded for the operator and retried; a permanent failure is terminal, not an
  infinite loop.
- P4 — **Secrets are write-only.** The token is never returned by an API, never logged;
  editing other fields never wipes it.
- P5 — **Schema is the source of truth.** Public shapes in `packages/shared`; numeric enums
  at rest; types derived.

**Decision drivers (top 3)**
1. **Hot-reload with bounded cost.** `Sinks.all()` is on the publish + every-retry path
   (`outbox/domain.ts:44,79`); reading DB every call is correct but hot. → short-TTL cache.
2. **SendPulse run-flow is not idempotent.** No idempotency key; a redelivered flow-run
   sends a second message. Retry classification + the crash-window must be bounded/accepted.
3. **Operator-owned secret.** Write-only token round-trip (GET hides, PUT preserves) drives
   both the schema split and the repo upsert semantics.

**Viable options (decided inline; alternatives invalidated)**
- **Config freshness:** (A) DB read per call — simplest, but a query per event/retry;
  (B) **short-TTL in-memory cache keyed on `max(updatedAt)` [CHOSEN]** — config visible in
  ≤ TTL (default 10 s) with ~zero hot-path DB cost; (C) push/pubsub invalidation — most
  complex, unneeded at this scale. *B chosen: meets "recalculate config" (seconds) without
  regressing the 100k-due-same-day drain.*
- **Publish gating:** (A) **gate at publish — only enabled sinks get a delivery row
  [CHOSEN]**; (B) always record + a new `skipped` status. *A chosen: `DeliveryStatus` is
  `pending|delivered|failed` (no `skipped`); recording deliveries for disabled sinks
  pollutes the operator log. Consequence: enabling a sink does not backfill past events
  (out of scope; acceptable).*
- **Sink vocabulary:** single `Schema.Literal('sendpulse')` **[CHOSEN]**, widened to a union
  when a second sink lands (a new row + a new `buildConnectors` case — AC8). Open string rejected
  (loses exhaustiveness on the flow map + builder).

## 3. Confirmed behavior + LOCKED decisions

- SendPulse sink **enabled by config**; config = write-only `sp_apikey_***` token + a
  {eventName → flowId} map.
- On delivery: `POST https://api.sendpulse.com/telegram/flows/run`,
  `Authorization: Bearer <sp_apikey_***>`,
  `{ contact_id: <externalUserId>, flow_id: <flows[event.name]>, external_data: { ...event.payload, event, event_id } }`.
- **LOCKED (1):** auth = static `sp_apikey_***` used directly as Bearer (no OAuth refresh).
- **LOCKED (2):** send the full event payload as `external_data`, plus the event name
  (`event`) and `event_id`, so a flow reached by more than one event can branch/dedupe
  (flow reads `{{$['amount']}}`, `{{$['event']}}`).
- **`externalUserId` is the SendPulse `contact_id`** (caller contract — §7).

Source: SendPulse Telegram run-flow `POST /telegram/flows/run` — `contact_id` (req),
`flow_id` (req), `external_data?`; Bearer with the `sp_apikey_***` key from Settings→API.

## 4. Design

### 4.1 Data model — migration `0011_sinks.ts`
Generic, discriminated-union shape so a future sink is a new `kind` + new `config`/`auth`
variant, no schema change (AC8). `kind` is a **numeric enum at rest** (§5); `auth` and the
sink-specific `config` are jsonb discriminated unions.
```sql
CREATE TABLE sinks (
  kind        smallint    PRIMARY KEY,                    -- numeric SinkKind (0 = sendpulse)
  enabled     boolean     NOT NULL DEFAULT false,
  auth        jsonb       NOT NULL DEFAULT '{"kind":0}',  -- SinkAuth DU (default Bearer, token unset)
  config      jsonb       NOT NULL DEFAULT '{}',          -- sink-specific: SendPulse = { "flows": { "<event>": "<flowId>" } }
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sinks (kind, enabled) VALUES (0, false) ON CONFLICT DO NOTHING;
```
The stable string **code** (`'sendpulse'`) is derived from `kind` via `SinkKindCode` (mirrors
`CurrencyCode`) and is what `event_deliveries.sink` keeps and what the connector reports — so
the outbox/delivery contract and its data are **unchanged** (no delivery-table migration).

### 4.2 Shared — `schemas/sink.ts` (register in `schemas/index.ts`)
**Numeric enums (stored as numbers, `Schema.Enums` — §5):**
- `SinkKind { SendPulse = 0 }`; `SinkKindCode: Record<SinkKind, string> = { [SendPulse]: 'sendpulse' }`
  (the stable code for `event_deliveries.sink` + route paths; `codeToKind` reverse).
- `AuthKind { Bearer = 0 }` (extensible: OAuth, Basic, … later).

**Auth — a DU on `kind`, stored as jsonb (extensible strategies):**
- `BearerAuth = { kind: Schema.Literal(AuthKind.Bearer), token: Schema.Redacted(Schema.String) }`.
- `SinkAuth = Schema.Union(BearerAuth)` (default variant = Bearer).
- Public `SinkAuthView = { kind: AuthKind.Bearer, hasToken: boolean }` — **no secret**.

**Sink-specific config (per `kind`):**
- `SinkFlowMap = Schema.partial(Schema.Record({ key: EventName, value: Schema.String }))` — keys
  are event names, values are flow ids.
- `SendPulseConfig = { flows: SinkFlowMap }`.

**Sink entity — a DU on `kind`** (the persisted, operator-editable record):
- `SendPulseSink = { kind: Schema.Literal(SinkKind.SendPulse), enabled, auth: SinkAuth, config: SendPulseConfig, updatedAt }`.
- `Sink = Schema.Union(SendPulseSink)`.
- **Naming:** this shared `Sink` (config entity) is distinct from the runtime connector — rename
  the infra connector `Sink → SinkConnector` (`{ name, deliver }`, `name` = the code) to free the name.

**Views / requests (DU on `kind`):**
- `SinkView` (public read): the entity with `auth → SinkAuthView` (**token stripped**).
- `UpdateSinkRequest` (write): `{ enabled?, auth?, config? }`; inside `auth`, `token` is optional
  — absent/empty ⇒ **keep** the stored token (write-only; merged in the domain, §4.3).
- `SinkFlow` (picker item): `{ id, name, botName }`; `SinkFlowsResponse = Schema.Array(SinkFlow)`.

### 4.3 Backend `modules/sinks/`
- **`data-access.ts`** — `SinksRepo` keyed by numeric `kind`: `listWithSecret()` /
  `getWithSecret(kind)` (decode jsonb `auth`/`config` to the DU), `write(kind, sink)` (whole-row
  upsert of the merged entity), `maxUpdatedAt()` (for the cache). Rows are the `Sink` DU.
- **`domain.ts`** — pure functions:
  - `mergeUpdate(current, patch): Sink` — apply `UpdateSinkRequest`; **write-only token merge**:
    if `patch.auth.token` is empty/absent, keep `current.auth.token`. (Merge in the domain, not
    a jsonb-COALESCE.) Route does read → `mergeUpdate` → `write`.
  - `toView(sink): SinkView` — strip the token (`auth → { kind, hasToken }`).
  - `buildConnectors(sinks, deps): SinkConnector[]` — each **enabled** `Sink` → a connector
    whose `name = SinkKindCode[kind]` (so `event_deliveries.sink` is unchanged). Only
    `SinkKind.SendPulse` today.
- **`sendpulse.ts`** — provider code (conv.12): `makeSendPulseConnector({ token, flows, fetch,
  rateLimiter }): SinkConnector` (`name = 'sendpulse'`). `deliver(event)`:
  - `externalUserId === null` → success no-op (quarantine events never target a contact).
  - `flowId = flows[event.name]`; missing → success no-op (event not mapped).
  - else rate-limited `POST /telegram/flows/run` with `Authorization: Bearer <token>`,
    `{ contact_id: externalUserId, flow_id, external_data: { ...payload, event, event_id } }`; non-success → `SinkError` (§4.5).
  - Also `listFlows(token)` (operator picker): `GET /telegram/bots` → for each **active** bot
    `GET /telegram/flows?bot_id=…` → merge active flows to `{ id, name, botName }`; typed errors.
- **`routes.ts`** — operator-guarded (reuse `operatorActor` from `quarantine/routes.ts`:
  `assertBffSecret` + session token + `requireRole(Operator)`). Path uses the code string,
  resolved to `kind` via `codeToKind`:
  - `GET /api/sinks` → `SinkView[]` (never a token).
  - `PUT /api/sinks/:code` → `UpdateSinkRequest`; read → `mergeUpdate` → `write`; **audited**
    (`insertAudit`, detail excludes the token).
  - `GET /api/sinks/:code/flows` → `SinkFlowsResponse` — reads the **stored** token
    (`getWithSecret`, server-side only) and returns `listFlows()`. `409/422` if no token; a
    SendPulse auth failure is surfaced. Runs on `app.runtime` (has `SqlClient`) via
    `globalThis.fetch` — no SendPulse layer added to the API runtime (low-frequency action).

### 4.4 Hot-reload `Sinks` service (replaces `LoggingSinkLive`)
`SinksLive` lives in **`modules/sinks/`**, not `infra/sinks.ts`: infra defines the `Sink`
*port*; the module provides the SendPulse *adapter* and this composed service (infra must not
import a module — layering). Built at layer construction: capture `SqlClient`, and build the
`fetch` + `RateLimiter` **once** (stable). It holds a `Ref<{ builtAt, sinks }>`; `all()` returns
the cache unless older than `SINKS_CACHE_TTL_MS` (default 10 000 ms), in which case it re-reads
`SinksRepo` and rebuilds via `buildConnectors` — passing the **stable** fetch/limiter and only the
fresh per-sink `{token, flows}` (from the decoded `Sink` DU), so a rebuild never allocates a new
limiter (no leak). `all()` keeps its `() => Effect<readonly SinkConnector[]>` signature (built via
`buildConnectors`): `SqlClient` is closed over (not in `R`), and a
read error becomes a **defect** (`orDie`) so the enclosing publish/deliver retries rather than
silently delivering to zero sinks. Because publish + every delivery retry call `all()`, an
operator change is live within one TTL — no restart, no per-event DB hit on cache hits. Wire in
`runtime.ts` `makeWorkerLayer` (swap `LoggingSinkLive → SinksLive` + a SendPulse fetch/limiter
layer). Keep `loggingSink`/`LoggingSinkLive` in `infra/sinks.ts` for tests + dev.

### 4.5 Failure handling (no core outbox change)
`deliverEvent` already re-fails on ANY `SinkError` and lets the durable queue retry up to
`maxAttempts` (`outbox/domain.ts:88-97`; queue default 5), recording each failure for the
operator. So the SendPulse sink maps every non-success (network / 429 / 5xx / semantic 4xx /
`success:false`) to `SinkError` and relies on that bounded retry — **no per-error
terminal/transient split**, which would require changing the shared `deliverEvent` (against
P2 / conv.12). This is a feature, not a bug: a bad token the operator fixes within the retry
window **auto-recovers** on the next attempt; a genuinely bad `flow_id`/`contact_id` simply
exhausts `maxAttempts` and goes terminal (bounded, visible in the delivery log + undelivered
alert). A per-error terminal classification is a possible **future outbox enhancement**, out
of scope here.

## 5. Idempotency & the double-run window (accepted risk)
The outbox already dedups on `event.id` (publish) and `delivery.id` (queue idemKey), so an
event never fans out twice. Normal retries fire only on **failure** (nothing was sent).
The one double-run vector is a crash **between** SendPulse returning 200 and `markDelivered`
— the reaper then redelivers and the flow runs twice (a duplicate Telegram message). SendPulse
run-flow has **no idempotency key**, so this window can't be closed server-side. **Decision:**
accept it (rare, crash-only), and pass `event_id` in `external_data` so a flow *may* dedupe.
Documented against docs/07 ("sinks idempotent on their side").

## 6. Frontend operator module `modules/sinks/`
Mirror `payments`/`quarantine`: `SinksPage.vue`, `api.ts` (apiFetch/BFF), `routes.ts`
(`/operator/sinks`), nav link in `OperatorLayout.vue`, en/ru/uk i18n (missing key fails build —
AC17). Page behavior:
- A write-only **token** field ("token set — replace?"), an **enabled** toggle, and one
  flow-selector per **mappable event** (mappable events **exclude `unknown_payment_quarantined`**
  — null `externalUserId`, no contact; the sink skips it anyway).
- **Token gates the flow selectors.** While `auth.hasToken` is false the flow selectors are
  **disabled** with a hint "set the SendPulse token first" — we can't list flows without it.
- **After the token is set** (operator saves it → `auth.hasToken` true), the page calls
  `GET /api/sinks/sendpulse/flows` and the selectors **activate** as a **text-search combobox**
  (typeahead) over the fetched `{ id, name, botName }` list: the operator types to filter by
  flow name and picks one; the stored value is the `flow_id`, the label shows the name. A
  stored `flow_id` no longer present in the list renders as its raw id + a "flow not found"
  hint. A SendPulse error (e.g. bad token) shows an inline error and leaves selectors disabled.
- New component `BaseCombobox.vue` (searchable single-select; `BaseSelect` is not filterable) —
  or extend `BaseSelect` with a `searchable` mode. Agnostic, in `components/` (AC16).

## 7. Caller contract (document in CRM notes)
`externalUserId` MUST equal the SendPulse **`contact_id`** (SendPulse's internal id, not the
raw Telegram id). The bot passes the contact's SendPulse id as `externalUserId` to
`POST /api/checkout-sessions`; it is carried verbatim (AC9) and used as `contact_id`. A wrong
id yields a terminal delivery failure (§4.5) visible to the operator.

## 8. Pre-mortem (3 scenarios + mitigations)
1. **Duplicate "renewed" message.** Crash after SendPulse 200, before `markDelivered` →
   reaper re-runs the flow. *Mitigation:* accepted risk (§5); `event_id` in `external_data`
   for flow-side dedupe; monitored via delivered-vs-attempt counts.
2. **Token leak / wipe.** A GET returns the token, or a flows-only PUT nulls it, or it lands
   in a log. *Mitigation:* `SinkView` strips the token (`auth → {kind, hasToken}`); the domain
   `mergeUpdate` keeps the stored token when the patch's is empty; token wrapped `Redacted`,
   never logged; e2e asserts GET body ∌ token and PUT-without-token preserves it.
3. **Retry churn on a bad token/flow.** Every event fails → the queue retries. *Mitigation:*
   bounded by `maxAttempts` (default 5) + the SendPulse rate limiter caps req/s; each failure
   is recorded and the failed-delivery alert fires; after `maxAttempts` the delivery is
   terminal (no infinite loop). A token fixed within the window auto-recovers on the next retry.

## 9. Expanded test plan
- **Unit (hermetic, injected `fetch`):** `makeSendPulseConnector` runs `config.flows[name]`
  with `contact_id = externalUserId` + `external_data = payload`; skips null-user and unmapped
  events (success no-op); any non-success (429/5xx/4xx/`success:false`) → `SinkError`.
  Write-only: `toView` omits the token; `mergeUpdate` without a token preserves it. Cache:
  `all()` rebuilds after TTL / not before (fake clock).
- **Integration (ManagedRuntime, connection-light):** `GET/PUT /api/sinks` decode/encode +
  `requireRole` → 403, missing bearer → 401, missing BFF secret → rejected; audit row written.
- **E2E (real Postgres):** seed `sinks` enabled + flow map + a stub flows/run server;
  publish `payment_succeeded` → one `event_deliveries` row → delivery POSTs `flows/run` with
  the right `contact_id`/`flow_id`; flip a flow_id via `PUT` and assert the **next** delivery
  uses it within the TTL (hot reload); disabled sink → no delivery row; terminal 4xx →
  `status='failed'`, no infinite retry.
- **Observability:** delivery success/fail counters per sink; failed-delivery queue has its
  alert (docs/03); logs carry `sink`, `event`, `eventId` but never the token or payload PII.

## 10. Files
- **New:** `migrations/0011_sinks.ts`; `shared/src/schemas/sink.ts`;
  `modules/sinks/{data-access,domain,sendpulse,routes,live}.ts` + `test/` (`live.ts` = `SinksLive`);
  frontend `modules/sinks/{SinksPage.vue,api.ts,routes.ts,store.ts}` + `components/BaseCombobox.vue` + i18n.
- **Changed:** `shared/schemas/index.ts`; `runtime.ts` (swap `LoggingSinkLive → SinksLive` +
  SendPulse fetch/rate-limiter layer); `OperatorLayout.vue`; locale files; `.env.prod.example`
  (`SENDPULSE_RATE_LIMIT_RPS`, `SINKS_CACHE_TTL_MS`); `infra/sinks.ts` — **rename** the runtime
  connector interface `Sink → SinkConnector` (+ `loggingSink: SinkConnector`); the port stays in
  infra. The rename is contained (the outbox uses `Sinks`/`SinksService`/`SinkError`, not the
  `Sink` type name, so `outbox/domain.ts` needs no change).

## 11. ADR
- **Decision.** DB-backed, operator-editable `sinks` table where the persisted `Sink` is a
  **discriminated union on a numeric `kind`** (pluggable `auth` = a DU on `AuthKind`, jsonb,
  default `Bearer{token}`; sink-specific `config`, SendPulse = a `{event→flowId}` map),
  decoupled from the runtime `SinkConnector`. A SendPulse connector confined to
  `modules/sinks/sendpulse.ts` runs the flow with the Bearer token, `contact_id = externalUserId`,
  `external_data = payload`; a `SinksLive` service (in `modules/sinks/`) hot-reloads via a
  short-TTL cache over a stable fetch/limiter; write-only token (domain merge); **all failures
  retried by the queue to `maxAttempts`** (no core outbox change); operator UI at `/operator/sinks`.
- **Drivers.** Hot-reload on a hot path (→ TTL cache, stable limiter); non-idempotent run-flow
  (→ bounded accepted double-run); operator-owned secret (→ write-only round-trip).
- **Alternatives considered.** DB-read-per-call (rejected: hot-path cost); OAuth token
  (rejected: refresh complexity, static key suffices); always-record + `skipped` status
  (rejected: enum churn, log noise); open sink-code string (rejected: loses exhaustiveness);
  per-error terminal/transient split (rejected: needs a core `deliverEvent` change; bounded
  queue retry already recovers a fixed token and caps a bad one).
- **Consequences.** Config changes are visible within the cache TTL, not instantly; enabling
  a sink does not backfill past events; a crash-window duplicate message is possible; a bad
  token/flow burns up to `maxAttempts` retries before going terminal; adding a sink is a new
  row + a `buildConnectors` case + a widened `SinkKind` DU (no core change, AC8).
- **Follow-ups.** SendPulse rate limit value (confirm with SendPulse); optional per-sink
  delivery metrics screen; consider a manual "re-drive failed deliveries" operator action.

## 12. Decisions (all resolved)
1. Auth — **static `sp_apikey_***` Bearer.**
2. `external_data` — **send full event payload** (+ `event_id`).
3. Publish gating — **gate at publish** (§2 options).
4. Rate limiting — **yes**, reuse the `RateLimiter` infra (`SENDPULSE_RATE_LIMIT_RPS`).
5. Sink vocabulary — one kind today (`SendPulse`); widen the DU + `SinkKindCode` per new sink.
6. Config freshness — **short-TTL cache** over a stable fetch/limiter (`SINKS_CACHE_TTL_MS`, default 10 s).
7. Failure handling — **all non-success → `SinkError`, retried by the queue to `maxAttempts`**
   (no core outbox change); per-error terminal split deferred.
8. `SinksLive` placement — **`modules/sinks/`** (module = adapter), not `infra/sinks.ts` (port).
9. Sink identity — **numeric `kind` enum at rest** (`name`→`kind`, §5); a stable `SinkKindCode`
   string (`'sendpulse'`) keeps `event_deliveries.sink` + route paths unchanged.
10. Sink shape — **discriminated union on `kind`**: pluggable `auth` (DU on `AuthKind`, jsonb,
    default `Bearer{token}`) + sink-specific `config` (SendPulse = `{ flows: EventName→flowId }`);
    the runtime connector is renamed `SinkConnector`.

## 13. Acceptance criteria (testable) + verification
- **AC-S1** operator `PUT /api/sinks/sendpulse {enabled, auth:{token}, config:{flows}}` persists;
  `GET` returns `SinkView` with `auth.hasToken=true` and **no token**. (integration)
- **AC-S2** a config-only `PUT` (no `auth.token`) **preserves** the stored token (`auth.hasToken`
  stays true). (unit + integration)
- **AC-S3** with the sink enabled + `flows.payment_succeeded=F`, publishing `payment_succeeded`
  POSTs `…/telegram/flows/run` exactly once with `contact_id=externalUserId`, `flow_id=F`,
  `external_data` = the event payload. (e2e, stub server)
- **AC-S4** changing `flows.payment_succeeded` via `PUT` makes the **next** delivery use the
  new flow within `SINKS_CACHE_TTL_MS`. (e2e — the hot-reload proof)
- **AC-S5** an event with `externalUserId=null` (quarantine) and an event with no mapped flow
  are **not** sent (delivery marked delivered as a no-op). (unit)
- **AC-S6** a 5xx/429/network from SendPulse re-fails → the queue retries; success then marks
  the delivery `delivered`. (unit + e2e)
- **AC-S7** `requireRole` matrix on `/api/sinks`: operator 200, foreign token 403, no cookie
  401, missing BFF secret rejected. (integration)
- **AC-S8** the token never appears in logs or the audit `detail`. (unit — assert redaction)
- **AC-S9** flow selectors are **disabled** while `auth.hasToken=false`; after a token is saved
  they activate. (frontend component test)
- **AC-S10** `GET /api/sinks/sendpulse/flows` returns the merged bots→flows list
  `{ id, name, botName }` using the **stored** token (token never sent to the client); `409`
  when no token is set; operator-guarded (401/403 matrix). (integration, stub SendPulse)
- **AC-S11** with flows loaded, typing filters the list by name and selecting stores the
  `flow_id` (label shows the name); a stored id absent from the list shows "flow not found".
  (frontend component test)
- **Verification gates:** `npm run typecheck && npm run lint && npm test`, then the e2e runner
  against Docker Postgres for AC-S3/4/6; a `critic`/`code-reviewer` pass per phase (separate
  lane, no self-approval).
