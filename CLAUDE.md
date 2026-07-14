# CLAUDE.md — working guardrails for this repo

Auto-loaded every session. It is the short list of things that are easy to get
wrong here and expensive to notice late. It does **not** restate the conventions —
those live in `docs/16-conventions.md` (comments answer WHY, domain takes commands
not transport types, auth is a domain concern, no test-only prod code, test
placement, `shared` sliced by entity, errors own `toHttp`, route DSL, derived
types). New modules mirror `auth`'s shape: `data-access` / `domain` / `routes` /
`contracts` / `test/`.

Deep specs when you touch these areas: queue `docs/09`, events `docs/07`,
WayForPay `docs/14`/`docs/15`, requirements `docs/02`, conformance map `docs/18`.

## Contracts, types, schemas — the rules I keep breaking (from review)

These are direct review feedback on this branch — the "same error, again" list.
Read them **before** adding a type, a schema, or a service. Each links to the
canonical convention in `docs/16`.

- **Public contracts live in `packages/shared/src/schemas/{entity}.ts`, never inside
  a module.** If a shape crosses a boundary — an API request/response, a domain
  event, a persisted entity — it is public: it goes in the shared entity slice and
  the backend imports it. Do not define it in `modules/{x}/contracts.ts` and leave
  it there. (docs/16 §6. Flagged on the checkout contracts and the route response
  schema.)
- **Never hand-write a type/interface that mirrors a shape that already has a
  schema. Derive it.** "An existing entity minus/plus a field" → `Schema.omit` /
  `Schema.pick` / `Schema.extend` at the schema level, or `Omit` / `Pick` at the
  type level, off the canonical schema. A standalone `interface NewX { … }` that
  restates fields is the defect that recurs. (docs/16 §9. Flagged: `NewCheckoutSession`
  redefined instead of derived from `CheckoutSession`.)
- **SQL column lists are derived from the schema's keys, not hand-typed strings.**
  `Object.keys(TheSchema.fields)` mapped to quoted names — one source of truth for
  "the columns of this table," so a schema change cannot silently drift from the
  SQL. (Flagged on the checkout `COLUMNS` constant.)
- **A domain event is a discriminated union on `name`, one typed payload schema per
  variant** — not `payload: Record<string, unknown>`. Each event's payload shape is
  part of the contract and must be enforced by the type system, so a builder cannot
  emit a malformed payload and a consumer can narrow on `name`. (docs/07. Flagged on
  the payments event builders.)
- **Domain steps are plain functions, not injected `Context.Tag` services.** A
  matcher / applier / any domain step is a function the domain calls: keep its
  _types_ in the module, compose the implementations as plain values, pass them in
  as parameters. Reach for a `Context.Tag` + `Layer` only for a real runtime
  resource (Sql, the queue) or a genuine swap boundary — pluggability alone (AC8) is
  satisfied by passing a function. (Flagged: the separate `PaymentMatcher` /
  `PaymentApplier` services.)
- **Server-rendered HTML is a temporary stub and belongs in the frontend.** Keep it
  minimal and mark it `TODO(frontend)`. (Flagged on the checkout `pageHtml`.)

## Guardrails — mistakes made here, do not repeat them

**Type traps (all ON in `tsconfig.base.json`):**

- `exactOptionalPropertyTypes` — **never hand-write a type/interface for a
  schema-backed shape.** Derive it: `type X = Schema.Schema.Type<typeof X>`. A
  hand-written `{ f?: T }` is not assignable from a decoded `{ f?: T | undefined }`,
  and the error is confusing. This one recurred several times.
- `noUncheckedIndexedAccess` — array/record indexing yields `T | undefined`. Use
  `?.`, a guard, or destructuring; never assume the element is present.
- `noPropertyAccessFromIndexSignature` — dynamic/index-signature keys need bracket
  access: `payload['reason']`, not `payload.reason`.
- `useUnknownInCatchVariables` — a caught value is `unknown`. Funnel it through a
  normalizer (`describeCause` / a `toErrorDetail`-style helper) before use; never
  read `.message` off it directly.
- `verbatimModuleSyntax` — type-only imports must be `import type { … }`.

