# Payment app spec — checkout, operator console, and the Payment/Charge model

The user-facing app for the billing service and the domain naming it standardises on: a
single Cloudflare Pages app serving a public **checkout** and an authenticated
**operator console**, fronted by a Pages Functions BFF so **no request ever goes directly
from the browser to the backend**. It also fixes the top-level vocabulary end-to-end —
the thing we own is a recurring **Payment**, each provider charge is a **Charge** — and
the API/auth/date model that follows. Authoritative and prescriptive; cites the canonical
docs and amends the entity/API/vocabulary in docs/00, 05, 06, 12, 16, 18 and CLAUDE.md §6
(see §12).

## 1. What it is

A Vue 3 app in `packages/frontend` (replacing the current stub), deployed as **one**
Cloudflare Pages project at `checkout.nexttick.it`, with two route areas from one build:

1. **Public checkout** (`/c/:id`) — opened only via an unguessable direct link. Renders an
   existing checkout session (amount + currency + period), offers a single **Pay by card**
   action (WayForPay), and on return polls session status until the async provider webhook
   confirms. No subscriber data (docs/00 §5, docs/06).
2. **Operator console** (`/ops/*`) — authenticated internal tool: **Payments** (filter by
   `externalUserId` → detail with the Payment's Charges → cancel; and **create** a Payment
   with a manual `externalUserId`) and **Quarantine** (list unmatched → bind/reprocess).

Both surfaces wear one **terminal/CRT design language** ported from `NextTick.it`, are
localizable **ru/uk/en** with autodetection, and support **dark/light** with
`prefers-color-scheme` autodetection.

### Hard constraints
- **No client→server directly.** Every backend call is same-origin `/api/*` handled by the
  Pages Functions BFF, which proxies to Fastify. The browser holds no bearer token.
- **Auth everywhere.** Every entrypoint is behind auth; the *only* unauthenticated
  capabilities are the public checkout (get the payment link by checkout token + choose a
  processor) and operator login (§5).
- **Design language inherited from `NextTick.it`** — CSS design tokens + visual language
  only. NextTick.it is a static Eta site, so components are re-authored in Vue; its
  per-page i18n scheme is not reused (vue-i18n instead).
- **We own money, not access.** SendPulse/CRM own the subscription (access, `paid_till`).
  So the top-level noun here is **Payment**, never "subscription"; `paid_till` is not ours
  (§3).
- **Card only** for MVP (WayForPay); crypto/Whitepay deferred (CLAUDE.md §8).
- **Monorepo rules apply** — strict TS (`tsconfig.base.json`), ESLint budgets, API shapes
  imported from `@billing-service/shared`, never hand-duplicated (CLAUDE.md §3–4).

## 2. Domain naming (end-to-end)

The recurring, gateway-owned billing record is **Payment**; each observed provider charge
is a **Charge**. The current code uses older names — rename them across schemas, modules,
tables, routes, and docs:

| Target | Current code | Notes |
|--------|--------------|-------|
| entity `Payment` | `Subscription` | recurring record: token, schedule, retries, date model (§3) |
| `PaymentStatus` (`active`/`past_due`/`renewal_failed`/`cancelled`) | `SubscriptionStatus` | same variants |
| `schemas/payment.ts` | `schemas/subscription.ts` | **collision:** a `payment.ts` already exists for charge events → it becomes `charge.ts` |
| module `payment/`, table `payments` | module `subscription/`, table `subscriptions` | DB rename migration |
| entity `Charge`, module `charge/`, table `charges` | `IncomingPaymentEvent`, module `payments/`, table `incoming_payment_events` | the per-charge event pipeline + matching |
| `schemas/charge.ts` | `schemas/payment.ts` | frees `payment.ts` for the Payment entity |
| routes `/api/payment` + `/api/quarantine` | `/api/subscriptions*` + `/api/support/*` | `support` module removed (§4) |

Do the charge-side rename first (`payments → charge`, `incoming_payment_events → charges`,
`payment.ts → charge.ts`), **then** `subscription → payment` — otherwise the two collide
on the `payment` name mid-migration. Keep the queue's `attempts` table (a different
concept: durable work-queue attempts, not a Charge).

## 3. Payment, Charge & the date model

### Payment
`id`, `externalUserId`, `amount`, `currency`, `method`, `period`, `status`,
`recurringTokenRef`, plus the date model below. One active Payment per `externalUserId`
(extend in place).

### Charge
The observed per-charge event from a provider (or the poller): raw payload, normalized
amount/date, match result, quarantine link. A Payment's detail lists its Charges — every
attempt to charge that user's money.

### Date model (drift-free)
Two distinct concepts; the schedule must not drift when a charge is late:

