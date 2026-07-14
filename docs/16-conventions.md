# Engineering Conventions (project-wide decisions)

These are the cross-cutting rules the codebase is held to. They were distilled
from review feedback on the `auth` and payments modules and apply to every module
that follows. Where a rule supersedes an earlier spec/plan, that is noted.

## 1. Comments answer WHY, not WHAT

- WHAT is carried by the name, the structure, and the file location; HOW is carried
  by the function body. A comment exists only for a WHY that none of those can
  express — and, in rare extreme cases, a HOW note when the body is unavoidably
  subtle.
- No file-header / banner comments. Comment an entity (a class or a function) only
  when there is a non-obvious reason a reader needs.
- If a comment restates the name, the structure, or the body, delete it.

## 2. Domain code takes domain commands — never transport types

- Domain functions accept plain domain **commands** (derived types), never a
  Fastify `Body` / `Request` / `Headers` / a raw header string.
- The transport layer (routes) decodes the HTTP request into a command and hands
  that to the domain. Header parsing, status codes, and encoding stay in routes.

## 3. Authorization is a domain concern

- Role checks live in the domain as `requireRole(actor, role)` and fail with
  `Forbidden`. The transport only extracts the credential and resolves it to an
  `Actor`; it never decides authorization on its own.

## 4. No production code that exists only for tests

- We do **not** ship in-memory repositories, fakes, or branches that only run
  under test. Test the code that actually deploys.
- Unit-test everything **pure or free of external resources** (the real `Hasher`
  is pure crypto, so it is fair game). Behavior bound to an external resource
  (Postgres) is covered by **integration / e2e** tests against the real thing.

## 5. Test placement

- `packages/backend/src/modules/{name}/test/` — tests next to the code they
  cover: `*.test.ts` unit/integration (run by `npm test`, hermetic, no Postgres)
  and `*.e2e.ts` scenarios (run only by the e2e runner, never by `npm test` —
  the unit gate globs `*.test.ts`, not `*.e2e.ts`).
- `packages/backend/test/e2e/` — the e2e runner harness (`run.ts`), invoked by
  `npm run test:e2e`; it loads each module's `*.e2e.ts` scenarios.
- Test files never ship: the build tsconfig excludes `src/**/*.test.ts` and
  `src/**/test/**`.
- Supersedes the "in-memory `AuthRepo` test layer" tier described in
  docs/12 (D5) and docs/13.

## 6. `shared` is sliced by entity

- `packages/shared/src/schemas/{entity}.ts` owns **all** of that entity's data:
  its schemas, the enums it owns, and its constants. There is no separate
  `enums/` or `constants/` bucket.
- Every enum and constant is owned by exactly one entity (e.g. `Role` → auth,
  `PaymentMethod` / `Currency` → subscription, `RETRY_SCHEDULE_DAYS` →
  subscription, `SINK_DELIVERY_SLA_SECONDS` → event).
- Types are always **derived** from schemas; never hand-written.
- A **public** shape — anything that crosses a boundary (an API request/response, a
  domain event, a persisted entity) — lives in its shared entity slice, never in a
  module. A module's `contracts.ts` is only for shapes that must NOT be public, e.g.
  auth's secret-carrying request bodies (`Redacted` passwords/tokens), which stay
  backend-only (docs/13).

## 7. Errors own their HTTP mapping

- Reusable typed errors live in `packages/backend/src/infra/http/errors.ts` and
  each exposes `toHttp()`. Transport maps any failure with the single transform
  `toHttp?.() ?? { status: 500 }` (see `infra/http/reply.ts`), so an unmapped
  error (SqlError, HashError, a defect) always collapses to 500.

## 8. Routes are declared with the colocated DSL

- A route's method, path, input schema, output schema, and Effect handler are
  declared together via `makeRoute(runtimeOf)` → `route(fastify, def)`
  (`infra/http/route.ts`). The helper decodes the body (400 on a schema miss),
  runs the handler on the module's runtime, encodes the result, and maps errors
  through `toHttp`. It is runtime-agnostic and reused across modules.

## 9. Derived, not duplicated, types

- Reuse via `Omit` / `Pick` / `Schema.extend` / unions. A backend row is the
  public shape plus its secret (`OperatorRow = Operator & { passwordHash }`); a
  request is the public create shape plus its secret
  (`CreateOperatorRequest = Schema.extend(CreateOperator, { password })`).
- Never hand-write an interface that mirrors a shape that already has a schema;
  derive it (`NewCheckoutSession = CheckoutSession.omit(...)`).
- A SQL column list is derived from the schema's keys (`columnList(Schema.fields)`),
  not hand-typed — one source of truth for a table's columns, so the SQL cannot drift
  from the schema.

## 10. Shapes that vary by a discriminant are a discriminated union

- When a value's fields are determined by a kind/name/tag, model it as a
  discriminated union (a `Schema.Union` of per-variant structs, or a TS union) — not
  a wide base with optional fields or a `payload: Record<string, unknown>`. The type
  system then enforces each variant and consumers narrow on the discriminant. So it
  is with `DomainEvent` (on `name`, docs/07), `MatchResult` (on `matched` / `kind`),
  and the typed errors (on `_tag`, via `Data.TaggedError`).
- Carve-out: a deliberately OPAQUE payload stays `Record<string, unknown>` — raw
  provider data kept verbatim (`IncomingPaymentEvent.payload`, the WayForPay callback
  body and the purchase form) and an event read back from storage for delivery
  (`StoredEvent`: after a jsonb round-trip the sink only forwards the stored payload,
  so it is not re-narrowed). These are boundary bags, not domain shapes to
  discriminate.

## 11. Domain steps are functions, not injected services

- A domain step (a matcher, an applier, …) is a plain function the domain calls; its
  type lives in the module, its implementations are composed as plain values and
  passed in as parameters. Reach for a `Context.Tag` + `Layer` only for a real
  runtime resource (Sql, the queue, the outbox) or a genuine swap boundary —
  pluggability alone (AC8) is satisfied by passing a function.

## 12. Provider-specific code lives in the provider module

- A payment provider's details — request signing, callback parsing, the hosted
  Purchase form, the API client — live in that provider's module (`wayforpay`; a
  future `whitepay`). The `checkout` module and the FR-007 pipeline stay
  **processor-agnostic**: they orchestrate and import the provider surface, never
  embed it. A new provider is a new module exposing the same shape (AC8), not edits
  scattered across `checkout` / `payments`.

## 13. Extract shared logic; keep domain functions in `domain.ts`

- Logic used by more than one module is extracted to a common home under `infra/`,
  never copy-pasted per module (e.g. `requireRow` and the Postgres error mapping in
  `infra/db`).
- A module's domain functions — matchers, appliers, event builders — live in its
  `domain.ts`. Add a separate file only for a genuinely distinct concern, not for a
  single function.
