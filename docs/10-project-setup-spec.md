# Project Setup Spec: TypeScript Monorepo Skeleton

> Deep-interview spec. Structure and interfaces only — **no business/core logic is implemented**.
> This document is the input for the next phase (plan + ADRs).

## Metadata

- Type: brownfield (existing JS/Metarhia tooling reconciled)
- Rounds: 3 (+ topology gate)
- Final ambiguity: ~11.7% (threshold 20%, source: default)
- Status: PASSED
- Scope: monorepo tooling, `shared`, `backend`, dev environment; `frontend` deferred (placeholder)

## Clarity Breakdown

| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.92 | 0.35 | 0.322 |
| Constraint Clarity | 0.88 | 0.25 | 0.220 |
| Success Criteria | 0.88 | 0.25 | 0.220 |
| Context Clarity | 0.90 | 0.15 | 0.135 |
| **Total Clarity** | | | **0.897** |
| **Ambiguity** | | | **0.103–0.117** |

## Topology

| Component | Status | Description | Coverage |
|-----------|--------|-------------|----------|
| Monorepo tooling & workspace | active | npm workspaces + Turborepo, shared TS/ESLint/Prettier, build/test structure, root scripts | AC1–AC4, AC11 |
| `shared` package | active | Effect Schema contracts, numeric enums, constants, computed types | AC5 |
| `backend` skeleton | active | Fastify + autoload, plugins/modules structure, Effect services-as-functions, TaskRegistry | AC6–AC8 |
| Dev environment | active | docker-compose dev/test/autotest, project-specific host, Postgres | AC9 |
| Governance | active | spec/ADR/plan committed | AC12 |
| `frontend` package | deferred | empty placeholder that validates the 3-package shared config; no app | AC10 (placeholder only) — deferred at Round 0 |

## Goal

Stand up a TypeScript monorepo **skeleton** where every package shares identical strict TS / ESLint / Prettier rules, cross-package and intra-package imports use aliases (never `../../..`), the data structure is defined exactly once in `shared` and flows unchanged to db/backend/frontend, the backend expresses a clear Fastify-autoload module convention, and a docker-compose environment runs on a project-specific host that cannot clash with other projects' ports. The output lets any programmer see **what goes where and how to approach each task** without any business logic being written.

## Decisions (ADR-style)

### D1 — Workspace & build orchestration
- **Decision:** npm workspaces + **Turborepo**. Root is a private package `billing-service`; members under `packages/*`.
- **Package scope:** `@billing-service/shared`, `@billing-service/backend`, `@billing-service/frontend`. Cross-package imports use the scope (e.g. `@billing-service/shared`), never relative paths.
- **Intra-package alias:** `@/` maps to each package's `./src` (e.g. `@/modules/...`). No `../../../` imports anywhere.
- **Alternatives:** plain npm workspaces (no caching), pnpm+Turbo (switches lockfile), Nx (too heavy). Turbo chosen for task caching without changing the package manager.

