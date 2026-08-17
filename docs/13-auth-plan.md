# Auth Module Plan: First Real Backend Module

> Consensus plan (RALPLAN-DR, **DELIBERATE** mode) derived from [12-auth-spec.md](./12-auth-spec.md), reviewed by an independent **Architect** (verdict: **GO-WITH-CHANGES**) and **Analyst** (gap analysis). All six architect changes and the analyst's load-bearing gaps are folded in.
> **Status:** APPROVED (2026-07-10) — implementing. The two flagged confirmations are resolved: auth-token Bearer verification is **deferred** (mint/store only this module); sign-in **user-enumeration hardening (dummy argon2 verify) is included**. This is the **first module with real logic** — real SQL, a real Postgres connection, real migrations — a deliberate, ADR-recorded deviation from the skeleton's no-logic rule.
> Execution on worktree/branch `project-setup`. Mirrors the structure and quality bar of [11-project-setup-plan.md](./11-project-setup-plan.md).
>
> **Superseded (single runtime):** the two-runtime split (a DB-less `AppLayer` + a lazy DB-backed `AppDbLayer`/`dbRuntime`) chosen throughout this plan was later collapsed to a **single application runtime** — one lazy DB-backed `ManagedRuntime` that every route runs on, with `/health` a readiness probe (`SELECT 1`, 200/503) on it. `buildApp()` and the unit gate stay hermetic because the runtime is lazy. The rationale below is kept as the historical record. See CLAUDE.md §2.

## Requirements Summary

Implement the `Auth` module as the reference showcase for *service functions with injected Effect dependencies* (db, hasher, clock, logger). A bootstrap **admin credential** (env `ADMIN_TOKEN`, hash-verified, never in the DB) creates **auth tokens** (alias + role) and **operators** (login + password); an operator **signs in** (login + password) to receive a **session**. Roles are a numeric enum in `shared` (`Admin=0, Operator=1, Service=2`); an Admin-role caller is required to create tokens/operators (403 otherwise). Passwords are stored with **argon2id**; session/auth-token secrets are stored as **SHA-256** and compared with `timingSafeEqual`, behind a single `Hasher` Effect service. Schema is applied via the **`@effect/sql` Migrator** from `.sql` files, **run automatically on server startup** and reused by `npm run db:migrate`. Two test tiers: a hermetic **unit** tier (in-memory `AuthRepo` + real `Hasher`, no Postgres, default `npm test`, `GET /health` still 200 DB-less) and a **Dockerized E2E** tier that runs the whole system and, **per test, auto-generates a unique database (CREATE from a migrated template → run → DROP)** with guaranteed teardown and no residual databases. Satisfies all docs/12 acceptance criteria.

## RALPLAN-DR Summary

