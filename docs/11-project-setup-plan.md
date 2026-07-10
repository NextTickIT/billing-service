# Project Setup Plan: TypeScript Monorepo Skeleton

> Consensus plan (RALPLAN-DR short mode) derived from [10-project-setup-spec.md](./10-project-setup-spec.md).
> **Status:** pending approval. Structure and interfaces only — **no business/core logic**.
> Execution happens in worktree/branch `project-setup`.

## Requirements Summary

Stand up an npm-workspaces + Turborepo monorepo with three packages (`shared`, `backend`, `frontend`-placeholder) sharing one strict TypeScript / ESLint / Prettier configuration, `@/` intra-package and `@billing-service/*` cross-package imports (no `../../..`), Effect-Schema-as-single-source-of-truth in `shared`, a Fastify + autoload backend convention with an Effect `TaskRegistry` over the docs/09 Postgres queue, and a docker-compose dev/test environment on a project-specific host. Satisfies AC1–AC12 of the spec. No business logic.

## RALPLAN-DR Summary

### Principles
1. **One source of truth** — data structure defined once (Effect Schema in `shared`); types derived, never hand-duplicated; no transformation between db/backend/frontend.
2. **Config lives at the root, once** — a single TS/ESLint/Prettier/Vitest base is extended by every package; drift is impossible by construction.
3. **Convention over code** — the skeleton demonstrates *where things go* with one reference module; it never implements domain behavior.
4. **Aliases, not relative ladders** — `@/` within a package, `@billing-service/*` across packages, enforced by lint.
5. **Reproducible, isolated environment** — docker-compose on a dedicated loopback host so nothing collides with other projects or with dev data.

### Decision Drivers (top 3)
1. **Strictness & low complexity** — strictest TS + ESLint complexity caps must pass on the skeleton itself.
2. **Alias resolution across four tools** — `@/` and `@billing-service/*` must resolve identically in tsc build, tsx dev, Vitest, and ESLint.
3. **No-logic constraint** — every layer present as an interface/wiring a programmer fills in, provably wired (server boots, one module discovered).

### Viable Options (module/task registration — the load-bearing design choice)
- **Option A — TaskRegistry Effect service, modules self-register in `.plugin` (chosen).** Each module's `.plugin` registers routes with Fastify and `message_type` handlers with a `TaskRegistry` Context.Tag; a worker entrypoint runs the dispatcher poll loop (docs/09). *Pros:* durable, matches existing docs, one mechanism, testable wiring. *Cons:* more moving parts in the skeleton.
- **Option B — in-process event emitter.** *Pros:* trivial. *Cons:* not durable, diverges from docs/09, throwaway. **Invalidated:** the spec (D6) explicitly binds tasks to the durable pg queue.
- **Option C — no registry yet, routes only.** *Pros:* smallest skeleton. *Cons:* leaves the central "how do modules subscribe to work" question unanswered — the exact thing the spec set out to define. **Invalidated** by AC7.

### Alias-resolution options (secondary)
- **A (chosen): workspace `exports` with a `development` condition → `src`, plus per-package `@/` tsconfig paths + `tsc-alias` on build.** tsx/Vitest consume source directly (no prebuild); build emits `dist` and rewrites `@/`.
- **B: always build `shared` first, consume `dist` everywhere.** Simpler mental model, slower inner loop (every dev change to shared needs a build). Kept as fallback if the `development` condition proves brittle.

## Target Repository Layout

