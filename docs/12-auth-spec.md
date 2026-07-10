# Auth Module Spec (Planner Input)

> Reconstructed input for the first real module — **Auth**. The `/ralplan` for this
> module was interrupted (ctrl-C) immediately after its clarifying questions were
> answered, before any Planner/Architect/Critic pass ran. This document captures the
> recovered task + the four resolved decisions + the constraints the existing skeleton
> locks in, so the planner can produce `docs/13-auth-plan.md`.
>
> **Status:** ready for planning. Depends on the committed skeleton (docs `10`/`11`).
> Execution target: worktree/branch `project-setup`.

## Goal

Implement the **first real module, `Auth`** — the reference showcase for *how to write
service functions and domain logic with injected dependencies* (db, logger, hasher,
clock) using the module convention established in `docs/10`/`docs/11`.

Functional intent (from the original request):

1. A bootstrap **admin credential** can:
   - create **auth tokens** — each token has an **alias** and a **role**;
   - create **operators** — each has a **login** and **password**.
2. An operator can **sign in** with login + password, which **creates a session**.

The primary objective is pedagogical: demonstrate the full vertical flow
(transport → domain → data-access) with real Effect dependencies and typed errors —
not to build the entire auth surface.

## Resolved Decisions (load-bearing — do not re-ask)

These are the answers given to the ralplan clarifying questions.

### D1 — Roles & permissions model
Numeric `Role` enum defined in `shared` (`Admin = 0`, `Operator = 1`, `Service = 2`),
wrapped with `Schema.Enums`. Both auth tokens and operators carry a role. An
**Admin-role credential is required** to create tokens/operators (a minimal but real
RBAC guard). Sessions carry the operator's role.

### D2 — Password + token hashing
**argon2id for passwords** (via the native `argon2` dependency — this overrides the
originally-recommended crypto-only option and adds a compiled dependency) **plus
node:crypto SHA‑256 + `timingSafeEqual`** for API/session tokens. Both are exposed
through a single `Hasher` Effect service so the domain depends on an interface, not on
`node:crypto`/`argon2` directly.

### D3 — Schema / migrations approach
**`@effect/sql` Migrator with a `migrations/` directory.** Idiomatic Effect-SQL
migrations, reusable for every future module. This module adds the first real tables.
**Migrations run automatically on server startup via a server-side hook** so the schema
is **always up to date** whenever the server runs. The *same* migrator is reused by the
test runner (below) to migrate each freshly-created test database.

### D4 — Admin (bootstrap) token source
The admin credential lives in **config/secret (env `ADMIN_TOKEN`)** and is verified by
**hash with `timingSafeEqual`** — it is **NOT stored in the DB**. It mints DB-stored
auth tokens and operators; there is no seeding step.

### D5 — Testing strategy (two tiers)
1. **Hermetic domain/unit tests** — in-memory `AuthRepo` test layer + real `Hasher`.
   Fast, need no Postgres; run in the default `npm test` gate.
2. **Auth integration test is a full E2E test against a REAL database after REAL
   migrations.** The **whole system is actually run inside Docker**; a dedicated
   **test runner** spins up all needed dependencies, runs actual migrations, executes
   the tests against the running system, then tears everything down. **Each test gets an
   auto-generated database name** that is **created, migrated, and dropped afterward** to
   prevent data leakage/cross-test contamination.

## Constraints the plan MUST honor (from docs `10`/`11` + current code)

- **Module layout:** `modules/auth/` → `routes.ts` (the autoloaded entrypoint, transport
  only), `domain.ts` (services as **Effect-returning functions, no classes/methods**),
  `data-access.ts` (an Effect `Context.Tag` repo). Add `auth.plugin.ts` **only if** the
  module subscribes to queue events (it likely does not yet). `domain.ts`/`data-access.ts`
  are plain imports, never autoloaded.
- **First *real* module:** `data-access.ts` now contains **real SQL**. The skeleton's
  "no queries" rule was a skeleton-phase constraint; the deviation must be recorded in an
  ADR / the docs.
- **Effect DI everywhere:** `Context.Tag` services, `Layer` composition, **typed errors
  (no `throw`)**, functions not classes. Tag identity via `class extends Context.Tag` is
  the accepted exception.
- **`shared` is the single source of truth:** Effect Schema, **derived** types
  (`Schema.Schema.Type`), numeric enums via `Schema.Enums`, `CreateParams = Schema.omit('id')`.
  Public entity shapes only — **no secret hashes in shared contracts** (hashes live at the
  data-access layer).