### Principles
1. **Single source of truth for public shapes** — `Role`, `AuthToken`/`Operator`/`Session` and their `CreateParams` are Effect Schema in `shared`, types derived. **Secrets never enter `shared`**: request bodies carrying passwords/tokens and all hashes live in the backend only.
2. **Depend on interfaces, not implementations** — the domain depends on `AuthRepo`, `Hasher`, `Clock` Context.Tags; never on `argon2`, `node:crypto`, or SQL. Real ⇄ in-memory repo is a Layer swap.
3. **Typed errors, no `throw`** — one `AuthError` union (`Unauthorized | Forbidden | InvalidCredentials | Conflict`) flows through Effect; HTTP status is a pure mapping resolved *before* leaving the effect (so the runtime's error channel stays clean).
4. **Hermetic core, effectful edge** — `buildApp()`/`GET /health` never touch a DB; all connection/migration work lives in the entrypoint boot step and a *separate* DB-backed runtime, so the default gate and health stay Postgres-free.
5. **Secrets are `Redacted` end-to-end** — `ADMIN_TOKEN`, passwords, token plaintext are `Redacted`; never logged (pino redaction on auth routes/headers), never returned except the one-time plaintext at creation.

### Decision Drivers (top 3)
1. **Preserve the DB-less guarantees under a real connection** — the verified eager-connect behavior of `PgClient.layer` must not force Postgres at `buildApp()`/health/unit-test time.
2. **Lint complexity caps** — complexity ≤10, max-depth ≤3, ≤60 lines/fn, ≤4 params, ≤3 nested callbacks, ≤15 statements; decompose and inject deps via context.
3. **Real, reproducible, leak-free tests** — E2E runs the actual system against a real, freshly-migrated per-test DB with guaranteed teardown; the default gate stays fast and DB-less.

### Load-bearing verified facts (grounded in installed packages + confirmed by the architect)
- **`PgClient.layer` connects EAGERLY** — it runs `pool.query("SELECT 1")` inside `Effect.acquireRelease` at *layer-build* time (`@effect/sql-pg/PgClient.js:301-313`, `layer = Layer.scopedContext(make(...))` :396). **`ManagedRuntime.make` builds/memoizes the whole layer on the first `run*` call** (`effect/internal/managedRuntime.js:35-54`). Since the health route is the first thing that runs (`health/routes.ts:15`, via `runSync`), merging `SqlLive` into the shared `AppLayer` **would break DB-less health.** → **two-runtime split** (the disproof of the "PgClient is lazy" assumption is the review's central correction).
- **`PgClient.layer` provides both `PgClient` and `SqlClient` tags** (`Context.make(PgClient, c).pipe(Context.add(SqlClient, c))`, PgClient.js:396). → `AuthRepoLive` depends on `SqlClient`; the migrator needs `PgClient | SqlClient | FileSystem | Path`.
- **`runSync` on async work throws `AsyncFiberException`** (`effect/internal/runtime.js:84-88`). argon2 hash/verify **and** every `@effect/sql` query are async → **all three auth routes use `runPromise`**; only pure `checkHealth` uses `runSync`.
- **`.sql` migrations load via `Migrator.fromFileSystem(dir)`** (subpath `@effect/sql/Migrator/FileSystem`, re-exported by `PgMigrator`; `PgMigrator.run` env = `FileSystem | Path | PgClient | SqlClient | CommandExecutor`). `tsc` does **not** copy `.sql` into `dist` → a **build copy step** is required, and the migrator layer needs `NodeContext.layer` (FileSystem+Path).
- **`argon2@0.44.0` is present but *extraneous*** (in no `package.json`) → add to `packages/backend/package.json`.
- **`config.ts:28` already reads `DB_NAME` from env** → per-instance E2E DB targeting needs **no code change**.

### Viable Options (the load-bearing choice: how DB layers coexist with DB-less health)
- **Option A — Two-runtime split (chosen; architect-endorsed).** `AppLayer` (health, task-registry) stays DB-less on `fastify.runtime`. A **separate lazy** `AppDbLayer = HasherLive ⊕ Layer.provide(AuthRepoLive, SqlLive(config))` is decorated as `fastify.dbRuntime`; auth routes use it. *Pros:* health/`buildApp()`/unit tests provably never build `SqlLive`; auth deps localized; ~15 lines + one extra `onClose`. *Cons:* two runtimes to dispose.
- **Option B — single `AppLayer` + `SqlLive`.** *Pros:* one runtime, simplest wiring. *Cons:* **breaks DB-less health** — the first `run*` (health via `runSync`) forces the whole memoized layer build including `SqlLive`'s eager `SELECT 1`. **Invalidated** by `PgClient.js:301-313` + `managedRuntime.js:39`.
- **Option C — lazy/deferred `SqlClient` (custom `fromPool` acquire).** *Pros:* one runtime, connects truly on first query. *Cons:* re-implements library internals (the `SELECT 1` probe is inside `make`), high complexity vs caps. **Invalidated** as premature; a documented follow-up only.

### Secondary decisions (defaults chosen; all docs/12 §5 open questions resolved — see the explicit list below)
- **Transport contracts live in the backend, not `shared`** (they carry secrets): `CreateOperatorBody{login, password: Redacted, role}`, `CreateSessionBody{login, password: Redacted}`, `CreateAuthTokenBody{alias, role}`; responses `{authToken, secret}` / `{operator}` / `{session, token}` (plaintext secret/token returned **once**).
- **Session token:** opaque 32 random bytes (base64url) → store **SHA-256**, return plaintext once; **TTL 24h** via `SESSION_TTL_SECONDS`. **Auth-token secret:** prefixed `bst_`+random → store SHA-256 + a `token_prefix` lookup column; **mint/store only, Bearer use deferred** (⚠ confirm).
- **`AuthError`→HTTP mapping:** per-route via a shared `authErrorToReply` helper at the `runPromise`/`catchTags` boundary; `error-handler.plugin.ts` stays the 500 net. Postgres `23505`→`Conflict`(409).
- **Column mapping:** `PgClient` `transformQueryNames`/`transformResultNames` (snake↔camel) so `operatorId`↔`operator_id` is a boundary encode, not a field remap (preserves the no-transformation ADR).
- **E2E:** custom `tsx` runner drives compose; **fresh app instance per file** via `DB_NAME` env (no code change); migrated **template DB** cloned per test; guaranteed `DROP` in `finally`; orphan sweeper.

## Resolved Decisions for Every docs/12 §5 Open Question

1. **Session token** — RESOLVED (default): opaque 32 random bytes (base64url); store **SHA-256** hash; return plaintext **once**; default **TTL 24h** via `SESSION_TTL_SECONDS` env override.
2. **Auth-token secret** — RESOLVED (default): prefixed random secret (`bst_`+32 random bytes base64url); store SHA-256 hash + a `token_prefix` lookup column; **mint + store now; using it as Bearer API auth is deferred** to a later module (⚠ flagged for explicit confirmation).
3. **HTTP surface** — RESOLVED: `POST /auth/tokens`, `POST /auth/operators`, `POST /auth/sessions`; admin credential presented as `Authorization: Bearer <ADMIN_TOKEN>`. Payload schemas defined below.
4. **Error model** — RESOLVED: typed `AuthError = Unauthorized | Forbidden | InvalidCredentials | Conflict` → **401 / 403 / 401 / 409**, mapped **per-route** via a shared `authErrorToReply` helper at the `runPromise` boundary; `error-handler.plugin.ts` remains the generic 500 net.
5. **`Hasher` placement** — RESOLVED: reusable `infra/hasher.ts` (parallels `infra/db.ts`).
6. **Admin identity** — RESOLVED: single env `ADMIN_TOKEN` for bootstrap only; no seeded admin operator. `Role.Service` is **issue-only** (assignable to machine auth tokens), enforced nowhere yet.
7. **Migration execution** — RESOLVED (D3 + residual): migrations run on server startup via a **boot step in `main.ts`** (not `buildApp()`), reused as `npm run db:migrate`; format is **`.sql` files** loaded by `Migrator.fromFileSystem('migrations')` (`fromGlob` documented fallback if the dist-copy path proves brittle).
8. **Uniqueness** — RESOLVED: operator `login` unique; auth-token `alias` unique → `Conflict`(409) on collision (Postgres `23505` mapped in data-access).
9. **Test strategy** — RESOLVED (D5 + residual): two tiers — hermetic unit tests in the default gate; a Docker-orchestrated E2E tier with a **custom `tsx` runner**, **per-file app instance** targeted via `DB_NAME` env, a migrated **template database** cloned per test (`CREATE DATABASE … TEMPLATE`), guaranteed `DROP` in `finally`, and an orphan sweeper.
10. **`argon2` native build** — RESOLVED: keep argon2id per D2 (declare the currently-extraneous dep); a **documented `scrypt` fallback** behind the `Hasher` interface only if the target/CI env cannot build it (a Layer swap, not coded now).
11. **Docs** — RESOLVED: produce this `docs/13-auth-plan.md` + the ADR (below) for the real-queries/real-DB/startup-migration deviation.

Two items retain a recommended default but are flagged for the user's explicit confirmation before execution: **§2** (auth-token Bearer verification deferred vs in-scope now) and **user-enumeration hardening on `signIn`** (dummy argon2 verify for unknown logins — included by default).

## Target Repository Layout

```text
packages/
  shared/
    src/
      enums/
        role.ts                     # NEW: enum Role{Admin=0,Operator=1,Service=2}; RoleSchema=Schema.Enums(Role)
        index.ts                    # + export * from '@/enums/role.js'
      schemas/
        auth.ts                     # NEW: AuthToken/Operator/Session structs + per-entity CreateParams (public shapes only, NO secrets)
        index.ts                    # + export * from '@/schemas/auth.js'
    test/
      auth-schema.test.ts           # NEW: decode/reject, CreateParams omit-set, Role enum values
  backend/
    package.json                    # + dep "argon2"; + script "db:migrate"
    migrations/
      0001_auth.sql                 # NEW: auth_tokens, operators, sessions (+ unique constraints, indexes)
    src/
      infra/
        db.ts                       # PROMOTE: keep DatabaseLive healthcheck seam; add SqlLive(config)=PgClient.layer(+transform*Names); provides PgClient+SqlClient
        hasher.ts                   # NEW: Hasher Context.Tag + HasherLive (argon2id passwords; SHA-256+timingSafeEqual tokens; dummyVerify path)
        migrator.ts                 # NEW: runMigrations(dbLayer)=PgMigrator.run({loader:fromFileSystem(dir)}) ⊂ NodeContext + dbLayer
      modules/
        auth/
          contracts.ts              # NEW: request/response body schemas (secret-carrying) — backend-only, Redacted passwords/tokens
          data-access.ts            # NEW: AuthRepo Context.Tag; AuthRepoLive (real SQL ⊂ SqlClient; 23505→Conflict); makeAuthRepoTest (in-memory)
          domain.ts                 # NEW: createAuthToken, createOperator, signIn, authenticate, requireAdmin; AuthError union; isExpired
          routes.ts                 # NEW: POST /auth/tokens|/operators|/sessions; extractBearer; authErrorToReply; uses fastify.dbRuntime.runPromise
      runtime.ts                    # + AppDbLayer(config); makeDbRuntime(config); AppLayer stays DB-less
      types.ts                      # + fastify decorator: readonly dbRuntime: AppDbRuntime
      config.ts                     # + adminToken: Redacted<string>; sessionTtlSeconds: number
      plugins/
        db-runtime.plugin.ts        # NEW: decorate fastify.dbRuntime=makeDbRuntime(fastify.appConfig); onClose dispose (name:'db-runtime', deps:['config'])
        logger.plugin.ts            # EDIT: pino redaction for authorization header + auth request-body password/token
      main.ts                       # + boot step: await runMigrations(SqlLive(config)) BEFORE app.listen (NOT in buildApp)
      db-migrate.ts                 # NEW: standalone `npm run db:migrate` entrypoint (reuses runMigrations; exit non-zero on failure)
    (build script)                  # EDIT: copy migrations/*.sql -> dist/migrations after tsc/tsc-alias
    test/
      auth/
        domain.test.ts              # NEW unit: in-memory AuthRepo + real Hasher + test Clock — guard/create/signin/expiry (no Postgres)
        health-dbless.test.ts       # NEW: GET /health = 200 with no Postgres, AFTER auth wiring
      e2e/
        run.ts                      # NEW: tsx runner (template DB, per-file app, per-test create+drop, sweeper, compose lifecycle)
        auth.e2e.ts                 # NEW: HTTP scenarios against the running Dockerized system
        Dockerfile                  # NEW: backend image the runner boots (node dist/main.js)
docker-compose.e2e.yml              # NEW: backend + postgres(tmpfs) for the E2E runner
.env.example                        # + ADMIN_TOKEN, SESSION_TTL_SECONDS
README.md                           # + auth env, db:migrate, startup-migration behavior, E2E runner usage
docs/
  13-auth-plan.md                   # THIS plan + ADR (committed)
```

## HTTP Endpoints + Payload Schemas

All request/response body schemas live in `packages/backend/src/modules/auth/contracts.ts` (NOT `shared`, because they carry secrets). Passwords/tokens are wrapped `Redacted` at decode; plaintext secrets are returned exactly once at creation.

| Method + Path | Auth | Request body | Success (201) response | Errors |
|---|---|---|---|---|
| `POST /auth/tokens` | `Authorization: Bearer <ADMIN_TOKEN>` | `{ alias: string, role: Role }` | `{ authToken: { id, alias, role, createdAt }, secret: string /* bst_… plaintext, once */ }` | 401 (bad/missing admin token), 403 (authenticated non-admin — future), 409 (alias exists) |
| `POST /auth/operators` | `Authorization: Bearer <ADMIN_TOKEN>` | `{ login: string, password: string /* Redacted */, role: Role }` | `{ operator: { id, login, role, createdAt } }` | 401, 403, 409 (login exists) |
| `POST /auth/sessions` | none (public sign-in) | `{ login: string, password: string /* Redacted */ }` | `{ session: { id, operatorId, role, createdAt, expiresAt }, token: string /* opaque plaintext, once */ }` | 401 (`InvalidCredentials`: unknown login or wrong password) |

Notes: `role` is the numeric enum value (`0|1|2`), validated by `RoleSchema`. Response entity shapes are exactly the `shared` public schemas (no hashes). `secret`/`token` plaintext appears only in the creation response, never stored in plaintext, never returned again.

## AuthError → HTTP Mapping

- Location: **in `routes.ts`**, via a shared `authErrorToReply(error): { status, body }` helper applied at the `runPromise`/`catchTags` boundary — **not** in `error-handler.plugin.ts` (which has no visibility into typed Effect errors and would collapse everything to 500; a plugin importing module types is also the wrong dependency direction).
- Mechanism: each handler runs `domainEffect.pipe(Effect.catchTags({ ... }))` to convert the typed `AuthError` failure channel into a `{status, body}` **before** `fastify.dbRuntime.runPromise`, keeping the runtime's `<_, never>` error channel clean (architect caveat). The handler then `reply.status(status).send(body)`.
- Mapping table:

| `AuthError` tag | HTTP status | When |
|---|---|---|
| `Unauthorized` | 401 | Missing/empty/invalid admin Bearer token; fail-closed if `ADMIN_TOKEN` unset |
| `Forbidden` | 403 | Authenticated but not Admin role (reserved for future non-env admins) |
| `InvalidCredentials` | 401 | Unknown login (after dummy verify) or wrong password on sign-in |
| `Conflict` | 409 | Duplicate `login`/`alias` (Postgres `23505` caught in data-access) |
| (unmapped, e.g. bug/`SqlError`) | 500 | Falls through to `error-handler.plugin.ts` safety net |

## DB Tables / Columns (`migrations/0001_auth.sql`)

Hashes exist **only** in SQL/data-access — never in `shared`. `role` stored as `smallint` (numeric enum). Column names map to schema camelCase via `PgClient` `transform*Names`.

| Table | Columns | Constraints / Indexes |
|---|---|---|
| `auth_tokens` | `id uuid pk default gen_random_uuid()`, `alias text not null`, `role smallint not null`, `token_prefix text not null`, `token_hash text not null`, `created_at timestamptz not null default now()` | `unique(alias)` → Conflict; `index(token_prefix)` for lookup |
| `operators` | `id uuid pk default gen_random_uuid()`, `login text not null`, `role smallint not null`, `password_hash text not null`, `created_at timestamptz not null default now()` | `unique(login)` → Conflict (argon2id string embeds salt+params → no separate salt column) |
| `sessions` | `id uuid pk default gen_random_uuid()`, `operator_id uuid not null references operators(id)`, `role smallint not null`, `token_hash text not null`, `created_at timestamptz not null default now()`, `expires_at timestamptz not null` | `index(operator_id)`, `index(expires_at)`; expiry enforced by `expires_at > now()` filter |

## Startup Migration Hook Design

- **Runner:** `infra/migrator.ts` exposes `runMigrations = (dbLayer) => PgMigrator.run({ loader: fromFileSystem(migrationsDir) }).pipe(Effect.provide(Layer.merge(NodeContext.layer, dbLayer)))`. `NodeContext.layer` (from `@effect/platform-node`) supplies `FileSystem`+`Path`; `dbLayer` (a `SqlLive(config.database)`) supplies `PgClient`+`SqlClient`. `migrationsDir` is resolved from `import.meta.url` so it works under both `tsx` (source `migrations/`) and `node dist` (`dist/migrations/`).
- **Startup placement:** in `main.ts`, `await runMigrations(SqlLive(config.database))` runs in a **short-lived scoped runtime BEFORE `app.listen`** (and disposed after), **not inside `buildApp()`**. This keeps `buildApp()`-based unit tests and `GET /health` DB-less while guaranteeing the schema is current before the server serves traffic.
- **Standalone parity:** `db-migrate.ts` (`npm run db:migrate`, `tsx src/db-migrate.ts`) reuses the exact same `runMigrations` and **exits non-zero on failure**.
- **Worker:** `worker.ts` does **not** migrate — the server boot step and `db:migrate` are the single migration authority. The migrator's applied-tracking table makes runs **idempotent** (a second boot applies zero migrations).
- **Build:** because `tsc` does not emit `.sql`, the backend `build` script copies `migrations/*.sql` → `dist/migrations/` after `tsc`/`tsc-alias` so `fromFileSystem` resolves under `node dist/main.js`.

## Dockerized E2E Test-Runner Design (per-test auto-generated DB: create → migrate → drop)

- **Stack:** `docker-compose.e2e.yml` runs `postgres:16` (tmpfs, ephemeral) and a `backend` service built from `test/e2e/Dockerfile` (`node dist/main.js`), on the project loopback, a distinct port. "The whole system actually runs in Docker."
- **Runner:** `test/e2e/run.ts`, a custom `tsx` script (not Vitest globalSetup — it must own the compose lifecycle and per-test DB provisioning):
  1. `docker compose -f docker-compose.e2e.yml up -d`; wait for Postgres healthy.
  2. **Migrated template:** `CREATE DATABASE billing_e2e_template`; run `runMigrations` against it **once**. The template is **keyed on a hash of `migrations/`** so template-drift (stale schema after a new `.sql`) is impossible — if the hash changes, the template is rebuilt.
  3. **Per test (default granularity: per file):** generate `test_<uuid>`; `CREATE DATABASE test_<uuid> TEMPLATE billing_e2e_template` (a fast clone — no per-test re-migrate); boot a **fresh app instance** with `DB_NAME=test_<uuid>` — which requires **no code change** because `config.ts:28` already reads `DB_NAME` from env (a single long-lived server cannot be repointed, since its pool is memoized in the runtime). The app's own startup migration is then a **no-op** against the already-migrated clone, which *proves* the startup hook end-to-end.
  4. Exercise the running system **over HTTP** (`test/e2e/auth.e2e.ts` scenarios).
  5. **Guaranteed teardown:** `DROP DATABASE test_<uuid>` in a `finally` — fires even on test failure, so no cross-test leakage.
  6. **Orphan sweeper:** at start and end, drop any stale `test_%` databases (covers hard-kill/SIGKILL cases where `finally` cannot run); the tmpfs Postgres is fully discarded at `docker compose down -v`.
  7. `docker compose down -v` tears the stack down.
- **Scenarios (`auth.e2e.ts`):** admin creates a token and an operator; a non-admin call → 403; operator signs in → 201 (session + token); wrong password → 401; duplicate login → 409; assert `password_hash` starts with `$argon2id$` at rest; assert no plaintext password/token in captured logs.
- **Granularity choice:** **per-file** by default (bounds cost) with a per-test cloned DB; escalate to strict per-test app instances only where isolation demands it.

## Implementation Steps

### Phase 0 — `shared` contracts (public shapes only) — *spec AC: roles, entity shapes*
1. **`enums/role.ts`** — `enum Role { Admin=0, Operator=1, Service=2 }` + `RoleSchema = Schema.Enums(Role)`; mirror `payment-method.ts`; update `enums/index.ts`. *(D1; §6: `Role.Service` issue-only, no seeded admin operator.)*
2. **`schemas/auth.ts`** — `AuthToken{id,alias,role,createdAt}`, `Operator{id,login,role,createdAt}`, `Session{id,operatorId,role,createdAt,expiresAt}` (**no hashes/passwords**), types derived. **Per-entity CreateParams**: `CreateAuthToken = omit('id','createdAt')`, `CreateOperator = omit('id','createdAt')`, `CreateSession = omit('id','createdAt','expiresAt')` (server-derived fields). Update `schemas/index.ts`.
   **AC:** compiles under strict TS; no `../../..`; no secret fields in `shared`.
3. **`test/auth-schema.test.ts`** (`@effect/vitest`) — decode a valid `Operator`, reject invalid, assert each `CreateParams` omit-set, assert `RoleSchema` accepts `Role.Admin` / rejects `99`. Mirror `schema.test.ts`.
   **AC:** shared schema test green in the default gate.

### Phase 1 — backend infra: DB, Hasher, Migrator — *spec AC: real SQL, argon2, migrations*
4. **Promote `infra/db.ts`** — keep `Database`/`DatabaseLive` healthcheck seam (health uses it). Add `SqlLive = (config: DatabaseConfig) => PgClient.layer({ ...config, password: Redacted.make(...), transformQueryNames: <camelToSnake>, transformResultNames: <snakeToCamel> })`. Document eager-connect → only ever composed into the DB runtime.
   **AC:** real Postgres connection layer available; snake↔camel mapping configured.
5. **`infra/hasher.ts`** — `Hasher` Context.Tag (record of functions, no class methods): `hashPassword`/`verifyPassword` (argon2id via `Effect.tryPromise`, typed `HashError`), `hashToken`/`verifyToken` (SHA-256 sync; `timingSafeEqual` on **equal-length** digests), plus a `dummyVerify` constant-time path for unknown-login `signIn`. Secrets `Redacted`. `HasherLive = Layer.succeed(...)`. Each fn ≤15 statements.
   **AC:** passwords argon2id; tokens SHA-256+timingSafeEqual; `Redacted`; no `argon2`/`crypto` import in `domain.ts`.
6. **`migrations/0001_auth.sql`** — the three tables per the DB section (uuid PKs, `role smallint`, hash columns, `token_prefix`, uniqueness, indexes).
   **AC:** schema DDL present; unique constraints on `login`/`alias`.
7. **`infra/migrator.ts`** — `runMigrations(dbLayer)` as specified in the Startup Migration Hook section; returns `Effect<readonly [id,name][], MigrationError|SqlError>`.
   **AC:** schema applied via `@effect/sql` Migrator from `.sql` files.
8. **Build copy step** — extend backend `build` to copy `migrations/*.sql` → `dist/migrations/`.
   **AC:** `node dist/main.js` migration path resolves `.sql` files.
9. **`package.json`** — add `argon2` dependency; add `"db:migrate": "tsx src/db-migrate.ts"`; root convenience `db:migrate -w @billing-service/backend`.
   **AC:** `argon2` no longer extraneous; `db:migrate` script wired.

### Phase 2 — auth module: contracts, data-access, domain, routes — *spec AC: full vertical flow*
10. **`modules/auth/contracts.ts`** — request-body schemas (`CreateOperatorBody`, `CreateSessionBody`, `CreateAuthTokenBody`) and response shapes; passwords/tokens wrapped `Redacted` at decode. Backend-only (secret-carrying).
    **AC:** transport contracts exist outside `shared`; secrets `Redacted`.
11. **`modules/auth/data-access.ts`** — `AuthRepo` Context.Tag + `AuthRepoLive = Layer.effect(AuthRepo, gen(function*(){ const sql = yield* SqlClient; ... }))` with **real parameterized SQL** (`insertAuthToken`, `insertOperator`, `findOperatorByLogin` → operator + `password_hash`, `insertSession`, `findSessionById`). Catch Postgres `23505` → `Conflict`. `makeAuthRepoTest()` = in-memory Map-backed Layer (no `SqlLive`). Each query fn ≤15 statements.
    **AC:** real SQL via `@effect/sql-pg`; in-memory test layer; unique violation → `Conflict`.
12. **`modules/auth/domain.ts`** — Effect-returning functions, deps via context:
    - `requireAdmin(presented: Redacted<string>)` — SHA-256+`timingSafeEqual` vs `config.adminToken`; **fail-closed if `ADMIN_TOKEN` empty**; wrong/missing → `Unauthorized`; non-admin-but-authenticated future path → `Forbidden`.
    - `createAuthToken(params)` → generate `bst_`+secret, store SHA-256+prefix; alias collision → `Conflict`.
    - `createOperator(params)` → argon2id hash, insert; login collision → `Conflict`.
    - `signIn(login, password)` → find operator; **unknown login runs `dummyVerify` then** → `InvalidCredentials`; wrong password → `InvalidCredentials`; else create session (opaque token, SHA-256 stored, `expiresAt = now + SESSION_TTL` via `Clock`).
    - `authenticate(token)` + `isExpired(session, now)` — pure session validation (no HTTP middleware; caller deferred with Bearer scope).
    - `AuthError = Unauthorized | Forbidden | InvalidCredentials | Conflict` as `Data.TaggedError`.
    **AC:** admin guard rejects non-admin (403); sign-in success returns session+token; wrong pw → 401; expired session rejected.
13. **`modules/auth/routes.ts`** — autoloaded entrypoint (transport only), three POSTs. Decompose to respect caps: `extractBearer(request)`, shared `authErrorToReply(error)` mapper, thin handlers (`decode → runPromise(domainEffect ⊂ dbRuntime) → reply`). **`fastify.dbRuntime.runPromise`** (argon2 + SQL are async). Map `AuthError` via `Effect.catchTags` **before** `runPromise` (keeps the `never` error channel clean). HTTP map `401/403/401/409`; unmapped → 500 net.
    **AC:** endpoints behave per criteria; typed mapping local; `error-handler.plugin` unchanged as 500 net.

### Phase 3 — runtime, config, startup migration — *spec AC: startup migrations, DB-less health*
14. **`runtime.ts`** — `AppLayer = mergeAll(DatabaseLive, TaskRegistryLive)` stays **DB-less**. Add `AppDbLayer = (config) => Layer.mergeAll(HasherLive, Layer.provide(AuthRepoLive, SqlLive(config.database)))` and `makeDbRuntime = (config) => ManagedRuntime.make(AppDbLayer(config))` (**parameterized by config** — `PgClient` needs connection params). Resolve typed errors before `runPromise` so `AppDbRuntime` error channel stays clean.
    **AC:** layer graph resolves (no missing `SqlClient`); `AppLayer` stays DB-less.
15. **`config.ts`** — add `adminToken: Redacted.make(process.env['ADMIN_TOKEN'] ?? '')`, `sessionTtlSeconds: Number(process.env['SESSION_TTL_SECONDS'] ?? '86400')`.
    **AC:** admin token + session TTL configurable.
16. **`types.ts`** — add `readonly dbRuntime: AppDbRuntime` to the Fastify decorators declaration.
    **AC:** typecheck sees `fastify.dbRuntime`.
17. **`plugins/db-runtime.plugin.ts`** — decorate `fastify.dbRuntime = makeDbRuntime(fastify.appConfig)`; `onClose` dispose. **Lazy → decorating does NOT connect**; connection opens on the first auth-route `run*`, so `buildApp()`/health stay DB-less. `{name:'db-runtime', dependencies:['config']}`.
    **AC:** DB runtime available to auth routes; no connection at `buildApp()`.
18. **`plugins/logger.plugin.ts`** — add pino redaction for the `authorization` header and auth request-body password/token.
    **AC:** no secret plaintext in logs.
19. **`main.ts` boot + `db-migrate.ts`** — in `main.ts`, `await runMigrations(SqlLive(config.database))` in a short-lived scoped runtime **before** `app.listen` (not in `buildApp()`), then dispose. `db-migrate.ts` runs the same runner standalone and **exits non-zero on failure**. `worker.ts` does **not** migrate.
    **AC:** startup migrations auto-run; same runner as `db:migrate`; `buildApp()`/health DB-less.

### Phase 4 — unit test tier — *spec AC: hermetic domain tests, DB-less health*
20. **`test/auth/domain.test.ts`** (`@effect/vitest`) — provide `Layer.merge(makeAuthRepoTest(), HasherLive)` + test `Clock`. Cover: admin guard accept/reject (Unauthorized); create token/operator + duplicate → `Conflict`; `signIn` success; wrong password → `InvalidCredentials`; unknown login → `InvalidCredentials` (dummy-verify); expired session via `isExpired`. **No Postgres.**
    **AC:** default `npm test` needs no Postgres; all cases green.
21. **`test/auth/health-dbless.test.ts`** — `buildApp()` + inject `GET /health` with **no Postgres**; assert 200 and zero connection attempts.
    **AC:** health 200 DB-less post-integration.

### Phase 5 — Dockerized E2E tier — *spec AC: real DB, per-test DB lifecycle*
22. **`docker-compose.e2e.yml` + `test/e2e/Dockerfile`** — `postgres:16` (tmpfs) + backend image (`node dist/main.js`), project loopback, distinct port.
    **AC:** whole system runnable in Docker.
23. **`test/e2e/run.ts`** — the runner per the E2E design (compose up → migrated template keyed on migrations hash → per-file app on `test_<uuid>` via `DB_NAME` → per-test `CREATE … TEMPLATE` + `finally` `DROP` → sweeper → `compose down -v`).
    **AC:** per-test DB create+migrate+drop; guaranteed teardown; no residuals.
24. **`test/e2e/auth.e2e.ts`** — admin creates token + operator; non-admin → 403; sign-in → 201; wrong pw → 401; duplicate login → 409; assert `password_hash` starts `$argon2id$`; assert no plaintext secret in logs.
    **AC:** HTTP scenarios pass against the running system; secrets safe at rest/in logs.

### Phase 6 — config docs, governance, ADR — *spec AC: docs/ADR committed*
25. **`.env.example` + README** — `ADMIN_TOKEN=` (note: hash-verified, never stored), `SESSION_TTL_SECONDS=86400`; document `db:migrate`, startup-migration behavior, and running the E2E tier.
    **AC:** env + usage documented.
26. **`docs/13-auth-plan.md` (this plan) + ADR** — commit on `project-setup`.
    **AC:** plan + ADR committed; deviation recorded.

## Acceptance-Criteria Traceability

| Spec AC (docs/12) | Steps |
|---|---|
| Admin creates token+operator; non-admin→403 | 1,2,10,11,12,13,20 |
| Sign-in→session; wrong pw→401; expired rejected | 2,12,13,20,24 |
| argon2id pw; SHA-256+timingSafeEqual tokens; Redacted; no plaintext at rest | 5,11,12,18,24 |
| Real SQL via @effect/sql-pg; schema via Migrator | 4,6,7,11 |
| Migrations auto-run on startup; same runner as db:migrate; idempotent | 7,8,9,19,23 |
| build+typecheck+lint(0/0,caps)+unit test; default test no Postgres; /health 200 DB-less | 8,13,14,17,19,20,21 |
| E2E: Docker whole-system; per-test DB create+migrate+drop; no residuals/leakage | 22,23,24 |
| No `../../..`; shared single source of truth; docs/ADR committed | 1,2,10,11,25,26 + Gate |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `PgClient.layer` connects eagerly → health hits DB | Breaks DB-less health/unit tests (hard AC) | **Two-runtime split** (Option A): `SqlLive` only in lazy `dbRuntime`, never `AppLayer`; health uses DB-less runtime; **explicit health-DB-less test** (step 21); architect-verified |
| `runSync` on async argon2/SQL | `AsyncFiberException` crash | All auth routes `runPromise`; only pure `checkHealth` `runSync` |
| Typed error leaks into `ManagedRuntime<_,never>` | typecheck failure | Resolve `AuthError`/`SqlError` via `catchTags` before `runPromise` |
| `.sql` not emitted by tsc | startup/`db:migrate` crash under `node dist` | Build copies `migrations/*.sql`→`dist/migrations`; `import.meta.url`-relative dir; `fromGlob` fallback |
| Unique violation → 500 not 409 | wrong status | data-access maps `23505`→`Conflict`; asserted unit + E2E |
| `argon2` native build (extraneous today) | install/CI failure | Declare dep; documented `scrypt` fallback behind `Hasher` (a Layer swap, not coded now) |
| `timingSafeEqual` length mismatch / empty `ADMIN_TOKEN` | throw / open admin | Compare fixed-length SHA-256 digests; fail-closed on empty token |
| User enumeration via `signIn` timing | login-existence leak | `dummyVerify` constant-time path for unknown login; always `InvalidCredentials` |
| Secret leakage in logs | credential exposure | pino redaction on `authorization` + auth bodies; hashes never leave data-access; plaintext once |
| snake/camel column drift | query/decode failures | `PgClient` `transform*Names`; documented in ADR under "no transformation" |
| E2E template drift / orphans on crash | stale schema / leaked DBs | Template keyed on migrations hash; per-test `finally` DROP; start/end sweeper; tmpfs `compose down -v` |
| Composed route exceeds complexity caps | lint 0/0 fails | Extract `extractBearer`/`authErrorToReply`; deps via Effect context not params; deliberate complexity-12 fails lint in the gate |

## Pre-mortem (DELIBERATE — 3 scenarios)
1. **"Health broke in prod."** First request forces the DB build and Postgres is down. *Cause:* `SqlLive` leaked into `AppLayer` or health used `dbRuntime`. *Guard:* `SqlLive` strictly in `dbRuntime`; health on `fastify.runtime`; step-21 test runs health with Postgres stopped → 200.
2. **"Migrations didn't run / ran twice."** Traffic before schema, or double-apply. *Cause:* migration inside `buildApp()` (skipped in tests) or not awaited before `listen`. *Guard:* awaited boot step before `listen`; migrator applied-tracking table = idempotent; gate proves empty-DB apply + no-op re-run.
3. **"E2E leaks DBs / flakes."** CI accumulates `test_*` or tests contaminate. *Cause:* DROP skipped on failure or shared DB. *Guard:* per-test unique DB, `finally` DROP, template-clone isolation, sweeper, `compose down -v`; gate asserts zero `test_*` after run.

## Verification Gate (Phase-6)

1. `npm install` — `argon2` builds/links (no longer extraneous); workspaces link.
2. `npm run build` — `shared→backend`; `dist/migrations/*.sql` present; no `../../..`; no unresolved `@/`.
3. `npm run typecheck` — passes; auth layer graph resolves (no missing `SqlClient`; `never` channel clean); introduce a deliberate type error → it **fails**; revert.
4. `npm run lint` — **0 errors / 0 warnings**; introduce a **deliberate complexity-12** function in `domain.ts` → it **fails**; revert. Grep `from '\.\./\.\./'` → **zero**.
5. `npm test` (unit tier) — `domain.test.ts` + `auth-schema.test.ts` + `health-dbless.test.ts` + existing `health.test.ts` green **with Postgres stopped**; confirm no `pg` connection attempted.
6. **Startup-migration proof:** `npm run db:test:up`; `node packages/backend/dist/main.js` against an **empty** DB → logs show migrations applied; `GET /health` → 200; `POST /auth/sessions` on a created operator → 201; restart → migrations report "no pending" (idempotent).
7. **`npm run db:migrate`** against a fresh DB applies the same migrations (runner reuse proven); returns **non-zero** on a forced failure.
8. **E2E runner:** `node packages/backend/test/e2e/run.ts` → compose up → template migrated once → per-file app on `test_<uuid>` (scenarios 201/403/401/409; `$argon2id$` at rest; no plaintext in logs) → per-test `DROP` → `compose down -v`. Assert `SELECT datname FROM pg_database WHERE datname LIKE 'test_%'` → **zero rows** afterward.
9. **Secret audit:** grep build/logs/responses — no password/token/`ADMIN_TOKEN` plaintext or hash; `Redacted` used at every boundary.
10. `git status` — plan (13), ADR, migrations, and all auth artifacts committed on `project-setup`.

## ADR — Auth as the first real module

- **Decision:** Implement `Auth` with real SQL (`@effect/sql`/`@effect/sql-pg`), a real Postgres connection, and automatic startup migrations (`.sql` via `PgMigrator`/`fromFileSystem`), behind Effect DI (`AuthRepo`/`Hasher`/`Clock` Context.Tags). Roles are a numeric enum in `shared`; admin bootstrap is an env `ADMIN_TOKEN` (hash-verified, never stored). **Split runtimes**: a DB-less `AppLayer` (health, task-registry) and a lazy DB-backed `AppDbLayer` (Hasher + AuthRepo ⊂ SqlLive), the latter used only by auth routes and the migration boot step. Transport/secret contracts live in the backend, not `shared`. Two test tiers: hermetic unit + Dockerized per-test-DB E2E.
- **Drivers:** preserve the DB-less `buildApp()`/health guarantee under a real connection; honor the lint complexity caps; deliver real, leak-free tests; keep `shared` a secret-free single source of truth.
- **Alternatives considered:** single merged `AppLayer`+`SqlLive` (invalidated: eager connect + whole-layer memoized build breaks DB-less health — `PgClient.js:301-313`, `managedRuntime.js:39`); bespoke deferred/scoped `SqlClient` (invalidated: re-implements library internals vs the caps); `.ts` glob vs `.sql` `fromFileSystem` migrations (chose `.sql` per D3, `fromGlob` fallback); AuthError mapping in the global error handler vs per-route (chose per-route — the global handler sees only `FiberFailure` and can't map 401/403/409); repointing a running server vs a fresh app per test for E2E (chose fresh app via `DB_NAME` — a memoized pool can't be repointed).
- **Why chosen:** the two-runtime split is the only option that *unconditionally* preserves DB-less health (verified three ways: empirical inspection, the independent Architect's file:line evidence, and the Analyst's flag); `.sql`+`fromFileSystem` matches D3 and is reused by the test runner; per-route typed mapping keeps 401/403/409 precise without a stringly-typed global handler; fresh-app-per-file is the only mechanism compatible with a memoized pool + a per-test auto-generated DB.
- **Consequences:** this module **breaks the skeleton's no-logic rule by design** (recorded here); the running server now **requires Postgres** (health and unit tests do not — a deliberate, documented asymmetry between "server boot" and "app build"); `.sql` files must be copied into `dist`; `argon2` adds a compiled dependency (with a documented `scrypt` fallback behind `Hasher`); two `ManagedRuntime`s must be disposed on close; auth routes use `runPromise` while health uses `runSync`; snake↔camel is handled by `PgClient` transforms; secret-carrying contracts live in the backend, not `shared`.
- **Follow-ups:** use auth tokens as Bearer API auth in a later module (§2, currently mint-only) with a live `authenticate` caller; non-env admin identities exercising the `Forbidden` path; session validation/refresh/revocation; wire real queue handlers; CI wiring for the E2E tier; revisit consolidating the two runtimes if a lazy `SqlClient` sub-layer later proves clean.

## Consensus Changelog

**Review process (transparency):** this pass dispatched an independent **Analyst** (gap analysis) and **Architect** (design soundness, READ-ONLY). Both completed and their full verdicts were retrieved and folded in. **Architect verdict: GO-WITH-CHANGES** — it independently disproved the initial "PgClient is lazy" assumption (with `PgClient.js:301-313` + `managedRuntime.js:35-54` evidence) and confirmed the **two-runtime split** as the fix, plus five further changes (all incorporated). The **Analyst** surfaced load-bearing gaps now closed. A fresh `critic`/`code-review` pass on the eventual implementation remains the recommended compensating control for the DELIBERATE tier.

Changes incorporated:
- **Two-runtime split** (both reviewers, verified) — `SqlLive` only in the lazy `dbRuntime`; added an explicit health-DB-less regression test (step 21).
- **`runPromise` for all SQL/argon2 routes** (architect item 2; analyst: SQL Effects are async too) — `runSync` only for pure `checkHealth`.
- **`AppRuntime<_, never>` type-channel caveat** (architect item 6) — resolve typed errors before `runPromise`.
- **`makeDbRuntime(config)` parameterized** (both) — `PgClient` needs connection params.
- **Per-route `authErrorToReply` + `23505`→409** (both) — global handler stays the 500 net.
- **Secret-carrying contracts in backend `contracts.ts`, not `shared`** (analyst gap) — passwords `Redacted`, response shapes defined.
- **snake↔camel via `PgClient` `transform*Names`** (analyst guardrail) — documented under the no-transformation ADR.
- **Per-entity `CreateParams` omit-sets** (analyst) — not just `id`.
- **argon2 dummy-verify (anti-enumeration) + `timingSafeEqual` length guard + fail-closed empty `ADMIN_TOKEN`** (analyst edges).
- **pino redaction** on auth routes/headers (analyst guardrail).
- **`.sql` dist-copy build step + `NodeContext` in the migrator layer** (analyst dist hazard); `fromGlob` fallback.
- **Concrete DDL** for all three tables incl. `token_prefix` lookup column (analyst gaps).
- **E2E: fresh app per file via `DB_NAME` (no code change), template keyed on migrations hash, sweeper** (architect item 5; analyst edges).
- **`db:migrate` exits non-zero on failure; idempotent-restart AC; ADR + `.env.example` deliverables** (analyst missing ACs/deliverables).

## Implementation Notes (as-built)

Deviations discovered while executing; the committed code is the source of truth.

- **Migrations are typed `.ts` modules, not `.sql`.** `@effect/sql`'s
  `Migrator.fromFileSystem` only loads files matching `\d+_name.(js|ts)` whose
  **default export is an Effect** — it does **not** execute `.sql` files (verified in
  `@effect/sql/Migrator/FileSystem.js`). So the migration is
  `src/migrations/0001_auth.ts` (default-exports an Effect that runs the DDL through the
  `SqlClient`). Keeping it under `src/` means tsc compiles it into `dist/migrations`, and
  the migrator resolves `../migrations` to `src/migrations` under `tsx` and
  `dist/migrations` under `node dist` — **same relative path, right files in each, so the
  planned `.sql`-dist-copy build step is obsolete and was dropped.**
- **The migrator uses a plain, no-name-transform connection.** Raw DDL and the migrator's
  own bookkeeping table must see identifiers exactly as written; only the app's *query*
  connection (`SqlLive`) carries the camel↔snake `transform*Names`.
- **`AuthConfig` is injected as an Effect service** (`modules/auth/config.ts`) so the
  domain receives the admin token + session TTL via DI instead of threaded parameters.
- **`AuthError` lives in `modules/auth/errors.ts`** (not `domain.ts`) so `data-access.ts`
  can map a `23505` unique violation to `Conflict` without a domain↔data-access cycle.
- **Admin bearer: missing/invalid → 401** (`Unauthorized`); `403` (`Forbidden`) is reserved
  for a future authenticated-but-non-admin caller. The E2E asserts 401 for the
  missing-credential case.
- **E2E runs the app in-process against a Dockerized Postgres** (the only stateful
  dependency), one throwaway `DB_NAME` per scenario; DB admin ops (`CREATE`/`DROP` + the
  at-rest check) go through `psql` inside the container, so the runner needs no separate
  Postgres driver. Bound to `127.0.0.1:5544`, tmpfs, `docker compose down -v` teardown.
- **Secret redaction:** the `Authorization` header is redacted via pino
  (`app.ts`). Body passwords/tokens are carried as Effect `Redacted` (they
  serialize to `<redacted>`) and Fastify does not log request bodies, so no
  plaintext reaches the logs — the promised body redaction is satisfied
  structurally rather than via extra pino paths; `logger.plugin.ts` remains the
  documented seam for future custom log config.

### Post-review fixes (independent code-review pass)

An independent `code-reviewer` pass (0 Critical, no high-confidence blockers,
verdict *ship-with-fixes*) confirmed the load-bearing properties (constant-time
admin compare, DB-less two-runtime split, parameterized SQL, leak-proof E2E
teardown). Its substantive findings were applied:

- **`token_prefix` no longer stores secret bytes.** `createAuthToken` stored a
  12-char slice of the plaintext token (`bst_` + 8 secret chars) in an indexed
  column — leaking ~48 bits at rest. It now stores only the non-secret scheme
  marker `bst_`; a future Bearer-auth module will add a real public lookup id.
- **Session tokens get a distinct `bss_` prefix** (auth tokens keep `bst_`) so a
  future unified Bearer router can route by prefix to the right table.
- **`authenticate` is now unit-tested** (valid session, expired → `InvalidCredentials`,
  unknown token → `InvalidCredentials`), closing the "expired session rejected"
  acceptance criterion that was previously covered only indirectly via `isExpired`.

- **Gate result:** unit tier **17/17 green with no Postgres**; `GET /health` 200
  DB-less; E2E tier **6/6 scenarios green, 0 leaked databases**; startup migration
  proven on the built server (migrates on boot, idempotent on restart);
  typecheck + lint **0/0**.