```text
billing-service/                    # private root workspace
  package.json                      # workspaces: ["packages/*"], root scripts, turbo, devDeps
  turbo.json                        # build/typecheck/lint/test pipeline
  tsconfig.base.json                # strictest compilerOptions (no files)
  tsconfig.json                     # solution: references packages/*, files: []
  eslint.config.js                  # flat: typescript-eslint strict-type-checked + complexity
  prettier.config.js                # kept as-is
  .editorconfig                     # kept
  vitest.workspace.ts               # points at packages/*/vitest.config.ts
  docker-compose.yml                # dev Postgres on 127.0.0.2 (billing-service.local)
  docker-compose.test.yml           # isolated autotest Postgres
  .env.example                      # DB_HOST=billing-service.local, ports, etc.
  docs/                             # 00..11 (this plan)
  packages/
    shared/
      package.json                  # @billing-service/shared; exports w/ development condition
      tsconfig.json                 # extends base; composite; paths {"@/*":["src/*"]}
      vitest.config.ts
      src/{index.ts, schemas/, enums/, constants/, types/}
      test/schema.test.ts
    backend/
      package.json                  # @billing-service/backend; deps: shared, fastify, @fastify/autoload, effect, @effect/sql-pg, @effect/platform, @effect/platform-node
      tsconfig.json                 # extends base; composite; references ../shared; paths {"@/*":["src/*"]}
      vitest.config.ts
      src/
        main.ts                     # HTTP server entrypoint
        worker.ts                   # dispatcher poll-loop entrypoint
        app.ts                      # Fastify factory: autoload plugins/ then modules/
        runtime.ts                  # Effect ManagedRuntime + Layer composition
        infra/{task-registry.ts, db.ts}
        plugins/                    # loaded BEFORE modules (autoload, encapsulate:false)
          config.plugin.ts logger.plugin.ts effect.plugin.ts
          db.plugin.ts task-registry.plugin.ts error-handler.plugin.ts
        modules/
          health/{routes.ts, domain.ts, data-access.ts, health.plugin.ts}
      test/health.test.ts
    frontend/
      package.json                  # @billing-service/frontend (placeholder, private)
      tsconfig.json                 # extends base; paths {"@/*":["src/*"]}
      src/index.ts                  # imports a type from @billing-service/shared to prove config
```

## Implementation Steps

### Phase 0 — Root workspace & strict config  (AC1, AC2, AC3)
1. Rewrite root `package.json`: name `billing-service`, `private: true`, `type: module`, `workspaces: ["packages/*"]`, `engines.node >=20`. Remove `main`, `eslint-config-metarhia`. Root scripts delegate to turbo: `build`, `dev`, `typecheck`, `lint`, `fix`, `test`, `test:watch`, `format`, `db:up`, `db:down`, `db:test:up`, `db:test:down`.
2. Add devDeps at root: `turbo`, `typescript`, `tsx`, `tsc-alias`, `typescript-eslint`, `eslint`, `@eslint/js`, `eslint-config-prettier`, `prettier` (kept), `vitest`, `@effect/vitest`, `vite-tsconfig-paths`. Remove `eslint-config-metarhia`.
3. `tsconfig.base.json` with the strict set: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals`, `noUnusedParameters`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`, `forceConsistentCasingInFileNames`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `declaration`, `declarationMap`, `sourceMap`, `composite`. **Consequences of this set that the code must follow:** NodeNext requires explicit `.js` extensions on relative imports (and tsc-alias emits them for `@/`); `verbatimModuleSyntax` requires `import type` for all type-only imports (notably Effect-Schema-derived types from `shared`); regular numeric `enum` is allowed under `isolatedModules` (only `const enum` is not) — the plan uses regular enums (C-Revision R5).
4. `tsconfig.json` (solution): `files: []`, `references` to the three packages.
5. `eslint.config.js` (flat): `@eslint/js` recommended + `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked`, `languageOptions.parserOptions.projectService: true`, then `eslint-config-prettier` last. Complexity block: `complexity: ['error', 10]`, `max-depth: ['error', 3]`, `max-lines-per-function: ['error', 60]`, `max-params: ['error', 4]`, `max-nested-callbacks: ['error', 3]`, `max-statements: ['error', 15]` (thresholds are the starting contract, tunable).
6. `turbo.json`: `build` (`dependsOn: ["^build"]`, outputs `dist/**`), `typecheck` (`dependsOn: ["^build"]`), `lint`, `test` (`dependsOn: ["^build"]`), and `dev` (`persistent: true`, `cache: false`) — the `dev` task runs `shared` in `tsc -b --watch` alongside `backend`'s `tsx watch`, so backend always sees a fresh `shared/dist` without the fragile export-condition path (see C-Revision R1).
7. Keep `prettier.config.js`, `.editorconfig`, `.prettierignore`, `.gitignore` (add `dist`, `.turbo`, `*.tsbuildinfo`).