- **Aliases & strict TS:** `@/` intra-package, `@billing-service/*` cross-package (no
  `../../..`); NodeNext ⇒ explicit `.js` on relative imports; `verbatimModuleSyntax` ⇒
  `import type` for type-only imports.
- **Complexity caps (lint fails otherwise):** complexity ≤10, max-depth ≤3, ≤60 lines/fn,
  **≤4 params**, ≤3 nested callbacks, ≤15 statements. Decompose domain functions; inject
  deps via Effect context, not long parameter lists.
- **Migrations on startup:** the real server entrypoint **must run migrations on startup**
  (D3) so the schema is always current. This makes the *running server* require a live DB —
  which is expected. To preserve the existing hermetic **unit** tests, keep the migration
  run in the server boot/entrypoint (e.g. `main.ts`/`worker.ts` or a boot step), **not**
  inside the pure `buildApp()` factory, so `buildApp()`-based unit tests and `GET /health`
  stay DB-less. (The planner finalizes exactly where the hook lives.)
- **Two test tiers (D5):** the default `npm test` gate stays hermetic (unit tier, no
  Postgres); a separate Dockerized E2E tier runs the whole system against a real,
  freshly-migrated, per-test database.
- **Runtime seam:** routes execute effects via `fastify.runtime` (a `ManagedRuntime`);
  secrets use `Redacted`.
- **Governance:** specs/plans/ADRs are committed. This module warrants a committed
  `docs/13-auth-plan.md` (and an ADR for the "real queries + real DB wiring" deviation).

## Proposed Scope / Deliverables (for the planner to sequence)

- **`shared`:** `enums/role.ts` (`Role` + `RoleSchema`); schemas `AuthToken`
  (`id, alias, role, createdAt`), `Operator` (`id, login, role, createdAt`), `Session`
  (`id, operatorId, role, createdAt, expiresAt`); derived create-params; barrel updates +
  a schema test.
- **`backend` infra:** promote `infra/db.ts` to a real `SqlLive` (PgClient providing
  `SqlClient`); new `infra/hasher.ts` (`Hasher` tag + `HasherLive` = argon2id + crypto);
  migrator wiring + `migrations/0001_auth.sql`.
- **`backend` module `modules/auth/`:** `data-access.ts` (`AuthRepo` tag + `AuthRepoLive`
  real SQL + an in-memory test layer); `domain.ts` (`createAuthToken`, `createOperator`,
  `signIn`, `authenticate`, admin guard, typed `AuthError` union); `routes.ts` (POST
  endpoints + admin-token check + error→HTTP mapping).
- **Migrations & startup hook:** `migrations/` dir + a reusable Migrator runner
  (`@effect/sql`); a **server-startup hook** that runs pending migrations before the
  server serves traffic (in the entrypoint, not `buildApp()`); a standalone
  `npm run db:migrate` that reuses the same runner.
- **Config/env:** `ADMIN_TOKEN` (+ its hash), session TTL; update `.env.example` + README;
  the `db:migrate` script.
- **Runtime:** compose `Hasher` + `AuthRepoLive` (⊂ `SqlLive`) into `AppLayer`; keep the
  pure `buildApp()` factory / `GET /health` DB-less.
- **Tests (two tiers, D5):**
  - **Unit tier** — hermetic domain tests (in-memory `AuthRepo` + real `Hasher`) covering
    admin-guard, token/operator creation, sign-in success/failure, and session expiry;
    run in default `npm test`.
  - **E2E tier** — a **Docker-orchestrated test runner** (script + compose) that: boots the
    whole system + dependencies in Docker, creates a **uniquely auto-generated database per
    test**, runs the **actual migrations** against it, exercises the running system over
    HTTP, then **drops that database** and tears the stack down. No cross-test data leakage.

## Open Questions (planner to resolve; recommended default in **bold**)

1. **Session token** — **opaque random bytes → store SHA‑256 hash, return plaintext once;
   default TTL 24h with an env override.**
2. **Auth-token secret** — **prefixed random secret; store SHA‑256 hash. Mint + store now;
   using it as Bearer API auth can be deferred to a later module** (confirm).
3. **HTTP surface** — proposed `POST /auth/tokens`, `POST /auth/operators`,
   `POST /auth/sessions`; **admin credential presented as `Authorization: Bearer <ADMIN_TOKEN>`.**
