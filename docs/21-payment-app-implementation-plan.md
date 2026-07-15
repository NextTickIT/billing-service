# Payment App — Deliberate Consensus Implementation Plan (RALPLAN-DR)

**Mode:** DELIBERATE (high-risk: cross-cutting rename + DB migration + auth surface + new frontend).
**Source of truth:** `docs/19-payment-app-spec.md` (read in full). Honors `CLAUDE.md` §2–§13 and `docs/16` conventions.
**Status:** `pending approval` — consensus-reviewed (verdict SOUND-WITH-CHANGES; the 10 required changes are folded in below and summarized in §13). Not yet approved for execution.

---

## 1. Requirements summary (cited to docs/19)

The spec asks for six interlocking deliverables:

1. **Domain rename, end-to-end** (docs/19 §2, §11.1–2, AC-1, AC-6). The recurring gateway-owned record becomes **Payment** (currently `Subscription`); each observed provider charge becomes **Charge** (currently `IncomingPaymentEvent`). Because a `schemas/payment.ts` already exists for the charge-event status (`packages/shared/src/schemas/payment.ts:7-17`), it must first move to `charge.ts` before `subscription.ts` can take the `payment.ts` name — the **charge-side rename runs first** (docs/19 §2 last paragraph, §11).
2. **API reshape** (docs/19 §4, AC-2/3/4). Replace `/api/subscriptions*` + `/api/support/*` with singular `/api/payment` (list/detail/create/cancel) and `/api/quarantine` (list/bind). The `support` module is deleted (docs/19 §2 table row, §11.3, AC-1).
3. **Auth-everywhere** (docs/19 §5, AC-2/5/14). Only public capabilities: public checkout (session read + pay by checkout token) and operator login. Everything else requires the **operator role**, enforced at BOTH the BFF (cookie→token or 401 without calling backend) AND the backend (`requireRole(actor, Operator)`).
4. **Drift-free date model** (docs/19 §3, §11.4, AC-7/8). Add `currentPeriodStart`/`currentPeriodEnd`/`nextPaymentDate`; on a successful charge advance the period **from the anchor (`currentPeriodEnd`)**, never from the pay moment — *including a success mid retry-ladder*. No `paid_till` (SendPulse owns access).
5. **Vue 3 frontend + Pages Functions BFF** (docs/19 §1, §7, §8, §9, AC-9..19). One Cloudflare Pages project: public checkout SPA (`/checkout/:id`, `/checkout/:id/return`), operator console (`/operator/*`), same-origin `/api/*` BFF proxying to `BACKEND_ORIGIN` with a shared secret. Terminal/CRT design tokens ported from NextTick.it; ru/uk/en i18n with autodetect; dark/light with `prefers-color-scheme`.
6. **Doc & convention ripples in the same change** (docs/19 §12): `CLAUDE.md` §5/§6/§8/§9 and `docs/00, 05, 06, 12, 16, 18`.

Acceptance criteria AC-1..AC-19 are enumerated in docs/19 §10 and mapped in §8 below.

---

## 2. Principles (invariants every phase must hold)

- **P1 — No data loss, replay preserved.** DB renames must keep every raw/append-only row and the current-status cache intact (CLAUDE.md §5, AC-6). Table renames via `ALTER TABLE … RENAME`, never drop+recreate.
- **P2 — Green between phases.** Each phase compiles (`npm run typecheck`), lints (`npm run lint`), and passes `npm test` before the next begins (CLAUDE.md §4, §12). No half-renamed tree.
- **P3 — Schemas are the single source of truth.** Public shapes live in `packages/shared/src/schemas/{entity}.ts`; types are derived (`Schema.Schema.Type`), never hand-mirrored (CLAUDE.md §3 conv.6/9; docs/16).
- **P4 — Don't weaken an invariant or AC to compile.** Especially the three-layer idempotency and deterministic idem keys (CLAUDE.md §5, §12; AC2). Fix the change, not the invariant.
- **P5 — Provider code stays in the provider module.** `checkout`/pipeline stay processor-agnostic; WayForPay specifics stay in `wayforpay/` (CLAUDE.md §3 conv.12).

---

## 3. Decision Drivers (top 3)

1. **DriverA — Blast radius is huge but mechanical.** ~38 files reference `Subscription`/`subscription`; 16 reference `IncomingPaymentEvent`/`incoming_payment_events` (verified via grep over `packages/backend/src` + `packages/shared/src`). The naming collision on `payment` forces strict ordering. Sequencing correctness dominates.
2. **DriverB — The external sink contract must not silently break.** The event vocabulary `subscription_created` / `subscription_cancelled` is the **external** wire contract carried to sinks (`packages/shared/src/schemas/event.ts:16-24`, EVENT_NAMES; docs/07). Renaming the *entity* does not automatically mean renaming these wire strings — that is a separate, breaking decision.
3. **DriverC — The drift bug is real and currently latent.** The retry-success path overwrites the schedule anchor: `recordRetry` sets `"nextChargeDate" = state.nextChargeDate` (retry date) at `subscription/data-access.ts:129-138`, and on later success `advanceAfterSuccess(sub.id, addPeriod(sub.nextChargeDate, sub.period))` at `billing/scheduler.ts:87-90` advances from the *retry* date, not the original due date → gifted weeks. A dedicated anchor column is required to fix it correctly.

---

## 4. Viable Options (with bounded pros/cons)

### Decision 1 — Rename strategy: big-bang vs staged-with-compat-shims

**Option 1A — Big-bang rename per side, one commit each (RECOMMENDED).**
Do the charge-side rename atomically (schema + module + table migration + all references + tests) so the tree is green, then the payment-side rename atomically. No temporary re-export shims.
- **Pros:** Matches P2 (green between phases) at the *side* granularity; no lingering dual-naming debt; the collision is resolved by ordering, not by shims; simplest final state (AC-1 "no symbol refers to Subscription").
- **Cons:** Each side is a large single change (~16–38 files touched); a mid-change compile break blocks the whole side until resolved; requires disciplined find-replace + typecheck loops.