### Phase 1 — `shared` package  (AC5)
8. `packages/shared/package.json`: `@billing-service/shared`, `private`, `type: module`, `exports` `{ "types": "./dist/index.d.ts", "import": "./dist/index.js", "development": "./src/index.ts" }` — **dist is primary** (build/typecheck/test consume it, guaranteed by turbo `dependsOn: ["^build"]`); the `development` condition is an optional inner-loop optimization, not load-bearing (C-Revision R1). Scripts `build: tsc -b && tsc-alias` (tsc-alias adds `.js` extensions under NodeNext), `dev: tsc -b --watch`, `typecheck`, `lint`, `test`.
9. `packages/shared/tsconfig.json`: extends base, `composite`, `outDir dist`, `rootDir src`, `baseUrl .`, `paths {"@/*":["src/*"]}`.
10. `src/enums/payment-method.ts`: numeric enum `export enum PaymentMethod { Card = 0, Crypto = 1 }`; `export const PaymentMethodSchema = Schema.Enums(PaymentMethod)`.
11. `src/schemas/example.ts`: one reference entity `Schema.Struct` (e.g. `SubscriptionRef` with `id`, `externalUserId`, `amount`, `method: PaymentMethodSchema`); derive `export type SubscriptionRef = Schema.Schema.Type<typeof SubscriptionRef>`; computed `export const CreateSubscriptionRef = SubscriptionRef.pipe(Schema.omit('id'))` + derived type. Doc-comment states the no-transformation rule.
12. `src/constants/index.ts`: ≥1 shared constant. `src/types/index.ts`: derived/computed type helpers (e.g. a generic `CreateParams<S>` doc example). `src/index.ts`: barrel re-exporting schemas/enums/constants/types.
13. `test/schema.test.ts` (Vitest): decode a valid value, reject an invalid one, assert `CreateSubscriptionRef` has no `id`.