4. **Error model** — typed Effect errors `Unauthorized` / `Forbidden` / `InvalidCredentials`
   / `Conflict` (dup login/alias) → **401 / 403 / 401 / 409** mapped in routes or the
   error-handler plugin.
5. **`Hasher` placement** — **reusable `infra/hasher.ts`** (parallels `infra/db.ts`).
6. **Admin identity** — **single env token only for bootstrap; no seeded admin operator.**
   Clarify when `Role.Service` is issued (likely for machine auth tokens).
7. **Migration execution** — DECIDED (D3): migrations **run on server startup** (always up
   to date) via a boot hook, and the same runner is exposed as `npm run db:migrate` for the
   test runner. Residual: confirm `.sql` vs Effect `.ts` migration style, and the exact
   placement of the startup hook (entrypoint boot step vs a gated plugin) so unit tests
   stay hermetic.
8. **Uniqueness** — **operator `login` unique; auth-token `alias` unique** → `Conflict` on
   collision.
9. **Test strategy** — DECIDED (D5): two tiers — hermetic unit tests in the default gate,
   plus a Docker-orchestrated E2E tier that runs the whole system against a real DB after
   real migrations, with a **per-test auto-generated database created + migrated + dropped**.
   Residual: choose the runner mechanism (custom Node/`tsx` script vs Vitest global-setup
   driving compose), per-test vs per-file DB granularity, and whether to use a **template
   database** (migrate once, `CREATE DATABASE ... TEMPLATE`) to keep per-test setup fast.
10. **`argon2` native build** — node-gyp risk; **keep argon2id per D2, with a documented
    `scrypt` fallback only if the target/CI env cannot build it** (confirm).
11. **Docs** — **produce `docs/13-auth-plan.md` + an ADR** for the real-queries/real-DB
    deviation from the skeleton.

## Acceptance Criteria (sketch)

- [ ] Admin credential (env, hash-verified) creates an auth token (alias + role) and an
      operator (login + password); a non-admin caller is rejected (403).
- [ ] Operator signs in with correct login + password → receives a session (+ token);
      wrong password → `InvalidCredentials` (401); an expired session is rejected.
- [ ] Passwords stored as **argon2id**; tokens stored as **SHA‑256** and compared with
      `timingSafeEqual`; no plaintext secrets at rest; secrets carried as `Redacted`.
- [ ] Real SQL runs via `@effect/sql-pg`; schema applied via the `@effect/sql` Migrator.
- [ ] **The server runs pending migrations automatically on startup** (schema always up to
      date); the same runner is available as `npm run db:migrate`.
- [ ] `build` + `typecheck` + `lint` (0 errors/0 warnings, complexity caps respected) +
      unit `test` all pass; **default `npm test` (unit tier) needs no Postgres**;
      `GET /health` still 200 without a DB.
- [ ] **The E2E test runner** boots the whole system + dependencies in Docker, creates a
      **uniquely-named database per test**, runs the **actual migrations**, exercises the
      running system over HTTP, then **drops that database** and tears the stack down —
      leaving no residual databases and no cross-test data leakage.
- [ ] No `../../..` imports; shared schemas remain the single source of truth; docs/ADR
      updated and committed on `project-setup`.

## Risks

| Risk | Mitigation |
|------|-----------|
| `argon2` native (node-gyp) build fragility | Keep argon2id per D2; documented `scrypt` fallback if the env can't build it |
| DB required in the default test gate | In-memory `AuthRepo` test layer for domain tests; Postgres integration test gated behind compose |
| Runtime wiring forces a Postgres connection at boot/health | Keep migration/DB work in the entrypoint, not `buildApp()`; rely on the lazy `postgres` client; verify `buildApp()`/health boot DB-less |
| Complexity caps vs non-trivial domain functions | Decompose; inject deps via Effect context rather than parameters |
| Secret leakage | `Redacted` end-to-end; never log or return password/token hashes |
| Per-test DB create + migrate cost (E2E tier is slow) | Use a migrated **template database** (`CREATE DATABASE ... TEMPLATE`) so per-test setup is a fast clone; parallelize; always `DROP DATABASE` in teardown even on failure |
| Startup migration hook breaks hermetic unit tests | Run migrations in the entrypoint/boot step (or an env-gated plugin), never in the pure `buildApp()` factory |
| Leaked/orphaned test databases on crash | Unique generated names + guaranteed teardown; a sweeper that drops stale `test_*` DBs; ephemeral Docker Postgres (tmpfs) discarded at stack teardown |