- **Actual period** — `currentPeriodStart` … `currentPeriodEnd`: the window the user is
  genuinely covered for. `currentPeriodEnd` is the **anchor**.
- **Next payment date** — `nextPaymentDate`: the next *scheduled* charge. During the retry
  window this is a retry date (owned by the retry ladder, docs/17), **but the period
  anchor stays `currentPeriodEnd`.**

**Anti-drift rule.** On a successful charge — even a late one or one that succeeded on a
retry — advance the period **from the anchor, not from the pay moment**:
`currentPeriodStart ← currentPeriodEnd`, `currentPeriodEnd ← addPeriod(currentPeriodEnd,
period)`. A user due on day X but paying on X+7 is still covered only to the anchored end
and the next charge stays on cadence — no drift, no gifted weeks. `paid_till` is **not**
exposed (SendPulse owns access); operators see our period + schedule only.

> Verify against `subscription/period.ts` (`addPeriod`), `subscription/retry.ts`,
> `billing/scheduler.ts`. The normal-success path already advances from the scheduled date
> (anchored); the **retry-success path** must advance from the preserved anchor, not the
> retry date — confirm/implement and cover with a test.

## 4. API

All under the BFF; the browser never calls these directly (§7).

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/payment?externalUserId=…` | GET | operator | list/filter Payments by `externalUserId` |
| `/api/payment/:id` | GET | operator | Payment detail incl. its Charges + date model |
| `/api/payment` | POST | operator | create a Payment with a manual `externalUserId` (+ amount/period/method) for later quarantine match |
| `/api/payment/:id/cancel` | POST | operator | cancel with reason (audited) |
| `/api/quarantine` | GET | operator | list unmatched Charges |
| `/api/quarantine/:id/bind` | POST | operator | bind → reprocess |
| `/auth/sessions` | POST | public (login) | operator login → session → HttpOnly cookie (BFF) |
| checkout session read (JSON) + `…/pay` | GET/POST | public, by checkout token | the only unauthenticated app capability |
| `/health` | GET | none | readiness |

Route naming is singular `/api/payment` and `/api/quarantine`; cancel and create live under
`/api/payment`. There is no `/api/subscriptions*` or `/api/support/*`.

## 5. Auth model

- **Every entrypoint is behind auth.** The only unauthenticated actions:
  1. **Get the payment link** — hit the public checkout with a valid **checkout token** and
     pick a processor (→ signed provider form). No listing, no lookup, no enumeration
     beyond the single unguessable token.
  2. **Authorise** — operator login.
- Everything else (`/api/payment*`, `/api/quarantine*`, all `/ops/*`) requires the
  **operator role** (per-operator, audited; docs/12, docs/03). Filtering Payments by
  `externalUserId` is operator-only — there is no public/self lookup by user id.
- **Operator auth flow:** login+password → BFF → backend `/auth/sessions` → the BFF stores
  the session as a **Secure, HttpOnly, SameSite** cookie; every `/ops` `/api/*` call carries
  only the cookie, and the Function attaches the operator token. Enforced at the BFF (no
  cookie → 401 without calling the backend) **and** at the backend (`requireRole(actor,
  Operator)`).
- The public checkout carries no privileged token: checkout sessions are created by the
  external caller (e.g. SendPulse), not the frontend; the BFF only proxies the public
  session-read + pay endpoints.

## 6. Operator console

- **Payments** — filter by `externalUserId`; each row shows `externalUserId`, amount,
  currency, period, actual period (start–end), next payment date, status. Row → **detail**
  listing the Payment's **Charges** (date, amount, provider status, matched/quarantined),
  plus **cancel** (reason, audited).
- **Create Payment** — form: `externalUserId` (manual) + amount + currency + period +
  method → creates a Payment so a later unmatched Charge auto-binds to it.
- **Quarantine** — list unmatched Charges → bind/reprocess.

(Deliveries and an Ops dashboard/metrics view are deferred; §11.)

## 7. Architecture

```
checkout.nexttick.it  (one Cloudflare Pages project)
  /c/:id, /c/:id/return   public checkout SPA routes
  /ops/*                  operator console SPA routes (cookie-guarded)
  /api/*                  Pages Functions BFF (token/secret inject, proxy)
                              └─ HTTPS + shared secret ─> BACKEND_ORIGIN (Fastify)
```

- **BFF reach:** the Function targets env `BACKEND_ORIGIN` and sends a shared-secret header
  so the backend can reject non-BFF traffic; designed so a Cloudflare Tunnel can replace the
  public origin later with no code change.
- **Checkout return** points at the frontend `/c/:id/return` route; it shows "processing"
  and polls the session status via the BFF until `completed` (success), timeout ("we'll
  confirm shortly"), or declined (retry) — because confirmation is async via the provider
  webhook, not the browser redirect.

## 8. Structure & stack

**Stack:** Vue 3 (`<script setup>`) · TypeScript strict · Vite · Pinia · vue-router ·
vue-i18n.

```
packages/frontend/
  src/
    components/        # abstract, presentational, terminal-styled primitives:
                       #   Button, Input, Select, Panel, Table, Modal, Toast,
                       #   Spinner, ThemeToggle, LangSwitch — no business coupling
    modules/
      checkout/        # page, store, api, components/   (/c/:id, /c/:id/return)
      payments/        # ops: filter/detail/cancel/create (/ops/payments)
      quarantine/      # ops: list/bind                  (/ops/quarantine)
      session/         # operator login → HttpOnly cookie (/ops/login)
    styles/            # design tokens (light+dark) + terminal effects
    i18n/              # en/ru/uk catalogs, per-module namespaces
    router/            # routes aggregated from modules; /ops/* guard
    app/               # App.vue, main.ts, same-origin /api client
  functions/api/       # Cloudflare Pages Functions BFF
```

Each module owns `page`, `store` (Pinia), `api` (typed BFF client), and local
`components/`. `/components` is agnostic and reusable across modules.

### Localization & theme
- **i18n:** vue-i18n with `en`/`ru`/`uk`. Active language auto-detected from
  `navigator.language`; manual override persisted to `localStorage`. Missing keys must fail
  loudly in build/test (no silent English fallback).
- **Theme:** `data-theme` on `<html>`; **dark by default**; first load auto-detects from
  `prefers-color-scheme`; manual override persisted to `localStorage`.

## 9. Design tokens (ported from `NextTick.it/nexttick-index.css`)

Font: `--mono: "JetBrains Mono", ui-monospace, Menlo, monospace`. Applied via `:root`
(dark, default) and `[data-theme="light"]`.

| Token | Dark | Light |
|-------|------|-------|
| `--bg` | `#0b0d0f` | `#ffffff` |
| `--bg-2` | `#111417` | `#f6f8fa` |
| `--panel` | `#15191c` | `#f0f3f6` |
| `--panel-2` | `#1c2126` | `#e7ecf1` |
| `--line` | `#2a3138` | `#d4dae0` |
| `--line-2` | `#3a444c` | `#b6bfc8` |
| `--txt` | `#d6d8da` | `#1f2328` |
| `--dim` | `#888d92` | `#59636e` |
| `--muted` | `#5d6469` | `#8b949e` |
| `--green` (primary) | `#7ee787` | `#1a7f37` |
| `--green-2` | `#3fb950` | `#116329` |
| `--green-hover` | `#8df29a` | `#166b2e` |
| `--amber` | `#e3b341` | `#9a6700` |
| `--cyan` | `#56d4dd` | `#0b7285` |
| `--magenta` | `#bc8cff` | `#8250df` |
| `--red` | `#ff7b72` | `#cf222e` |

Plus effect vars `--scan` (CRT scanline), `--vignette`, `--tint`, window-dot colors. Port
the full source when building.

## 10. Acceptance criteria

### Naming, API & auth
- AC-1 No symbol, route, table, or doc refers to `Subscription`/`subscriptions` for the
  recurring entity; `Charge`/`charges` replaces `IncomingPaymentEvent`/
  `incoming_payment_events`; the `support` module and `/api/support/*` no longer exist.
- AC-2 `GET /api/payment?externalUserId=…` returns only that user's Payments, operator auth
  required; unauthenticated/non-operator → 401/403 (backend not leaked via the BFF).
- AC-3 `POST /api/payment` creates a Payment with a caller-supplied `externalUserId`; a
  later unmatched Charge for that `externalUserId` binds to it automatically.
- AC-4 Payment detail lists all Charges (attempts) for that Payment with provider status.
- AC-5 The only unauthenticated endpoints are the public checkout (session read + pay by
  checkout token) and operator login; every other route requires the operator role.
- AC-6 DB migration renames `subscriptions → payments` and `incoming_payment_events →
  charges` without data loss; subscription/replay state stays intact (CLAUDE.md §5).

### Date model
- AC-7 Payment exposes `currentPeriodStart`, `currentPeriodEnd`, `nextPaymentDate`; there is
  no `paid_till`.
- AC-8 A charge that fails on day X and succeeds on a retry (e.g. X+7) advances
  `currentPeriodEnd` to `anchor + period` (drift-free); a test asserts the next period is
  **not** `paidAt + period`.

### Client checkout
- AC-9 `/c/:id` (valid session) renders amount + currency + period in the active locale,
  terminal styling, single "Pay by card" — no `externalUserId`/subscriber data.
- AC-10 Expired/invalid/`completed` sessions show the correct terminal state, not a form.
- AC-11 "Pay by card" → `POST …/pay` via BFF → auto-submit the signed WayForPay form.
- AC-12 On `/c/:id/return`: "processing", poll session status via BFF until `completed`
  (success), timeout → "we'll confirm shortly", declined → retry path.
- AC-13 No checkout request hits the backend origin directly (verified in network trace).

### Operator console & foundation
- AC-14 `/ops/*` unreachable without a valid operator cookie → redirect to `/ops/login`;
  login sets a Secure HttpOnly cookie; browser storage holds no token.
- AC-15 Payments filter by `externalUserId`; cancel reflects `cancelled`; create posts a new
  Payment; quarantine bind removes the item on success.
- AC-16 `/components` holds abstract presentational primitives with no business coupling;
  light+dark tokens match §9; theme via `data-theme`.
- AC-17 First load autodetects theme (`prefers-color-scheme`, dark default) + language
  (`navigator.language`); overrides persist in `localStorage`; en/ru/uk catalogs complete
  (missing key caught); entity labelled "Payment" everywhere.
- AC-18 `npm run typecheck` and `npm run lint` pass for `packages/frontend` under strict
  config + ESLint budgets.

### Deployment
- AC-19 `npm run build` produces a Pages-deployable artifact (static assets + `functions/`);
  SPA deep links resolve (no 404 on refresh); BFF secrets read from Pages env, not committed;
  public app at `checkout.nexttick.it`, console under `/ops/*`.

## 11. Backend touch-points & sequencing

1. Charge-side rename: `payment.ts → charge.ts`, module `payments → charge`, table
   `incoming_payment_events → charges`.
2. `subscription → payment`: `subscription.ts → payment.ts`, module `subscription →
   payment`, table `subscriptions → payments`, `SubscriptionStatus → PaymentStatus`.
3. Remove `support` module; add `/api/payment` + `/api/quarantine` (move cancel/quarantine
   handlers); add `POST /api/payment` create.
4. Add the date model (`currentPeriodStart/End`, `nextPaymentDate`) + drift-free
   advancement; adjust `retry.ts`/`scheduler.ts` to keep the anchor.
5. Auth-gate every route; leave only checkout + login public.
6. **Public JSON read of a checkout session** (amount, currency, period, status) for SPA
   render + return polling (`GET /checkout/:id` currently returns an HTML stub); retire that
   server-rendered stub once the Vue page ships.
7. Shared-secret middleware to reject non-BFF traffic; point `W4P_RETURN_URL` at
   `checkout.nexttick.it/c/:id/return`.
8. Typed `.ts` migrations in `src/migrations/` (CLAUDE.md §2), applied at startup.

## 12. Doc & convention ripples (update in the same change)
- **CLAUDE.md** §6 (entity list; "one active subscription" → "one active Payment"), §8/§9
  (routes: no `/support`; `/api/payment` + `/api/quarantine`), §5 (table names).
- **docs/00, 05, 06, 12, 16, 18** — `Subscription → Payment`,
  `IncomingPaymentEvent → Charge`, `/api/support/* → /api/payment` + `/api/quarantine`; add
  the date model; note `paid_till` stays external.

## 13. Ontology
| Entity | Notes |
|--------|-------|
| CheckoutSession | id, externalUserId, amount, currency, period, method, status, expiresAt — created by the external caller |
| Payment | recurring record: id, externalUserId, amount, currency, method, period, status, recurringTokenRef, currentPeriodStart/End, nextPaymentDate |
| Charge | per-charge event (attempt): raw payload, amount, date, provider status, match/quarantine link |
| QuarantineRecord | unmatched Charge; bind → reprocess |
| OperatorSession | HttpOnly cookie ↔ backend session; audited per operator |
| WayForPayForm | `{action, fields}` produced by `…/pay`, auto-submitted |
| Locale / ThemeToken | en/ru/uk; light/dark CSS variables |
| EdgeProxy (BFF) | Pages Functions, `BACKEND_ORIGIN`, shared secret |

## 14. Open / verify
- Retry-window coverage semantics for the late cycle (user gets a shorter cycle to the
  anchor, §3) — verify against `retry.ts`/`scheduler.ts` and lock with a test.
- Whether `nextPaymentDate` is stored on Payment or derived from anchor + retry state
  (recommend derive; store only the anchor + retry fields).
- Whether "create Payment" requires amount/period up front or can be created with only
  `externalUserId` and filled on first matched Charge.
- Final public domain (`checkout` assumed vs `bill`/`billing`/`payment`.nexttick.it);
  Cloudflare account + domain registration; crypto/Whitepay processor on checkout.