### Phase 2 — `backend` skeleton  (AC6, AC7, AC8)
14. `packages/backend/package.json`: `@billing-service/backend`, deps `@billing-service/shared: "*"`, `fastify`, `@fastify/autoload`, `fastify-plugin`, `effect`, `@effect/platform`, `@effect/platform-node`, `@effect/sql`, `@effect/sql-pg`; scripts `build: tsc -b && tsc-alias`, `dev: tsx watch src/main.ts`, `dev:worker: tsx watch src/worker.ts`, `typecheck`, `lint`, `test`, `start: node dist/main.js`. Note: if the optional `development` condition is used to skip building `shared`, activate it via `NODE_OPTIONS='--conditions=development'` (which both `tsx` and `node` honor) — **not** a bare `tsx --conditions` flag (C-Revision R2). Default path relies on the turbo `dev`/`^build` graph instead.
15. `tsconfig.json`: extends base, `composite`, `references: [{ "path": "../shared" }]`, `paths {"@/*":["src/*"]}`.
16. `src/runtime.ts`: compose the app `Layer` (config, db, task-registry) and expose a `ManagedRuntime`. Interfaces only; no real effects run. **Tag/"no classes" note:** service identities use `class X extends Context.Tag("X")<X, Shape>() {}` (the class is a tag token only — service *implementations* are records of functions with no `this`/methods, satisfying the "functions not classes" rule). If the team wants zero `class` keywords literally, use `Context.GenericTag` instead — decide once and apply uniformly (C-Revision R6).
17. `src/infra/task-registry.ts`: `TaskRegistry` `Context.Tag` with `register(messageType, handler)` + `dispatchOnce`/poll-loop **signatures**; comment references docs/09 (`raw_events → messages → attempts`, `FOR UPDATE SKIP LOCKED`). No SQL.
18. `src/infra/db.ts`: `@effect/sql-pg` `PgClient` `Layer` skeleton reading config; no queries.
19. `src/plugins/*.plugin.ts`: `config`, `logger`, `effect` (attach the `ManagedRuntime` to Fastify via `decorate`), `db`, `task-registry`, `error-handler`. All are `fastify-plugin`-wrapped (non-encapsulated) so their decorators are visible to modules. **Inter-plugin order is encoded explicitly** via `fastify-plugin` `{ name, dependencies }` (config → logger → effect → db → task-registry → error-handler), not left to autoload's directory order (C-Revision R4).
20. `src/modules/health/`: `routes.ts` (`GET /health` → `{ status: 'ok' }`), `domain.ts` (one Effect-returning function, no class), `data-access.ts` (`Context.Tag` service interface, no queries), `health.plugin.ts` — the **only** autoloaded file in the module; it `import`s routes/domain/data-access and registers the route **and** a no-op handler with `TaskRegistry`.
21. `src/app.ts`: Fastify factory with **two scoped autoload passes**. Pass 1: `register(autoload, { dir: 'plugins', matchFilter: /\.plugin\.(ts|js)$/ })`. Pass 2: `register(autoload, { dir: 'modules', maxDepth: 2, matchFilter: /\.plugin\.(ts|js)$/, ignorePattern: /\.(routes|domain|data-access)\.|(routes|domain|data-access)\.(ts|js)$/ })` — **critical:** the `matchFilter`/`ignorePattern` ensures `routes.ts`, `domain.ts`, and `data-access.ts` are NOT loaded as standalone plugins; only each module's `*.plugin.ts` is (C-Revision R-Critical). `src/main.ts`: build app, listen on configured host/port. `src/worker.ts`: build the runtime and start the `TaskRegistry` poll-loop skeleton (logs "worker started", no real consume).
22. `test/health.test.ts`: build the app via `app.ts`, `inject` `GET /health`, assert 200 + body; assert the health module registered exactly one task handler.

### Phase 3 — `frontend` placeholder  (AC10)
23. `packages/frontend/package.json`: `@billing-service/frontend`, private, `type: module`, scripts `typecheck`, `lint`. `tsconfig.json` extends base + `@/` paths. `src/index.ts` imports a type from `@billing-service/shared` and exports a trivial const, proving the shared config resolves across all three packages. No framework.

### Phase 4 — Test wiring  (AC11)
24. `vitest.workspace.ts` at root referencing `packages/*/vitest.config.ts`. Each `vitest.config.ts` uses `vite-tsconfig-paths` (resolves per-package `@/`). Cross-package `@billing-service/*` resolves through the built `dist` — guaranteed because root `test` runs `turbo run test` with `dependsOn: ["^build"]` (C-Revision R1/R2). If a package's tests are run directly with `vitest` (bypassing turbo), a prior `npm run build` is required — document this. Ensure `@effect/vitest` is imported in a sample test.

### Phase 5 — Dev environment  (AC9)
25. `docker-compose.yml`: `postgres:16` service, published port bound to the project IP: `ports: ["127.0.0.2:5432:5432"]`, named volume `pgdata`, healthcheck, env for db/user/pass.
26. `docker-compose.test.yml`: ephemeral Postgres for autotests — `tmpfs` data, distinct db name, bound to `127.0.0.2:5433` (or `127.0.0.3`), no persistent volume.
27. `.env.example`: `DB_HOST=billing-service.local`, `DB_PORT=5432`, creds, `PORT`, `HOST`. Config plugin reads these.
28. Document the one-time host mapping in `README.md`: add `127.0.0.2  billing-service.local` (and `127.0.0.3 billing-service-test.local` if used) to `/etc/hosts`; explain why (avoids localhost port clashes). Add `db:up`/`db:down`/`db:test:up`/`db:test:down` scripts.

