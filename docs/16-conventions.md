# Engineering Conventions (project-wide decisions)

These are the cross-cutting rules the codebase is held to. They were distilled
from review feedback on the first real module (`auth`) and apply to every module
that follows. Where a rule supersedes an earlier spec/plan, that is noted.

## 1. Comments answer WHY, not WHAT

- No file-header / banner comments. Comment an entity (a class or a function)
  only when there is a non-obvious reason a reader needs.
- If a comment restates what the code already says, delete it. Naming and
  structure carry the "what".

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

- `packages/backend/src/modules/{name}/test/` — unit and integration tests, next
  to the code they cover. Picked up by `npm test` (hermetic, no Postgres).
- `packages/backend/test/e2e/` — the e2e tier only, run via `npm run test:e2e`.
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