**Lint gates (`eslint.config.js`, build FAILS on them — write inside them from the
start, don't refactor after):** `complexity ≤ 10`, `max-depth ≤ 3`,
`max-lines-per-function ≤ 60`, `max-statements ≤ 15`, `max-params ≤ 4`,
`max-nested-callbacks ≤ 3`, plus `strictTypeChecked` + `stylisticTypeChecked`.
The fixes that keep recurring:

- Over budget on complexity/statements → extract a named helper (this is how the
  `loadQueueConfig` / `loadW4pPollerConfig` / … config loaders exist).
- More than 4 params → pass **one options object** (that is why `RetryFailure` is a
  record, not a param list).
- `no-confusing-void-expression` → give an `expect(...)` arrow body braces.
- `no-base-to-string` → stringify unknowns through a `describeCause` helper, never
  interpolate an object directly.
- `no-unnecessary-type-assertion` fighting `TS7053` on enum indexing → type the
  value (e.g. `currency: Currency`) instead of asserting at the index site.
- Deep nesting → hoist the inner callback to a named function.

Run `npm run lint` **and** `npm run typecheck` before saying done. Both are hard.

**`@effect/sql-pg` query traps:**

- `sql.in([...])` renders `($1, $2, …)` **without** the `IN` keyword. You must
  write it: `` `"col" IN ${sql.in(list)}` ``. Omitting it makes Postgres parse
  `"col"(…)` as a function call → `42883 function ... does not exist`. This was a
  real bug that only the e2e (asserting a real value) caught — a mock would have
  hidden it.
- Columns are camelCase, so they must be **double-quoted** in SQL (`"messageType"`)
  or Postgres folds them to lowercase.

**Tests:**

- Add a method to a repo interface → update **every** fake in the same edit with a
  `die`-stub, or the test files stop compiling. Easy to miss across several fakes.
- Use **real calendar dates**. `2026-02-29` does not exist (2026 isn't a leap year);
  leap day is `2024-02-29`. A bad literal silently builds an `Invalid Date`.
- `*.test.ts` = hermetic, no Postgres, run by `npm test`. `*.e2e.ts` = real-Postgres
  scenarios, run only by the e2e runner. Keep e2e assertions **concrete** (assert
  the value, not just "no throw") — that is what earns their cost.

## Load-bearing invariants — breaking one reintroduces a real bug

- **Three-layer idempotency.** One, ingest dedup via `UNIQUE(messageType, idemKey)`
  and `INSERT … ON CONFLICT DO NOTHING`. Two, claim exclusivity via
  `FOR UPDATE SKIP LOCKED` and a same-statement flip to `in_progress`. Three,
  handler idempotency via deterministic ids, so an at-least-once redelivery (the
  reaper requeues dead in-progress rows) is safe. Remove any layer and you get
  double-processing / double-charge.
- **Mutable working row, append-only logs.** `messages` carries the current
  `status` cache; `raw_events` / `attempts` / `message_status_events` are
  append-only. Read the cache for current state — never scan a log. Every status
  mutation appends its log row **in the same statement** (`infra/queue/store.ts`
  claim / complete / reapStale).
- **Deterministic keys across sources.** `orderReference = sub_<subscriptionId>_<…>`;
  charge idemKey `w4p:<orderReference>|CHARGE|<createdDate>`; callback idemKey
  `w4pcb:<orderReference>|<status>`. Scheduler and poller derive the **same** key so
  the poller re-seeing our own charge dedupes (FR-006). Don't randomize them.
- **We own the billing cycle.** The Purchase is built **without** `regularMode` —
  renewals are driven by our scheduler, not WFP's recurring engine (`docs/14`).
- **`exit`, not `either`, in the dispatcher** — capture typed failures AND defects,
  so a throwing handler is recorded as a failed attempt, never a process crash.
- **A Declined charge is a valid response, not a failure** — the scheduler branches
  on it (`wayforpay/client.ts`); don't treat it as an Effect error.
- **WFP payload quirks.** Money/date fields arrive as string OR number — coerce
  (`toMinorUnits`, `toDate`, numeric `reasonCode`). Unknown currency defaults to UAH
  but the raw payload keeps the truth. HMAC-MD5 field order is fixed and sourced
  (wiki refs in the client) — never reorder it.

## Process

- **Comments answer WHY.** WHAT is carried by the name, the structure, and the file
  location; HOW is carried by the function body. A comment exists only for a WHY that
  none of those can express — and, in rare extreme cases, a HOW note when the body is
  unavoidably subtle. If a comment restates the name, the structure, or the body,
  delete it. (docs/16 §1.)
- **Never amend or rewrite git history.** Only add a new commit, or `git revert` one.
  No `git commit --amend`, no history-rewriting rebase/reset — not even to fix a
  mistake in my own previous commit; make a follow-up commit instead. If an amend is
  actually wanted, the user does it. (I broke this here: an `--amend` for a doc file
  silently swallowed an unrelated staged deletion and left HEAD broken.)
- Commit every document, finding, and code change incrementally (session standing
  directive).