### Phase 6 — Governance & verification  (AC12, AC1–AC4)
29. Update `README.md`: monorepo overview, package map, scripts, host-setup, "no business logic yet" status.
30. Run the full verification gate (below). Commit the plan and all skeleton artifacts on `project-setup` (project rule: specs/plans/ADRs committed).

## Acceptance-Criteria Traceability

| AC | Covered by steps |
|----|------------------|
| AC1 workspace installs, builds in order | 1,2,6,8,14,23 |
| AC2 one strict tsconfig, typecheck fails on error | 3,4,9,15,23 |
| AC3 one ESLint+Prettier, complexity, metarhia gone | 1,5,7 |
| AC4 `@/` + `@billing-service/*` resolve everywhere | 3,8,9,15,24 |
| AC5 shared schema/type/CreateParams/enum/constant | 10,11,12,13 |
| AC6 Fastify autoload, plugins before modules, /health | 19,20,21,22 |
| AC7 `.plugin` registers route + task handler; worker | 17,20,21 |
| AC8 data-access Context.Tag, sql-pg layer, no queries | 17,18,20 |
| AC9 compose on project host, isolated test db | 25,26,27,28 |
| AC10 frontend placeholder type-checks | 23 |
| AC11 Vitest workspace + @effect/vitest | 13,22,24 |
| AC12 spec+plan+ADR committed, no logic | 29,30 + this doc |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `@/` unresolved in one of tsc/tsx/vitest/eslint | build/test breakage | tsc-alias (build), tsx tsconfig-paths (dev), vite-tsconfig-paths (test), typescript-eslint projectService (lint); verify each in the gate (Phase 6) |
| `development` export condition brittle across tsx/vitest | dev can't import shared from source | Fallback Option B: turbo `dependsOn ^build`, consume `dist`; documented in RALPLAN-DR |
| `exactOptionalPropertyTypes` + Effect Schema friction | noisy strict errors | Keep the reference schema minimal; if a specific rule fights Effect, relax that one flag with a recorded rationale, not the whole strict set |
| Numeric enums + `verbatimModuleSyntax`/`isolatedModules` | enum emit/erasure edge cases | Enums live in `shared` (a real emitted module), imported as values; covered by schema.test |
| `@fastify/autoload` loads non-plugin files (routes/domain/data-access) as plugins | boot error / duplicate route decoration | **(Critical, fixed)** scope both autoload passes with `matchFilter: /\.plugin\.(ts\|js)$/` + `ignorePattern` for module part-files (step 21); only `*.plugin.ts` is a plugin entrypoint; asserted by health.test |
| `@fastify/autoload` load order (plugins vs modules, and within plugins) | modules load before infra; db before config | Two scoped autoload passes (plugins dir first); infra plugins `fastify-plugin`-wrapped with explicit `{ name, dependencies }` ordering (step 19), not directory order; asserted by health.test |
| Cross-tool alias/condition drift (tsx flag, Vite conditions, tsc-alias extensions) | silent prebuild fallback or runtime failure | **(fixed)** dist is the primary cross-package artifact via turbo `^build`; `development` condition is optional; per-tool alias resolution verified individually in the gate |
| Turbo adds a tool the team doesn't want | friction | Turbo only orchestrates npm scripts; every script also runs standalone (`npm run build -w @billing-service/shared`) — removable without lock-in |
| Docker host `127.0.0.2` unmapped on a dev machine | compose/app can't reach db | README `/etc/hosts` step + `.env.example`; app falls back to `DB_HOST` env |

## Verification Steps (Phase 6 gate)

