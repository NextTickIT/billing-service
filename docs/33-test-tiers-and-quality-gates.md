# 33 — Test tiers and quality gates

Status: reference. Describes every automated check in the repository, what each
one proves, what it costs, and the command that runs it. Written for the
`showcase/testing-lecture` branch, which adds the tiers marked **new**.

## 1. The rule that places a test

A check belongs to the cheapest tier that can prove the claim. The tier is
decided by the **entry point** and the **dependencies**, not by the size of the
test:

| Tier               | Entry point                                   | Real dependencies            | Proves                                              | Cost              |
| ------------------ | --------------------------------------------- | ---------------------------- | --------------------------------------------------- | ----------------- |
| Static             | the source text                               | none                         | a class of defects cannot exist                     | seconds           |
| Unit               | a function / module                           | none (hermetic)              | the logic                                           | milliseconds      |
| Integration        | a module's internal API (Effect, repo, queue) | one real resource (Postgres) | module + resource agree (SQL, `ON CONFLICT`, locks) | seconds + Docker  |
| E2E                | the external interface (HTTP, BFF, UI)        | the whole system             | a client receives what was promised                 | seconds–minutes   |
| Mutation           | the unit tier                                 | none                         | the tests notice behaviour changes                  | minutes           |
| Performance        | the external interface                        | the whole system             | a latency budget holds under load                   | minutes           |

Coverage says what ran; mutation testing says what was checked. A green suite
with surviving mutants is a suite that proves less than it appears to.

## 2. Static gates

| Gate                           | Config                                   | Command                        |
| ------------------------------ | ---------------------------------------- | ------------------------------ |
| Formatter                      | `prettier.config.js`, `.editorconfig`    | `npx prettier --check .`       |
| Linter with complexity budgets | `eslint.config.js` (CLAUDE.md §4)        | `npm run lint` (per package)   |
| Type system                    | `tsconfig.base.json` strict flags        | `npm run typecheck`            |
| Architecture rules (**new**)   | `.dependency-cruiser.cjs`                | `npm run lint:deps`            |
| Git hooks (**new**)            | `.githooks/`                             | `npm run hooks:install`        |

`npm run lint` used to be `eslint .` over the whole monorepo; with type-aware
rules across three packages it exhausts an 8 GB heap on a 16 GB machine and
never reports. It now runs per package through turbo, which is what the hooks
and CI must call as well. A gate that cannot run is not a gate.

The dependency rules are the executable form of the layering conventions in
CLAUDE.md §3: `domain.ts` and `data-access.ts` never import `routes.ts`,
modules never import the boot layer, `src` never imports `test`, no cycles.

## 3. Unit tier — `*.test.ts`

Hermetic; run by `npm test`; no Postgres, no in-memory repositories in `src`
(CLAUDE.md §3.4). Doubles are records of functions written in the test itself
(`billing/test/scheduler.test.ts`); HTTP clients take a `fetch` spy
(`whitepay/test/client.test.ts`).

- Example-based: `payment/test/period.test.ts` (calendar clamping, leap day).
- Property-based (**new**): `payment/test/period.property.test.ts` with
  fast-check — day arithmetic, month clamping, `P1Y ≡ P12M`, no mutation of the
  input.
- Frontend (**new**): `packages/frontend/vitest.config.ts` (happy-dom);
  `src/app/period.test.ts`; component tests with Vue Test Utils
  (`BaseButton.test.ts` with a DOM snapshot and an inline snapshot,
  `BaseModal.test.ts`); a page-level scenario `session/LoginPage.test.ts` with
  a stubbed `fetch`.
- Branch coverage (**new**): `npm run test:coverage` → `coverage/index.html`.

## 4. Integration and E2E tiers — `*.e2e.ts`

One runner, `packages/backend/test/e2e/run.ts`, serves both tiers: it starts
Postgres from `docker-compose.e2e.yml`, and for every scenario creates a fresh
database, applies the **real migrations**, runs the scenario, and drops the
database in `finally`; a final sweep asserts that no `test_*` database leaked.

- Integration: `charge/test/pipeline.e2e.ts` (`effectScenarios`) drives the
  worker pipeline directly — no HTTP — against the real database. Dedup,
  `FOR UPDATE SKIP LOCKED`, the CTE writes and `ON CONFLICT` idempotency only
  run for real here.
- E2E: `auth/test/routes.e2e.ts` talks HTTP to a listening `app`, then queries
  the database to assert on data at rest; `test/e2e/edge.e2e.ts` goes through
  the Cloudflare Pages BFF handler as well.