**Option 1B — Staged with compat re-export shims.**
Introduce new names alongside old (e.g. `export { Subscription as Payment }`), migrate references incrementally, delete shims last.
- **Pros:** Smaller intermediate diffs; each reference migrates independently.
- **Cons:** Violates AC-1 until the final cleanup (both names coexist); risks a forgotten shim shipping (AC-1 fail); adds files that "exist only for the transition" — against the spirit of CLAUDE.md §3 conv.4; two sources of truth transiently (against P3). More total churn.

**Chosen: 1A.** The collision is solved by *ordering* (charge-side first), which 1A already requires; shims add risk against AC-1 without buying safety the typecheck loop doesn't already give. Alternatives invalidation: 1B is only justified if teams work the rename in parallel across long-lived branches — not the case here (single worktree, single change).

### Decision 2 — `nextPaymentDate`: stored column vs derived from anchor + retry state

**Option 2A — Store `currentPeriodStart`, `currentPeriodEnd` (anchor), `nextPaymentDate` all as columns (RECOMMENDED for MVP).**
Add three `timestamptz` columns; `nextPaymentDate` is written explicitly on each transition (normal advance, retry step, renewal).
- **Pros:** `findDue` stays a single indexed predicate on one column (mirrors today's `subscriptions_due_idx` on `"nextChargeDate"`, `0006_subscriptions.ts:36-39`); operator console reads it directly (docs/19 §6 row shows "next payment date"); minimal change to the scheduler's claim query; explicit and auditable.
- **Cons:** Three date columns to keep consistent; `nextPaymentDate` is derivable, so storing it is mild denormalization; a bug could let `nextPaymentDate` and the anchor disagree.

**Option 2B — Store only the anchor (`currentPeriodEnd`) + retry fields; derive `nextPaymentDate`.**
Keep `firstFailureAt`/`retryAttempt`; compute `nextPaymentDate = firstFailureAt + RETRY_SCHEDULE_DAYS[attempt]` in the retry window, else `= currentPeriodEnd`.
- **Pros:** One fewer stored date; impossible for `nextPaymentDate` to drift from its inputs (docs/19 §14 "recommend derive").
- **Cons:** `findDue` can no longer be one indexed `WHERE nextChargeDate <= now` — it must branch on status/retry, complicating the hot path and the partial index; every reader (console, API) must run the derivation; more surface for the derivation to be wrong in one place.

**Chosen: 2A** for MVP, with the anchor (`currentPeriodEnd`) as the *sole* source for period advancement (the anti-drift rule), and `nextPaymentDate` written from the retry ladder. This keeps the indexed claim query (`findDue`) and the console read trivial while still fixing drift, because advancement reads the anchor, not `nextPaymentDate`. Alternatives invalidation: 2B's derive-purity is attractive but regresses the 100k-due-same-day performance requirement (docs/03; the scheduler must "drain all due within 24h") by defeating the partial index. Revisit 2B if the console needs richer schedule projection.

> Note: `nextPaymentDate` **replaces** today's `nextChargeDate` semantically (the scheduled charge). We keep the claim column but rename it to `nextPaymentDate` to match the spec vocabulary (AC-7), and ADD the two period columns.

---

## 5. Pre-mortem — 3 concrete failure scenarios + mitigations

**Scenario 1 — The migration renames tables but the running server still SELECTs the old name → startup crash / data-access errors.**
Cause: `subscription/data-access.ts` hardcodes `FROM subscriptions` (lines 77, 83, 88, 98, 111, 123, 132, 142, 149, 156) and `payments/data-access.ts` hardcodes `incoming_payment_events`. If the migration lands but the repo strings aren't all updated in the *same* phase, e2e (real Postgres, docs/11) breaks.
*Mitigation:* Table rename migration and every `FROM`/`INSERT INTO`/`UPDATE` string change ship in the **same phase**; add an e2e that boots the app against a freshly-migrated DB and round-trips a Payment (AC-6). `columnList(Subscription.fields)` (`data-access.ts:72`) auto-tracks renamed columns, but table names are literals — grep `FROM subscriptions|INTO subscriptions|UPDATE subscriptions` must return zero after Phase 2.

**Scenario 2 — Deterministic idem keys / orderReference change → existing rows stop deduping → double payment or double event (AC2 breach).**
Cause: idem keys embed `orderReference`: charge `w4p:${orderReference}|CHARGE|${createdDate}` (`billing/events.ts:30`), callback `w4pcb:${orderReference}|${transactionStatus}` (`wayforpay/callback.ts:66`), and the recurring `orderReference = sub_${sub.id}_${nextChargeDate.getTime()}` (`billing/scheduler.ts:41-42`). If we rebrand `sub_`→`pay_` while live rows exist, re-observation won't dedupe.
*Mitigation:* **Keep the `sub_` orderReference literal and all idem-key formats byte-identical** for now — they are opaque transport keys, not user-facing, and the scheduler path is gated OFF (`SCHEDULER_ENABLED`, `config.ts:106`; CLAUDE.md §8/§13 "live-only"), so no production charge rows exist yet. Document this explicitly as a deliberate carve-out (rename the *entity/table*, not the wire keys). Only the checkout `orderReference` is live and it is `session.id` = `chk_...` (`wayforpay/purchase.ts:31,44`), untouched by the entity rename. Regression: the existing pipeline e2e (`payments/test/pipeline.e2e.ts`, uses `w4p:o1|PURCHASE|...`) must still pass unchanged.

**Scenario 3 — Auth tightening locks out the pipeline or the public checkout (self-DoS) / or leaks the backend.**
Cause: today `support`/`subscription` routes accept *any* valid token (`support/routes.ts:37-44` "Any valid auth-token authorizes"; `subscription/routes.ts:26-32`). The provider callback `POST /api/providers/:provider/callback` is auth'd by signature only (`checkout/routes.ts:127-143`), and `POST /api/checkout-sessions` needs the SERVICE token (`checkout/routes.ts:44-49`). If we blanket-require `Operator`, we could break the callback (must stay signature-only) or the service session-create (must stay Service token), or forget the BFF gate and leak the backend.
*Mitigation:* Enforce `requireRole(actor, Role.Operator)` (exists at `auth/domain.ts:53-58`; `Role.Operator = 1` at `shared/.../auth.ts:5`) ONLY on the operator surface (`/api/payment*`, `/api/quarantine*`). Leave the provider callback signature-verified, keep `POST /api/checkout-sessions` on the Service token (external caller), and make the public checkout session-read + `…/pay` explicitly public. Add the shared-secret middleware as an *additional* gate for BFF traffic, not a replacement for role checks. Test both a 401 (no cookie at BFF) and a 403 (valid non-operator token at backend).

---

## 6. Implementation steps (phased; each step cites files, sized for ESLint budgets)

Ordering guarantees a compiling/green tree between phases (P2). Commit atomically per phase (CLAUDE.md §12).

### Phase 0 — Safety net (no behavior change)
- **0.1** Add a focused unit test that pins the CURRENT (buggy) retry-success advancement so the drift fix in Phase 4 is provably a change: assert that with today's code a success after a retry advances from the retry date. Location: `packages/backend/src/modules/billing/test/scheduler.test.ts` (exists). This is the "before" half of the AC-8 regression.
- **0.2** Snapshot the green baseline: run `npm run typecheck && npm run lint && npm test` and record it in the plan's verification log.
- **Acceptance:** baseline green; the pinning test documents current drift.

### Phase 1 — Charge-side rename (`payment.ts`→`charge.ts`, `payments/`→`charge/`, `incoming_payment_events`→`charges`)
Order first to free the `payment` name (docs/19 §2, §11.1).
- **1.1 shared:** rename `packages/shared/src/schemas/payment.ts` → `charge.ts`; update the barrel `packages/shared/src/schemas/index.ts:5` (`payment.js`→`charge.js`). The exported symbols (`PaymentEventStatus`, `PAYMENT_EVENT_STATUSES`) are charge-event statuses — keep symbol names or rename to `ChargeStatus`/`CHARGE_STATUSES` per docs/19 §2 (recommend rename for AC-1 clarity; update importers in `payments/contracts.ts:2-8`).
- **1.2 module:** rename dir `packages/backend/src/modules/payments/` → `charge/`; rename the pipeline shape `IncomingPaymentEvent` → `Charge` in `contracts.ts:48-62` and every importer (16 files, grep list): `billing/scheduler.ts`, `billing/events.ts`, `wayforpay/mapping.ts`, `wayforpay/callback.ts`, `wayforpay/poller.ts`, `checkout/domain.ts`, tests. Keep `makePaymentsRepo`→`makeChargeRepo`, `RebindPayload`, matcher/applier types.
- **1.3 migration:** add `packages/backend/src/migrations/0008_rename_charges.ts` (typed `.ts`, default-exports an Effect like `0004`/`0006`) that `ALTER TABLE incoming_payment_events RENAME TO charges` and renames its constraint/index names. **No data loss** (P1, AC-6). Note: `payments` (the fixation table, `0004_payments.ts:33-46`) and `quarantine_records.boundSubscriptionId`/`payments.subscriptionId` FKs are handled in Phase 2 (they reference the *subscription* entity).
- **1.4 tests:** update `charge/test/*`, `wayforpay/test/poller.test.ts`, `checkout/test/matcher.test.ts|applier.test.ts` to the new symbol; keep idem-key literals unchanged (Scenario 2).
- **Acceptance:** grep `IncomingPaymentEvent` = 0; `npm run typecheck && lint && test` green; e2e round-trips a charge into `charges`.

### Phase 2 — Payment-side rename (`subscription.ts`→`payment.ts`, `subscription/`→`payment/`, `subscriptions`→`payments`, `SubscriptionStatus`→`PaymentStatus`)
- **2.1 shared:** rename `packages/shared/src/schemas/subscription.ts` → `payment.ts`; barrel `index.ts:1`. Rename `Subscription`→`Payment`, `CreateSubscription`→`CreatePayment`, `SubscriptionStatus`→`PaymentStatus` (keep numeric values 0/1/2/3, `subscription.ts:48-53`). **Value types owned by payment (OQ-1 RESOLVED):** `Currency`, `CurrencyCode`, `currencyFromCode`, `PaymentMethod`, `PaymentMethodSchema`, `RETRY_SCHEDULE_DAYS` stay in `payment.ts` and are **owned by the payment slice**; `checkout.ts:3` and `event.ts:3` import them from `payment` — cross-slice imports of payment-owned types are allowed. **Do NOT split** into `currency.ts`/`method.ts`. (These import repoints from the renamed slice are hard compile-deps and must land atomically with the file rename — F-E.)
- **2.2 module:** rename dir `subscription/`→`payment/`; `data-access.ts` `SubscriptionRepo`→`PaymentRepo`, `makeSubscriptionRepo`→`makePaymentRepo`, all SQL `subscriptions`→`payments` (lines 77,83,88,98,111,123,132,142,149,156). **Collision guard:** the old `payments` fixation table (`0004_payments.ts`) must be renamed FIRST in the migration (see 2.4) to avoid two `payments` tables.
- **2.3 events/scheduler:** `billing/scheduler.ts`, `billing/events.ts`, `subscription/{domain,matcher,retry,period,cancel}.ts` → `payment/…`; update imports. **Event-name rename (OQ-2 RESOLVED — our events are ours to rename):** rename the OUTGOING `DomainEvent` names `subscription_created → payment_created` and `subscription_cancelled → payment_cancelled` (`event.ts` `EVENT_NAMES` + the union variants + emit sites `billing/events.ts`). The sink is a stub (`sendpulse`), so this pre-integration rename is safe. Internal message-type constants (`SUBSCRIPTION_CANCEL → PAYMENT_CANCEL`) follow the entity rename (internal queue types, not a wire contract). **Do NOT rename anything WayForPay SENDS us** — provider callback field names and transaction statuses stay verbatim (`wayforpay/*`), and idem-key literals stay byte-identical (Scenario 2). Internal helper prefixes like `evt_sub_` (`events.ts:52,70`) are opaque ids; keep for idem stability. **`sub_` coupling (F-F fix):** the recurring `orderReference = sub_${id}_…` is minted at `scheduler.ts:41` AND parsed by the matcher regex `OUR_REF = /^sub_([0-9a-fA-F-]+)_/` at `subscription/matcher.ts:7,22`. Extract the `sub_` prefix into ONE shared constant used by both the mint and the match site so a future rename can't silently break self-charge matching (every self-charge would quarantine, AC-6 counter climbs). Keep the literal value `sub_` unchanged.
- **2.4 migration:** `0009_rename_payments.ts`: first `ALTER TABLE payments RENAME TO charge_fixations` (the fixation table from `0004`), then `ALTER TABLE subscriptions RENAME TO payments`; rename `subscriptions_one_active_per_user`/`subscriptions_due_idx` indexes (`0006:32-39`); rename `charge_fixations."subscriptionId"`→`"paymentId"` and `quarantine_records."boundSubscriptionId"`→`"boundPaymentId"` and the checkout `subscriptionId` refs. Preserve all data (P1, AC-6). *(Naming note: if `charge_fixations` is undesired, choose `charge_fixations`; align with the Charge model. Resolve in review — OQ-3.)*
- **2.5 second grep gate (F-G fix — the silent-corruption path).** The **charge** module already SELECTs/INSERTs the OLD `payments` *fixation* table (`payments/data-access.ts:116-120` `INSERT INTO payments (...)`, `pipeline.e2e.ts:202` `FROM payments`). After 2.4 renames that fixation table to `charge_fixations` AND renames `subscriptions`→`payments`, every `FROM payments`/`INTO payments` literal in the charge module must be repointed to `charge_fixations` — otherwise it **silently reads the new recurring-Payment table** (no compile error, data corruption). Gate: after Phase 2, `FROM payments`/`INTO payments` in `charge/data-access.ts` (and its e2e) = 0; they must all read `charge_fixations`.
- **Acceptance:** grep `Subscription|subscriptions` in `src` = 0 (AC-1); the 2.5 charge-module `payments`→`charge_fixations` gate passes; typecheck/lint/test green; e2e checkout→payment row in `payments` table AND a charge fixation row in `charge_fixations`.

### Phase 3 — API reshape + delete `support`
- **3.1** Delete `packages/backend/src/modules/support/routes.ts`; fold its handlers into the new surface.
- **3.2** In `payment/routes.ts` (renamed): change route paths `/api/subscriptions/:id`→`/api/payment/:id`, `/api/subscriptions`→`/api/payment` (list by `?externalUserId=`, `subscription/routes.ts:98-112`), remove the duplicate `/api/support/subscriptions*` routes (`routes.ts:114-129`), and move cancel to `POST /api/payment/:id/cancel` (docs/19 §4). Add `POST /api/payment` create-with-manual-`externalUserId` (docs/19 §4, AC-3) — builds a Payment via the existing insert path so a later unmatched Charge auto-binds (the matcher already keys on `externalUserId`).
- **3.3** New `quarantine/routes.ts`: `GET /api/quarantine` (from `support:listOpenQuarantine`, `support/routes.ts:131-140`) and `POST /api/quarantine/:id/bind` (from `support` bind, `routes.ts:88-126`, keeps `insertAudit` + `enqueue(PAYMENT_REBIND)`). Preserve audit logging (docs/19 §4 "audited"; `support/routes.ts:106-112`). Deliveries route (`support/routes.ts:142-153`) — **DELETE it (OQ-4 RESOLVED: no unneeded routes, no dead code)**. It is not part of the MVP console (Payments + Quarantine only), so it is removed rather than ported/parked. The outbox **delivery machinery** (`outbox/`, the queue-driven sink delivery) stays — only the operator *read route* goes; a deliveries screen + its route are re-added when that screen is scoped. (This overrides review finding F-I, which recommended parking; the user's directive is no dead/unneeded routes.)
- **3.4** Payment **detail** must list the Payment's Charges (AC-4): add a repo read joining `charges` (and/or `charge_fixations`) by `externalUserId`/`paymentId`; return the date model + Charges array (docs/19 §6).
- **Acceptance:** AC-1 (no `/api/support/*`, no `/api/subscriptions*`), AC-3, AC-4; e2e create→match→detail lists the Charge.

### Phase 4 — Drift-free date model
- **4.1 schema:** in `payment.ts` add `currentPeriodStart: Schema.Date`, `currentPeriodEnd: Schema.Date`, and rename `nextChargeDate`→`nextPaymentDate` (AC-7). Remove nothing that breaks replay; keep `firstFailureAt`/`retryAttempt`.
- **4.2 migration:** `0010_payment_period.ts`: add `"currentPeriodStart"`, `"currentPeriodEnd"` timestamptz; rename `"nextChargeDate"`→`"nextPaymentDate"`; update the due index to `"nextPaymentDate"`.
  **Status-branched backfill (F-A fix — an unconditional `currentPeriodEnd = nextPaymentDate` bakes in drift):**
  - `status = active (0)`: `currentPeriodEnd = nextPaymentDate` (active rows are anchored on the due date); `currentPeriodStart = nextPaymentDate − period`.
  - `status = past_due (1)`: `nextPaymentDate` is a **retry date**, NOT the anchor. Anchor on the original due date = day 0 of the ladder = `firstFailureAt` (`retry.ts:5-6` "Day 0 is the original due charge failing"): `currentPeriodEnd = firstFailureAt`, `currentPeriodStart = firstFailureAt − period`.
  - `renewal_failed (2)` / `cancelled (3)`: `currentPeriodEnd = coalesce(firstFailureAt, nextPaymentDate)`; terminal, not advanced.
  - E2E must seed a `past_due` row and assert the migrated anchor ≠ the retry date. (Scheduler ships gated off, so no live recurring rows yet — but the migration must be correct for real data.)
- **4.3 domain:** the anti-drift fix. In `billing/scheduler.ts:86-90`, on `Approved`, advance from the **anchor**: `currentPeriodStart ← currentPeriodEnd`, `currentPeriodEnd ← addPeriod(currentPeriodEnd, period)`, `nextPaymentDate ← currentPeriodEnd` — NOT `addPeriod(nextChargeDate, …)`. Crucially, in `onFailure`/`recordRetry` (`scheduler.ts:44-70`, `data-access.ts:129-138`) the retry updates `nextPaymentDate` (the retry date) but **must NOT touch `currentPeriodEnd`** (the anchor stays). Update `advanceAfterSuccess` (`data-access.ts:120-127`) to take the new anchor pair. `addPeriod` itself (`payment/period.ts:19-36`) is already drift-free arithmetic — unchanged.
- **4.4 test (AC-8):** in `billing/test/scheduler.test.ts`, assert: a charge failing on day X (anchor = due date D) then succeeding on retry at X+7 yields `currentPeriodEnd = addPeriod(D, period)` and NOT `addPeriod(X+7, period)`; and `nextPaymentDate = currentPeriodEnd`. This flips the Phase-0.1 pin.
- **4.5 create/extend path (F-D fix — the initial path also populates the dates):** thread the anchor through `createOrExtend` (`subscription/domain.ts:36,46,58`), the `insert`/`extend` SQL (`data-access.ts:96-118`), and the `CreateSubscription`/`ExtendSubscription` shapes (`data-access.ts:14-21`, `subscription.ts:83-85`). For a fresh checkout: `currentPeriodStart = paidAt`, `currentPeriodEnd = addPeriod(paidAt, period) = nextPaymentDate`. Without this, the new columns are NULL on freshly-created Payments and the scheduler fix silently no-ops on a NULL anchor. This same insert path backs the `POST /api/payment` create (Phase 3.2), so it must set the anchors too. Add a test: a fresh checkout sets `currentPeriodEnd = nextPaymentDate = paidAt + period`.
- **Acceptance:** AC-7, AC-8; a fresh Payment has non-null anchors; typecheck/lint/test green.

### Phase 5 — Auth-everywhere (backend) + public checkout JSON + shared-secret
- **5.1 operator credential path (F-J fix — session vs auth-token mismatch).** The console login mints a **`bss_` session token** (`auth/domain.ts:144`, via `/auth/sessions`), but the current operator routes authenticate **`bst_` auth-tokens** through `authenticateToken` (`auth/domain.ts:80`) — a `bss_` cookie would fail. Wire ONE explicit path: add a session→actor resolver the operator routes use (validate the `bss_` token via `authenticate` at `auth/domain.ts:184`, map `session.role`→`Actor`), then `requireRole`. Do NOT leave the operator routes on `authenticateToken`.
- **5.1b role gate (F-B fix — `requireRole` is strict `===`).** `requireRole` (`auth/domain.ts:53-58`) is `actor.role === required`, and `Role.Admin=0`/`Operator=1`/`Service=2` (`shared/schemas/auth.ts:3-7`), so an **Admin** bootstrap token gets **403** on the operator surface. Decide explicitly (and document): operators use an **Operator-role session** (the console login must yield `role=1`; verify seeded operators have role=1 at `auth/domain.ts:176`), and admins provision but do not operate. If admin-also-operates is wanted, add an explicit `isAtLeast` helper — do NOT rely on a naive `>=` (the ordering is "0 = most privileged", so `>=` would be backwards). Apply the gate to every operator handler in `payment/routes.ts` and `quarantine/routes.ts` (replacing the "any valid token" `authed`/`supportActor`, `subscription/routes.ts:26-32`, `support/routes.ts:37-44`). Keep `POST /api/checkout-sessions` on the Service token; keep the provider callback signature-only (`checkout/routes.ts:127-143`).
- **5.2 public checkout JSON read** (docs/19 §11.6, AC-9/10/12): the frontend SPA now owns the `/checkout/:id` route on `bill.nexttick.it`, so the backend must **stop serving HTML there**. Retire the HTML stub `fastify.get('/checkout/:id')` (`checkout/routes.ts:155-167`, returns `pageHtml`) and expose a **public JSON** read at **`GET /api/checkout-sessions/:id`** returning `{ amount, currency, period, status, expiresAt }` (no `externalUserId` — AC-9), plus the public `POST /api/checkout-sessions/:id/pay` returning the signed form. Both stay unauthenticated (unguessable `chk_` id) but are BFF-proxied (F-C allowlist). Update `checkoutPath` (`checkout/domain.ts:14`) and `W4P_RETURN_URL` to the SPA origin `bill.nexttick.it/checkout/:id` (+ `/return`).
- **5.3 shared-secret middleware — explicit allowlist, NOT a blanket `/api/*` (F-C fix).** A blanket `/api/*` pre-handler self-DoSes real traffic: the provider callback `POST /api/providers/:provider/callback` (`checkout/routes.ts:177-183`) is **under `/api/`** and WayForPay won't send the secret; and `POST /api/checkout-sessions` (create) is called by **SendPulse directly, not via the BFF** (docs/19 §5). Gate the secret ONLY on the BFF-proxied routes: **gate** `{/api/payment*, /api/quarantine*, the public checkout session-read + `…/pay` (which go through the BFF)}`; **exclude** `{/api/providers/*/callback (signature-verified), POST /api/checkout-sessions create (Service token, direct SendPulse), /health}`. Implement as an explicit route allowlist/tag, not a path-prefix hook. Point `W4P_RETURN_URL` (`config.ts:101`) at `bill.nexttick.it/checkout/:id/return`.
- **Acceptance:** AC-2 (401/403), AC-5 (only checkout + login public), AC-13 (no direct backend); e2e: operator token→200, no/foreign token→401/403, public checkout read→200 without auth.

### Phase 6 — Frontend (Vue 3 + Vite + Pinia + vue-router + vue-i18n) + Pages Functions BFF
Current `packages/frontend` is a bare stub: `src/index.ts` only, deps = `@billing-service/shared` only (`package.json:11-13`) — no Vue toolchain yet.
- **6.1 scaffold:** add Vue 3/Vite/Pinia/vue-router/vue-i18n deps + `vite.config.ts`, `index.html`, strict `tsconfig` extending `tsconfig.base.json`; wire `build`/`typecheck`/`lint` scripts (AC-18). Structure per docs/19 §8: `components/`, `modules/{checkout,payments,quarantine,session}/`, `styles/`, `i18n/`, `router/`, `app/`, `functions/api/`.
- **6.2 design tokens (AC-16):** port `NextTick.it/nexttick-index.css` tokens (docs/19 §9 table) into `styles/` as `:root` (dark default) + `[data-theme="light"]`, incl. `--scan`/`--vignette`/`--tint`. Font `--mono: "JetBrains Mono"…`.
- **6.3 primitives (AC-16):** `components/` — Button, Input, Select, Panel, Table, Modal, Toast, Spinner, ThemeToggle, LangSwitch. No business coupling.
- **6.4 i18n + theme (AC-17):** vue-i18n en/ru/uk, per-module namespaces, autodetect from `navigator.language`, override→`localStorage`, **missing key fails build/test** (no silent English fallback). `data-theme` on `<html>`, dark default, `prefers-color-scheme` autodetect, override→`localStorage`.
- **6.5 checkout module (AC-9/10/11/12):** `/checkout/:id` renders amount+currency+period (JSON read via BFF), single "Pay by card" → `POST …/pay` → auto-submit the WayForPay form (`{action,fields}` shape from `wayforpay/purchase.ts:39-55`). `/checkout/:id/return` polls session status until `completed`/timeout/declined. Expired/completed → terminal state, not a form.
- **6.6 operator console (AC-14/15):** `session/` login (`/operator/login`) → BFF sets Secure HttpOnly cookie; router guard on `/operator/*` → redirect to login without cookie. `payments/` filter by `externalUserId` → detail (Charges) → cancel + create. `quarantine/` list → bind.
- **6.7 BFF (AC-13/14/19):** `functions/api/` Pages Functions proxy to `BACKEND_ORIGIN` with the shared-secret header; cookie→operator-token injection for `/operator` `/api/*`; NO cookie → 401 without calling backend; secrets from Pages env, not committed. SPA deep links resolve on refresh.
- **Acceptance:** AC-9..19; `npm run build` (frontend) → Pages-deployable artifact (`dist/` + `functions/`).

### Phase 7 — Doc & convention ripples (same change, docs/19 §12)
- Update `CLAUDE.md` §6 (entity list `Subscription`→`Payment`, "one active subscription"→"one active Payment"), §8/§9 (routes: no `/support`; `/api/payment` + `/api/quarantine`), §5 (table names `subscriptions`→`payments`, `incoming_payment_events`→`charges`; note `payments`→`charge_fixations`/`charge_fixations`).
- Update `docs/00, 05, 06, 12, 16, 18`: `Subscription→Payment`, `IncomingPaymentEvent→Charge`, `/api/support/*→/api/payment`+`/api/quarantine`; add the date model; note `paid_till` stays external (SendPulse).
- **Acceptance:** AC-1 (docs no longer refer to Subscription for the recurring entity).

---

## 7. Testable acceptance criteria → docs/19 AC map

| AC (docs/19 §10) | Verified by |
|---|---|
| AC-1 no `Subscription`/`support` symbols/routes/tables/docs | grep=0 after Ph1/2/3/7; route table review |
| AC-2 `/api/payment?externalUserId=` operator-only; 401/403 else | Ph5 backend e2e (operator 200 / foreign 403 / no-cookie 401 at BFF) |
| AC-3 `POST /api/payment` create + later Charge auto-binds | Ph3 e2e create→unmatched charge→auto-bind |
| AC-4 detail lists all Charges | Ph3 e2e create→charge→GET detail lists it |
| AC-5 only checkout + login public | Ph5 auth matrix e2e |
| AC-6 rename migration, no data loss, replay intact | Ph1/2 migration e2e: seed pre-rename rows, migrate, assert rows/replay |
| AC-7 `currentPeriodStart/End`, `nextPaymentDate`, no `paid_till` | Ph4 schema/migration; grep `paid_till`=0 |
| **AC-8 drift-free (X+7 → anchor+period, not paidAt+period)** | Ph0.1 pin + Ph4.4 flip test in `billing/test/scheduler.test.ts` |
| AC-9 `/checkout/:id` renders amount/currency/period, no subscriber data | Ph6 checkout module test + JSON read excludes `externalUserId` |
| AC-10 expired/invalid/completed → terminal state | Ph6 checkout status branch test |
| AC-11 Pay→`POST …/pay`→auto-submit W4P form | Ph6 e2e (form action/fields from `purchase.ts`) |
| AC-12 return polls until completed/timeout/declined | Ph6 return-page poll test |
| AC-13 no direct backend hit | Ph6 network trace / BFF-only client |
| AC-14 `/operator/*` cookie-guarded; HttpOnly; no token in storage | Ph6 router guard + BFF cookie test |
| AC-15 filter/cancel/create/bind flows | Ph6 module tests |
| AC-16 `/components` agnostic; tokens match §9 | Ph6.2/6.3 |
| AC-17 autodetect theme+lang, persisted, catalogs complete | Ph6.4 (missing-key build failure) |
| AC-18 frontend typecheck+lint pass | Ph6.1 CI gates |
| AC-19 `npm run build` Pages artifact; deep links; env secrets | Ph6.7 build check |

---

## 8. Expanded test plan

**Unit (`*.test.ts`, hermetic, no Postgres — CLAUDE.md §11):**
- `payment/test/period.test.ts` (renamed) — `addPeriod` clamp cases stay green (real dates; leap `2024-02-29`).
- `billing/test/scheduler.test.ts` — the AC-8 drift pair (Ph0.1 pin → Ph4.4 flip); retry ladder 0/1/3/5/7 unchanged (`retry.test.ts`).
- `payment/test/retry.test.ts`, `matcher.test.ts`, `domain.test.ts`, `cancel.test.ts` — symbol-renamed, behavior identical.
- Frontend: i18n catalog completeness (missing key throws), theme/lang autodetect, checkout status→view mapping, `addPeriod`-free date formatting.

**Integration (backend, on the ManagedRuntime, connection-light):**
- Route decode/encode + `toHttp` mapping via `makeRoute` (`infra/http/route.ts:39-67`); `requireRole` → 403 (`Forbidden.toHttp`), missing bearer → 401.
- Shared-secret pre-handler rejects requests lacking the header.

**E2E (`*.e2e.ts`, real Postgres in Docker, one DB per scenario — CLAUDE.md §11, docs/11):**
- Rename migration: seed pre-rename `subscriptions`+`incoming_payment_events` rows, run migrator, assert rows land in `payments`/`charges` with data + replay intact (AC-6).
- Checkout→callback→Payment created + `payment_succeeded` emitted (existing `payments/test/pipeline.e2e.ts` retargeted to `charges`, idem keys unchanged).
- `POST /api/payment` create → later unmatched Charge auto-binds (AC-3); detail lists Charges (AC-4).
- Auth matrix: operator token 200, foreign token 403, no token 401, public checkout read 200 (AC-2/5).
- Drift: charge fails day X, succeeds retry X+7 → `currentPeriodEnd = anchor+period` (AC-8, end-to-end).

**Observability (docs/03 §Observability; CLAUDE.md §10):**
- Structured logs keep correlation ids; scheduler error path (`scheduler.ts:111-118`) still logs `subscriptionId` (rename to `paymentId`).
- Metrics: successful/failed/pending payments, retries, callback errors, quarantine size, undelivered events, payments-in-retry, poller freshness, migration tail — ensure the rename doesn't drop any metric label; each operator queue keeps its alert.
- BFF: log 401s (no-cookie rejections) at the edge without leaking the backend origin.

---

## 9. Risks & mitigations (summary)

- **R1 idem-key/orderReference drift → double charge/event (AC2).** Keep all `w4p:`/`w4pcb:`/`sub_` literals byte-identical; scheduler path gated off, so no live rows. (See Pre-mortem S2.)
- **R2 table-rename desync → runtime SQL errors.** Migration + all repo literals in the same phase; grep gate. (S1.)
- **R3 auth over-tightening → self-DoS or backend leak.** Role check only on operator surface; callback stays signature-only; service-create stays Service token; BFF gate additive. (S3.)
- **R4 external sink contract break** (`subscription_created`/`subscription_cancelled` are wire strings). Do NOT rename event names in this change unless versioning the sink contract; flag OQ-2.
- **R5 `Currency`/`PaymentMethod` live in the renamed slice** (cross-imported by `checkout.ts`/`event.ts`). Keep re-exported from `payment.ts`; defer the clean split (OQ-1).
- **R6 ESLint budgets** (complexity ≤10, max-lines-per-function ≤60, max-params ≤4). Payment detail + create handlers must stay small — extract helpers; pass options objects; the `advanceAfterSuccess` signature grows to an anchor pair → wrap in a single `PeriodAdvance` options object to respect max-params.
- **R7 frontend from scratch is large.** Phase 6 is independently shippable after Phases 1–5 land; can be split into 6a (scaffold+tokens+i18n/theme+primitives) and 6b (modules+BFF) if review prefers smaller PRs.

---

## 10. Verification steps (run before claiming any phase done)
1. `npm run typecheck` (strict, `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`/`verbatimModuleSyntax`) — CLAUDE.md §4.
2. `npm run lint` (budgets are hard gates) — CLAUDE.md §4.
3. `npm test` (hermetic units).
4. E2E runner against Docker Postgres for the phase's scenario (`docker-compose.e2e.yml`) — CLAUDE.md §11.
5. Targeted greps: `IncomingPaymentEvent`=0 (after Ph1), `Subscription|subscriptions`=0 in `src` (after Ph2), `/api/support`=0 (after Ph3), `paid_till`=0 (after Ph4).
6. Delegate a `critic`/`code-reviewer` pass per phase (separate lane; no self-approval — CLAUDE.md operating principles).

---

## 11. ADR (Architecture Decision Record)

**Decision.** Rename charge-side first (`payment.ts→charge.ts`, `payments/→charge/`, `incoming_payment_events→charges`), then payment-side (`subscription.ts→payment.ts`, `subscription/→payment/`, `subscriptions→payments`) via **big-bang-per-side** atomic changes (Option 1A) with typed `.ts` `ALTER TABLE … RENAME` migrations; add a **stored anchor** date model (`currentPeriodStart`/`currentPeriodEnd`/`nextPaymentDate`, Option 2A) and advance the period from the anchor; enforce operator auth on the operator surface only; and ship a Vue 3 SPA + Pages Functions BFF.

**Drivers.** Naming collision forces ordering (DriverA); the external sink contract must not silently break (DriverB); the retry-success drift bug is real and needs a preserved anchor (DriverC).

**Alternatives considered.** 1B staged-with-shims (rejected: transient dual-naming risks AC-1, adds transition-only code against CLAUDE.md §3 conv.4). 2B derive-`nextPaymentDate` (rejected for MVP: defeats the indexed `findDue` hot path required by the 100k-same-day drain NFR; revisit later).

**Why chosen.** 1A resolves the collision by the ordering it already needs and yields the cleanest AC-1 end state; 2A fixes drift while preserving the single-column indexed claim query and trivial console reads; scoping the role check to the operator surface avoids breaking the signature-verified callback and the Service-token session-create.

**Consequences.** Two large but green-between atomic side-renames; one denormalized `nextPaymentDate` to keep consistent with the anchor; wire event names and idem-key literals deliberately unchanged (opaque transport stability) — the entity rename does NOT propagate to the sink vocabulary in this change; the `payments` fixation table gets a new name (`charge_fixations`/`charge_fixations`) to free `payments` for the recurring entity.

**Follow-ups.** All six open questions are resolved (§12): value types owned by `payment` (no split); our outgoing events renamed `subscription_*`→`payment_*` (provider events untouched); fixation table = `charge_fixations`; deliveries route deleted; create requires full fields; domain `bill.nexttick.it` `/checkout`+`/operator`. Remaining external: Cloudflare account/domain registration; re-evaluate 2B only if the console later needs richer schedule projection.

---

## 12. Open questions — RESOLVED (user decisions, 2026-07-15)
- **OQ-1 →** `Currency`/`CurrencyCode`/`PaymentMethod`/`RETRY_SCHEDULE_DAYS` stay in `payment.ts`, **owned by the payment slice**; `checkout`/`event` import them cross-slice — allowed. **Not** split (Phase 2.1).
- **OQ-2 →** Rename OUR outgoing events `subscription_created → payment_created`, `subscription_cancelled → payment_cancelled` (sink is a stub → safe). Do NOT rename anything WayForPay sends us (Phase 2.3).
- **OQ-3 →** Fixation table = **`charge_fixations`** (Charge = single instance; Payment = recurring entity) (Phase 2.4).
- **OQ-4 →** **Delete** the operator deliveries route — no unneeded routes / no dead code; the outbox delivery machinery stays (Phase 3.3).
- **OQ-5 →** "Create Payment" **requires** `externalUserId` + amount + currency + period + method up front (Phase 3.2).
- **OQ-6 →** Domain **`bill.nexttick.it`** with `/checkout/:id` (public) and `/operator/*` (console). Card-only MVP; Cloudflare account/domain registration still pending (external).

---

## 13. Consensus review outcome + changelog

**Verdict: SOUND-WITH-CHANGES.** Independent adversarial review (architect + critic lenses) against the real tree confirmed the strategy (forced rename ordering, accurate drift diagnosis, stable wire/idem keys, correct auth-scoping instinct) and found 2 blocker/major correctness holes + several under-specified mechanisms. All required changes are folded into the phases above. Full review: `.omc/drafts/plan-review.md`.

**Applied (folded into the phases):**
- **F-A (BLOCKER)** Phase 4.2 backfill is now status-branched — `past_due` anchors on `firstFailureAt`, not the retry date, so the migration doesn't bake in drift; e2e seeds a `past_due` row.
- **F-D (MAJOR)** Phase 4.5 threads the anchor through `createOrExtend`/`insert`/`extend`/`CreateSubscription`/`ExtendSubscription` so fresh Payments (incl. `POST /api/payment` create) get non-null anchors.
- **F-J (MAJOR)** Phase 5.1 wires the operator credential path: routes must resolve the `bss_` **session** token (via `authenticate`), not `bst_` auth-tokens (`authenticateToken`).
- **F-C (MAJOR)** Phase 5.3 replaces the blanket `/api/*` secret gate with an explicit allowlist (excludes the provider callback + direct SendPulse create).
- **F-B (MAJOR)** Phase 5.1b makes the admin-vs-operator decision explicit; `requireRole` is strict `===` (Admin token 403s on the operator surface) — console login must yield an Operator-role principal.
- **F-G (MAJOR-impact, silent)** Phase 2.5 adds the second grep gate: charge-module `FROM/INTO payments` → `charge_fixations` (else it silently reads the new recurring table).
- **F-F (MINOR, load-bearing)** Phase 2.3 extracts the `sub_` prefix into one shared constant (mint `scheduler.ts:41` + match `matcher.ts:7`).
- **F-I (MINOR) — overridden by OQ-4:** the review recommended *parking* the deliveries route, but the user chose **delete** it (no dead/unneeded routes). Phase 3.3 deletes it; the outbox delivery machinery stays. Re-add the route with its screen later.

**Reframes (accepted, tracked here rather than re-writing every phase):**
- **F-E** "Green between phases" holds only at **phase-commit** boundaries; the working tree is transiently red *within* a phase. The `shared` barrel edits (`index.ts:1,5`) and the hard compile-dep import repoints (`event.ts:3`, `checkout.ts:3` → the renamed slice) MUST land atomically with each file rename in the same commit — independent of the OQ-1 relocation decision. A side is one uninterruptible unit of work, not committable sub-steps.
- **PR split (recommended sequencing):** (a) backend rename + date model + migration (Phases 1,2,4) — the only irreversible DB work, isolated + heavily e2e-tested; (b) API reshape + auth (Phases 3,5); (c) frontend + BFF (Phase 6) against the frozen shared-schema + route contract, parallelizable. This keeps each PR's blast radius reviewable and lets the UI proceed against a pinned contract.
- **Antithesis noted:** 2A's third date column `currentPeriodStart` is display-only (justified by docs/19 §6 "actual period start–end"); the feared `nextPaymentDate`/anchor divergence is not real (they're the same renamed scheduling column, not a copy). Advancement always reads the anchor.

**Verification additions:** the migration e2e must assert `raw_events`/`attempts` row counts survive (not just Payment rows); add the two silent-corruption grep gates (F-A past_due anchor, F-G charge-module `charge_fixations`) to the per-phase checklist (§10).

**Status:** `pending approval`. No code written; no execution skill invoked.