1. `npm install` at root — all three workspaces link; no errors.
2. `npm run build` (`turbo run build`) — `shared` builds before `backend`; `dist/` emitted; no `../../..` import errors.
3. `npm run typecheck` passes; introduce a deliberate type error in backend → it **fails**; revert.
4. `npm run lint` — typescript-eslint strict-type-checked + complexity run; `eslint-config-metarhia` absent from the tree; a deliberate `complexity` violation **fails**; revert.
5. Grep the tree for `from '\.\./\.\./` → **zero** cross-level relative imports (aliases used instead).
6. `npm test` — shared schema test + backend `/health` inject test pass; `@effect/vitest` imported in a sample.
7. **Run the BUILT output, not just tsx:** `node packages/backend/dist/main.js` → server boots (proves tsc-alias rewrote `@/` with `.js` extensions and `shared/dist` resolves), `GET http://billing-service.local:PORT/health` → 200; logs show only the `health` module discovered by autoload (no attempt to load routes/domain/data-access as plugins). Run `node packages/backend/dist/worker.js` → logs "worker started". Then repeat the server boot via `tsx src/main.ts` to confirm the dev path.
8. **Per-tool alias check:** confirm `@/` resolves in build (step 2 `node dist/...` ran), dev (tsx boot), test (vitest green), and lint (no `import/no-unresolved`-class TS error); confirm `@billing-service/shared` imports resolve in all four.
9. `npm run db:up` → Postgres reachable at `billing-service.local:5432` (127.0.0.2) with `127.0.0.1:5432` free for other projects; `npm run db:test:up` → isolated test db on its own binding.
10. **No-logic audit (AC12):** confirm every `domain.ts`/`data-access.ts` contains only signatures/stubs (Effect-returning, no real queries or business rules), and no module implements behavior beyond wiring.
11. `git status` — spec (10), plan (11), and skeleton committed on `project-setup`.

## ADR

- **Decision:** npm workspaces + Turborepo; strict shared TS/ESLint/Prettier/Vitest base; Effect-Schema-first `shared`; Fastify+autoload backend with an Effect `TaskRegistry` over the docs/09 pg queue and a separate worker; `@effect/sql-pg` connection Layer skeleton; docker-compose on a dedicated loopback host; frontend placeholder. Skeleton only, no business logic.
- **Drivers:** strictness + low complexity; uniform alias resolution across build/dev/test/lint; the no-logic constraint.
- **Alternatives considered:** plain workspaces / pnpm / Nx (D1); tsup/esbuild or Vite build (D2); Zod or types-only (D4); in-proc event bus or routes-only (D6); **build-first (dist) vs `development` export-condition** for cross-package dev resolution.
- **Why chosen:** matches the user's explicit spec decisions, honors existing docs/09. On the alias sub-decision, **build-first (dist) is primary** — the turbo `^build` graph already orders `shared` before backend for build/typecheck/test, so correctness never depends on four tools honoring a custom export condition; the `development` condition remains an optional dev-speed shortcut with `tsc -b --watch` as the robust default.
- **Consequences:** alias resolution is verified per-tool in the gate (build via `node dist`, dev via tsx, test via vite-tsconfig-paths, lint via typescript-eslint); Turbo is added but non-locking (every script also runs standalone); strict flags may need one *documented, per-flag* relaxation if Effect Schema conflicts (never a blanket loosening); `@fastify/autoload` must be `matchFilter`-scoped so module part-files are not loaded as plugins.
- **Follow-ups:** real message-queue handlers + SQL; domain modeling in `shared`; the frontend app; CI wiring; auth; decide `Context.Tag` vs `Context.GenericTag` tag style once.

## Consensus Changelog