### D2 — TypeScript build & dev-run
- **Decision:** Build with `tsc -b` **project references** (composite), then **`tsc-alias`** to rewrite `@/` in emitted output. Dev-run with **`tsx`** (resolves tsconfig `paths` natively, watch mode).
- **Strictness:** one root `tsconfig.base.json` with the strictest practical flags — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`, `forceConsistentCasingInFileNames`. Every package `tsconfig.json` extends it, sets `composite: true`, declares `references` to its deps, and `paths: { "@/*": ["./src/*"] }`.
- **Alternatives:** tsup/esbuild bundling (rejected: user chose tsc project refs), Vite lib mode (deferred to frontend).

### D3 — Lint & format (replace Metarhia)
- **Decision:** Remove `eslint-config-metarhia`. Root flat `eslint.config.js` using **`typescript-eslint` `strict-type-checked` + `stylistic-type-checked`**, plus **complexity caps** for a decomposed, low-complexity codebase: `complexity`, `max-depth`, `max-lines-per-function`, `max-params`, `max-nested-callbacks`, `max-statements` (thresholds tuned in the plan). `eslint-config-prettier` to disable conflicting rules. Per-package override sets `parserOptions.project`.
- **Format:** keep the existing `prettier.config.js` (single quotes, trailing-all, width 80, semicolons, 2-space).
- **Consequence:** identical lint/format/TS rules in every package, enforced from the root.

### D4 — Shared contracts (single source of truth)
- **Decision:** **Effect Schema** (`effect/Schema`) is the one source of truth. **Schema-first**: define a schema per entity, **derive the static type** from it (`Schema.Schema.Type<typeof X>`). Computed variants are schema operations — e.g. `CreateParams = Entity.pipe(Schema.omit('id'))`, with its type derived the same way.
- **Enums/kinds:** TypeScript **numeric** enums (stored as numbers), wrapped with `Schema.Enums(...)` for validation.
- **No transformations:** db, backend, and frontend import the same schema/type. Encode/decode happens only at process boundaries (validation); field names/shapes are never remapped between layers.
- **Alternatives:** Zod (parallel dep, weaker Effect integration), types-only (no runtime validation) — both rejected.

### D5 — Backend structure (Fastify + autoload)
- **Decision:** Fastify with **`@fastify/autoload`**. Two autoloaded directories:
  - `src/plugins/` — **system plugins loaded before any module** (config, logger, Effect runtime, `@effect/sql-pg` connection Layer, TaskRegistry/dispatcher, error handler).
  - `src/modules/{module_name}/` — one folder per module with separate files:
    - `routes.ts` — transport only (Fastify route defs)
    - `domain.ts` — domain logic as **Effect-returning functions** (services-as-functions, **no classes/methods**)
    - `data-access.ts` — an **Effect `Context.Tag`** service interface with typed method signatures (no queries)
    - `{module}.plugin.ts` — the module's Fastify plugin: registers its routes **and registers its `message_type` handler(s)** with the TaskRegistry.
- **Effect:** result/error types and DI via Effect (`Context.Tag` services, `Layer` composition, typed errors — no `throw`). Functions, not classes.

### D6 — Task registry / message queue
- **Decision:** The "specific tasks" modules listen for are the **durable Postgres message queue from `docs/09-message_queue_recomendations.md`** (`raw_events → messages → attempts`). The skeleton exposes a **TaskRegistry / dispatcher** as an Effect service; each module registers handlers for `message_type`s in its `.plugin`. Queue tables, claim loop (`FOR UPDATE SKIP LOCKED`), and dispatcher are **interface/skeleton only** — no real handlers or SQL.
- **Worker process:** per `docs/04` (background worker = separate process), the backend has **two entrypoints** — `src/main.ts` (HTTP server) and `src/worker.ts` (dispatcher poll loop) — both consuming the same module-registered handlers.

### D7 — Data access
- **Decision:** Each module's `data-access.ts` is an **Effect `Context.Tag`** with typed signatures returning `Effect`. A shared **`@effect/sql-pg` connection Layer** (system plugin) provides Postgres. **No queries / no business logic** — just the contract and wiring a programmer fills in.

### D8 — Dev environment (project-specific host)
- **Decision:** `docker-compose.yml` provisions **Postgres**. A project hostname maps to a **dedicated loopback IP** in `/etc/hosts` (`127.0.0.2  billing-service.local`); compose **publishes ports bound to that IP** (e.g. `127.0.0.2:5432`). Standard ports never clash with another project on `127.0.0.1` because the IP differs.
- **Test/autotest isolation:** a separate `docker-compose.test.yml` (or compose profile) provides an ephemeral Postgres (tmpfs, distinct DB — optionally on `127.0.0.3 billing-service-test.local`) so autotests never touch dev data.
- **Docs:** the `/etc/hosts` step and connection host are documented; config/env uses `billing-service.local`, not `localhost`.

### D9 — Frontend placeholder
- **Decision:** create an empty `packages/frontend` (`@billing-service/frontend`, private) with only `package.json` + `tsconfig.json` extending the base config. No framework, no app. It exists to validate that the shared TS/lint/config story works across all 3 packages.

### D10 — Testing
- **Decision:** **Vitest** with a workspace config (`vitest.workspace.ts`); each package extends a root vitest config; `@/` resolved via `vite-tsconfig-paths`. **`@effect/vitest`** for Effect tests. Replaces the current `node --test`.

## Constraints

- Identical TS, ESLint, and Prettier rules in every package; enforced from the root config.
- Strictest practical TypeScript; strict + complexity ESLint rules for small, decomposed units.
- Single source of truth for data structure in `shared`; **no data transformations** across db/backend/frontend.
- Computed types (e.g. `CreateParams`) are derived from schemas, never hand-duplicated.
- Enums/kinds are numeric TS enums stored as numbers.
- No `../../..` imports — `@/` intra-package, `@billing-service/*` cross-package.
- docker-compose must not clash with other projects' localhost ports (project-specific host).
- **No services or core/business logic implemented** in this phase.
- All resulting spec/plan/ADR artifacts are committed.

## Non-Goals

- Any domain/business logic, real DB queries, real queue handlers, provider integrations.
- The frontend application (placeholder package only).
- Authentication/authorization implementation, CI/CD pipelines, production deploy automation.
- Modeling the full billing domain in `shared` (only reference examples that demonstrate the patterns).

## Acceptance Criteria

- [ ] **AC1** `npm install` at root wires all workspaces; `turbo run build` builds `shared → backend (→ frontend)` in dependency order; no relative cross-package imports.
- [ ] **AC2** Every package extends one `tsconfig.base.json` with the strict flag set; `turbo run typecheck` passes and a deliberate type error fails it.
- [ ] **AC3** One ESLint flat config + one Prettier config apply to all packages; `turbo run lint` runs `typescript-eslint` strict-type-checked + complexity caps; `eslint-config-metarhia` removed.
- [ ] **AC4** `@/` resolves in build (tsc-alias), dev (tsx), and test (vite-tsconfig-paths); `@billing-service/shared` is importable from backend and frontend.
- [ ] **AC5** `shared` exports ≥1 entity as an Effect Schema with a derived type, a `CreateParams` computed type (omit `id`), ≥1 numeric enum (stored as number), and ≥1 constant; backend imports a shared type with no transformation.
- [ ] **AC6** Backend boots via Fastify + autoload; system `plugins/` load before `modules/`; `GET /health` responds; autoload discovers the `health` module.
- [ ] **AC7** The `health` module's `.plugin` registers its route **and** a no-op handler with the TaskRegistry; a separate `worker` entrypoint starts the dispatcher poll-loop skeleton.
- [ ] **AC8** `data-access.ts` is an Effect `Context.Tag` service with typed signatures (no queries); an `@effect/sql-pg` connection Layer is provided; no business logic exists.
- [ ] **AC9** `docker compose up` starts Postgres reachable at `billing-service.local` (127.0.0.2) without clashing with `127.0.0.1`; a separate test compose gives an isolated DB; `/etc/hosts` setup documented.
- [ ] **AC10** `packages/frontend` placeholder exists in the workspace and type-checks against the shared config with no app code.
- [ ] **AC11** Vitest runs across all packages via a workspace config; a sample test in `shared` and `backend` passes; `@effect/vitest` available.
- [ ] **AC12** This spec and an ADR-style decision log are committed; no services or core logic implemented anywhere.

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| Reuse existing Metarhia/JS lint | Conflicts with "strictest TS + complexity" | Replace with typescript-eslint strict-type-checked + complexity; keep Prettier |
| "schemas" might mean Zod | Effect already adopted | Effect Schema, schema-first, types derived |
| Build via bundler | User prefers explicit TS | tsc project references + tsc-alias; tsx for dev |
| "project-specific host" = unique ports | Ports still clash on 127.0.0.1 | Dedicated loopback IP via /etc/hosts; compose binds ports to it |
| ".plugin listeners" = ad-hoc events | docs/09 already defines a durable queue | Modules register message_type handlers with a TaskRegistry over the pg queue |
| Skeleton = folders only | Programmers need a concrete pattern | One reference `health` module wired end-to-end |
| Frontend fully omitted | 3-package config unproven | Empty placeholder validates shared config |

## Technical Context (existing repo)

- Root `package.json` (`recurring-payments`, `type: module`, npm, Node ≥20) — to become the private workspace root `billing-service`.
- `eslint-config-metarhia` (JS-first) — **removed** per D3.
- `prettier.config.js`, `.editorconfig` — **kept**.
- `node --test` script — **replaced** by Vitest per D10.
- Product docs `00-tz.md … 09-message_queue_recomendations.md` remain the domain source; this spec is infrastructure only and defers all domain modeling.

## Ontology (Key Entities)

| Entity | Type | Fields / Shape | Relationships |
|--------|------|----------------|---------------|
| Workspace Package | core | name (`@billing-service/*`), tsconfig, deps | Turbo pipeline builds in ref order |
| Entity Schema | core | Effect Schema; derives type + CreateParams | lives in `shared`; imported unchanged everywhere |
| Numeric Enum | supporting | number-backed TS enum + Schema.Enums | referenced by schemas |
| Constant | supporting | shared constant values | in `shared` |
| System Plugin | core | Fastify plugin loaded before modules | provides Layers/services |
| Module | core | folder: routes/domain/data-access/.plugin | autoloaded; registers with TaskRegistry |
| Route | supporting | Fastify route (transport) | in a module |
| Domain Service | core | Effect-returning functions (no classes) | in a module |
| Data Access Service | core | Effect Context.Tag interface (no queries) | uses @effect/sql-pg Layer |
| TaskRegistry / Dispatcher | core | register(message_type, handler); poll loop | consumes pg message queue (docs/09) |
| Message / Queue | external | raw_events, messages, attempts | handled by module handlers |
| Connection Layer | infra | @effect/sql-pg Postgres Layer | provided to data-access |
| Compose Service / Host | infra | Postgres on billing-service.local (127.0.0.2) | dev + isolated test |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability |
|-------|-------------|-----|---------|--------|-----------|
| 0 (topology) | 6 (components) | 6 | - | - | N/A |
| 1 (tooling/shared) | 7 | 5 | - | 2 | ~29% |
| 2 (backend/env) | 11 | 4 | 0 | 7 | ~64% |
| 3 (registry/depth) | 13 | 2 | 0 | 11 | ~85% |

## Interview Transcript

<details>
<summary>Full Q&A (topology + 3 rounds)</summary>

**Round 0 — Topology:** 5 active components (frontend deferred) — confirmed "Looks right".

**Round 1 — foundational:**
- Workspace/build → **npm workspaces + Turborepo**; scope `@billing-service/*`; `@/` src-root alias (no `../../..`).
- Lint → **typescript-eslint strict-type-checked + complexity, keep Prettier** (drop Metarhia).
- Schema lib → **Effect Schema**.
- Contract direction → **schema-first, types derived** (CreateParams = omit id).

**Round 2 — backend/env:**
- Build/run → **tsc project references + tsc-alias** (dev via tsx).
- Test → **Vitest + @effect/vitest**.
- Data access → **Effect Context.Tag interfaces + @effect/sql-pg connection Layer skeleton, no queries**.
- Docker host → **/etc/hosts → dedicated loopback IP (billing-service.local → 127.0.0.2), compose binds ports to it**.

**Round 3 — registry/depth:**
- Task registry → **docs/09 Postgres message queue; modules register message_type handlers with a central dispatcher**.
- Skeleton depth → **one reference `health` module wired end-to-end + empty structure elsewhere**.
- Frontend → **empty `packages/frontend` placeholder**.

</details>