- UI E2E (**new**): `packages/frontend/playwright.config.ts` and
  `packages/frontend/e2e/`. Without `E2E_BASE_URL` the network is stubbed
  (`fixtures.ts`) and the run proves the UI flow; with `E2E_BASE_URL` pointing
  at a running stack nothing is stubbed and the run is a true end-to-end check.
  `a11y.spec.ts` runs axe; `visual.spec.ts` compares a screenshot baseline.

  Two findings from the first run are kept as `test.fixme` instead of being
  weakened. (1) A wrong password returns 401; `src/infra/apiFetch.ts` treats
  every 401 as an expired session and sets `window.location.href`, so the page
  reloads and `store.error` is wiped before the operator sees "Invalid
  credentials." The happy-dom page test stays green because happy-dom does not
  navigate on that write — the browser tier earns its cost here. (2) axe on
  `/operator/login`: colour-contrast (labels 2.76:1 light / 2.94:1 dark, language
  switch 3.14:1; 4.5:1 required), no `main` landmark, no `h1`, content outside
  landmarks; the `<label>`s are also not linked to their inputs.

A first full run of this tier on the branch (26 HTTP scenarios green) stopped
at the pipeline scenario "exactly the Active payments due in 3 days": the test
builds its due date from the **UTC** calendar day (`setUTCDate(+3)` at 09:00
UTC) while `findUpcomingForNotice` compares calendar days in
`Europe/Kyiv`. Between 00:00 and 02:00/03:00 Kyiv the two calendars disagree
by a day and the scenario fails deterministically; by daytime it passes. The
fix belongs in the test (derive the day in the same zone as the query); it is
left as-is here as the textbook clock-dependent test.

Both backend tiers currently share the `*.e2e.ts` suffix; by the rule in §1 the
pipeline scenarios are integration tests. Renaming them `*.integration.ts` is a
candidate ADR, not a correction made on this branch.

## 5. Mutation tier (**new**)

`packages/backend/stryker.config.json` mutates `payment/period.ts`,
`payment/domain.ts` and `wayforpay/signature.ts` and runs the unit tier per
mutant through the Vitest runner. `npm run test:mutation` writes
`reports/mutation/index.html`; the run is incremental. Survivors are classified
as a real gap (write the killing test), equivalent (behaviour unchanged;
explain why), or accepted (consciously unchecked; record it).

First run on this branch — 178 mutants, 95.51% killed, 8 survived, 0 without
coverage — classified:

| # | Mutant                                                              | Class       | Why / what kills it                                                                                             |
| - | ------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| 1 | `payment/domain.ts:104` `promoBonus.length > 0` → `true`            | real gap    | no test passes `promoBonus: ''`; with the mutant an empty bonus reaches `addPeriod` and throws. One test kills #1 and #2. |
| 2 | `payment/domain.ts:104` `> 0` → `>= 0`                               | real gap    | same input class as #1.                                                                                         |
| 3 | `payment/domain.ts:138` `metadata ?? null` → `metadata && null`     | real gap    | no test supplies metadata; the mutant drops any provided object. Assert metadata round-trips.                   |
| 4 | `payment/period.ts:37` error message → `''`                         | accepted    | the message is not behaviour; we do not chase string mutants.                                                   |
| 5 | `payment/period.ts:36` `match === null \|\|` → `false \|\|`          | equivalent  | destructuring `null` on the next line throws anyway; the contract is "throws", which the tests assert.           |
| 6 | `payment/period.ts:43` `if (monthSpan !== 0)` → `if (true)`         | equivalent  | `addMonthsClamped(d, 0)` is a no-op; the guard is an optimisation.                                              |
| 7 | `payment/period.ts:47` `if (daySpan !== 0)` → `if (true)`           | equivalent  | `setUTCDate(day + 0)` is a no-op.                                                                                |
| 8 | `wayforpay/signature.ts:23` `update(base, 'utf8')` → `update(base, '')` | equivalent  | Node falls back to utf8 for an empty encoding; a non-ASCII fixture would still document the intent.             |

Three of eight survivors are real gaps under a 95% score and 100% line
coverage of these files — the lecture's point in one table.

## 6. Performance smoke (**new**)

`packages/backend/perf/smoke.ts` runs autocannon against `PERF_URL` and fails
when p99 exceeds `PERF_P99_BUDGET_MS` (default 500 ms, the docs/03 budget for
status APIs) or any non-2xx response occurs. It exists so that a budget is
checked from the first day; profiling, baselines and `EXPLAIN ANALYZE` belong
to the performance work, not to this smoke.

## 7. AI-assisted review (**new**)

`scripts/ai-review.sh` sends `git diff origin/main...HEAD` with the brief in
`scripts/ai-review-prompt.md` to a read-only reviewer (`claude -p` or
`codex exec`), writes `reports/ai-review/<sha>-<reviewer>.md` and exits 1 on
`VERDICT: REQUEST_CHANGES`, so it can sit in `pre-push` or CI. The reviewer
reads; a human decides. The brief fixes the order of concerns (invariants,
behaviour, test tiers, conventions, security, simpler approach) and the output
format, which is what makes two runs comparable.

## 8. Where each gate runs

| Moment       | Gates                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `pre-commit` | prettier + eslint on staged files, unit tests of shared + backend     |
| `commit-msg` | Conventional Commits                                                  |
| `pre-push`   | typecheck, dependency rules, all unit tests                           |
| CI (planned) | everything above + `test:e2e` + `test:ui` + `review:ai` — no pipeline exists in the repository yet |
| Nightly (planned) | `test:mutation`, `perf:smoke` against staging — no scheduler exists yet |