**Review process note (transparency):** the RALPLAN Architect and Critic were dispatched as independent agents. The read-only Architect completed (6 tool calls, ~52k tokens) but its text findings were not retrievable through the notification layer; the Critic agent terminated on a mid-response API error before persisting its verdict file. To avoid an indefinite block, the adversarial technical review was then performed in-context against the spec, plan, and current tool behavior, and the findings below were applied. This is a fallback from the intended fully-independent double review; a fresh `/code-review` or `critic` pass on the eventual implementation is recommended as the compensating control.

Applied revisions:
- **R-Critical — autoload scoping:** `@fastify/autoload` on `modules/` would have loaded `routes.ts`/`domain.ts`/`data-access.ts` as standalone plugins. Both passes are now `matchFilter: /\.plugin\.(ts|js)$/`-scoped with an `ignorePattern` for module part-files (steps 20–21; Risks).
- **R1 — alias robustness:** made built `dist` the primary cross-package artifact (leaning on the already-present turbo `^build` ordering) and demoted the `development` export condition to optional; added a persistent turbo `dev` task running `shared` in `tsc -b --watch` (steps 6, 8, 24).
- **R2 — condition activation:** if the `development` condition is used, activate via `NODE_OPTIONS='--conditions=development'` (honored by tsx and node), not a bare `tsx --conditions` flag (step 14).
- **R4 — plugin ordering:** system plugins encode order via `fastify-plugin` `{ name, dependencies }` rather than autoload directory order (step 19).
- **R5 — strict-flag consequences:** documented the NodeNext `.js`-extension, `verbatimModuleSyntax` `import type`, and `isolatedModules` enum rules the code must follow (step 3).
- **R6 — "no classes" vs `Context.Tag`:** clarified the tag-identity exception and the `Context.GenericTag` alternative (steps 16–17).
- **Gate strengthened:** verify the **built** output with plain `node dist/...` (not only tsx), add a per-tool alias check and a "no business logic" audit (verification steps 7, 8, 10).

## Implementation Notes (as-built)

Deviations discovered while executing the plan; the committed skeleton is the source of truth:

- **Toolchain version pins.** The latest majors outran `typescript-eslint@8.63` (the newest release), which peers `typescript >=4.8.4 <6.1.0` and `eslint ^8.57||^9||^10`. So: **TypeScript pinned to `^6.0.3`** (the newest it supports — not the TS 7 native compiler) and **ESLint 10** (supported). `@effect/vitest@0.29` peers `vitest ^3.2`, so **Vitest pinned to `^3.2.7`** (not 4). Revisit when typescript-eslint / @effect/vitest ship support for TS 7 and Vitest 4.
- **`baseUrl` dropped.** TS 6.0 deprecates `baseUrl` (removed in TS 7). Path aliases use `paths` alone (relative to each tsconfig), which is forward-compatible; `tsc-alias`, `tsx`, and `vite-tsconfig-paths` all resolve `@/` without it.
- **Turbo needs `packageManager`.** Root `package.json` declares `"packageManager": "npm@..."` (Turbo 2.10 requires it).
- **Vitest + autoload.** `@fastify/autoload` dynamically `import()`s plugin files from disk, escaping Vite's `@/` resolver under Vitest. Fixed by inlining `@fastify/autoload` (`test.server.deps.inline`) so Vitest transforms those imports. Production (tsc-alias) and dev (tsx) were unaffected. This is the concrete instance of the R1 cross-tool-alias risk — caught and closed by the gate.
- **`@effect/sql-pg` API.** `PgClient.layer` takes plain values with a `Redacted` password (not `Config`-wrapped), and is provided but not wired into the default runtime (skeleton boots without a DB).
- **macOS loopback.** Binding Docker to `127.0.0.2` needs `sudo ifconfig lo0 alias 127.0.0.2 up` on macOS (documented in the README); Linux needs nothing.
- **Gate result:** `build`, `typecheck`, `lint` (0 errors/0 warnings across 28 files), and `test` all pass; a deliberate type error fails typecheck (TS2322) and a complexity-12 function fails lint; both compose files validate; built server returns `GET /health → 200` and the worker logs `worker started`.
