# billing-service

TypeScript monorepo for the billing-service payment gateway.

> **Status:** skeleton + first real module. The monorepo skeleton
> ([docs/10](./docs/10-project-setup-spec.md), [docs/11](./docs/11-project-setup-plan.md))
> is complete, and **`auth` is the first module with real logic** — real SQL,
> a real Postgres connection, and migrations
> ([docs/12](./docs/12-auth-spec.md), [docs/13](./docs/13-auth-plan.md)). Other
> domain modules are not implemented yet.

## Packages

| Package             | Scope                       | Purpose                                                                                                                                                                                                                                                              |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`   | `@billing-service/shared`   | Single source of truth for data: Effect Schemas (types derived), numeric enums, constants, computed types (e.g. `CreateSubscription = Subscription.omit('id')`). No data transformation across db/backend/frontend.                                                  |
| `packages/backend`  | `@billing-service/backend`  | Fastify + `@fastify/autoload`. System `plugins/` load before `modules/{name}/{routes,domain,data-access,*.plugin}`. Effect for result types & DI (services as functions, not classes). `TaskRegistry` over the docs/09 Postgres queue; separate `worker` entrypoint. |
| `packages/frontend` | `@billing-service/frontend` | Placeholder — validates the shared config across all three packages. No app yet.                                                                                                                                                                                     |

## Conventions

- **Imports:** `@/` is each package's `src` root (e.g. `@/modules/health/routes.js`); cross-package uses `@billing-service/*`. No `../../..` ladders.
- **TypeScript:** one strict `tsconfig.base.json` extended everywhere. Build with `tsc -b` project references + `tsc-alias`; dev with `tsx`. NodeNext requires `.js` import extensions; `verbatimModuleSyntax` requires `import type` for type-only imports.
- **Lint/format:** one root ESLint flat config (`typescript-eslint` strict-type-checked + complexity caps) + Prettier. Run from the root.
- **Tests:** Vitest workspace + `@effect/vitest`.

## Requirements

- Node.js 20+
- Docker (for the local database)

## One-time host setup

The docker-compose services bind to a **project-specific loopback IP** so their
ports never clash with other projects on `127.0.0.1`. Add to `/etc/hosts`:

```text
127.0.0.2  billing-service.local
```

On **macOS**, `127.0.0.2` is not a live loopback address by default — add the
alias (once per boot) so Docker can bind to it:

```bash
sudo ifconfig lo0 alias 127.0.0.2 up
```

(Linux routes all of `127.0.0.0/8` to loopback, so no alias is needed.)

Postgres is then reachable at `billing-service.local:5432` (dev) — even if
another project already uses `127.0.0.1:5432`.

## Scripts

```bash
npm install            # link all workspaces
npm run build          # turbo: shared -> backend (-> frontend), tsc + tsc-alias
npm run typecheck      # strict type-check across packages
npm run lint           # eslint (strict + complexity) + prettier --check
npm test               # vitest across packages (builds first via turbo) — hermetic, no Postgres
npm run test:e2e       # Dockerized auth E2E (spins up Postgres, per-test DB, tears down)
npm run db:up          # start dev Postgres on billing-service.local:5432
npm run db:test:up     # start isolated test Postgres (127.0.0.2:5433)

# Run the backend:
npm run dev  -w @billing-service/backend         # tsx (dev)
npm run start -w @billing-service/backend        # node dist (after build)
npm run start:worker -w @billing-service/backend # dispatcher worker (skeleton)
npm run db:migrate -w @billing-service/backend   # apply migrations (same runner as startup)
```

Environment variables: see [.env.example](./.env.example).

## Auth module

The first real module. A bootstrap **admin credential** (`ADMIN_TOKEN`, presented
as `Authorization: Bearer <token>`, hash-verified and never stored) manages
credentials; operators sign in for a session. Passwords are hashed with
**argon2id**; tokens/sessions are stored as SHA-256 and compared in constant time.

| Method + Path          | Auth           | Purpose                                   |
| ---------------------- | -------------- | ----------------------------------------- |
| `POST /auth/tokens`    | admin bearer   | Mint an auth token (`alias` + `role`)     |
| `POST /auth/operators` | admin bearer   | Create an operator (`login` + `password`) |
| `POST /auth/sessions`  | none (sign-in) | Operator signs in → session (+ token)     |

Errors map to `401` (bad/missing admin token or credentials), `403` (reserved),
and `409` (duplicate `login`/`alias`). Roles are the numeric `Role` enum in
`@billing-service/shared` (`Admin=0, Operator=1, Service=2`).

**Migrations run automatically on server startup** (see `src/main.ts`) so the
schema is always current; the same runner is exposed as `npm run db:migrate`.
Migrations are typed Effect modules in `packages/backend/src/migrations/`
(compiled to `dist/migrations/`), applied by the `@effect/sql` migrator.

**Testing** has two tiers: the default `npm test` runs hermetic unit tests (an
in-memory repo + real hasher, **no Postgres**), while `npm run test:e2e` runs the
whole system over HTTP against a real, freshly-migrated Postgres in Docker,
provisioning and dropping a unique database per test (requires Docker).
