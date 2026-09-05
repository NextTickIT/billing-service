# 30 — One-time payments & post-payment redirect URLs

Spec for two additions to the checkout flow. Prescriptive; cites the invariants each
change is measured against (CLAUDE.md §1 ACs, §6 domain model).

## 1. Motivation

Two capabilities the external system (SendPulse) asked for:

1. **One-time payments** — a checkout that grants a period of access but is **never
   renewed**: no stored reusable token, no scheduler charge, no retry ladder. The
   default checkout stays recurring (a subscription) unless the caller opts out.
2. **One-time payments are not capped per user** — a user may hold a single active
   *recurring* payment **and any number** of one-time payments at the same time. The
   "one active payment per `externalUserId`" interview decision (docs/18) is narrowed
   to **recurring** payments only.
3. **Redirect URLs** — checkout creation may optionally carry a `successUrl` and a
   `failureUrl`; the browser lands there once the **webhook** resolves the payment.

## 2. Data model

A single boolean carries the intent end-to-end — `CreateCheckoutSession → CheckoutSession
→ Match → Payment`:

- `CheckoutSession.recurring: boolean` and `Payment.recurring: boolean` (both **default
  true**, numeric/boolean at rest, mirrored in the shared schema).
- `CheckoutSession.successUrl / failureUrl: string | null` — persisted per session.

`CreateCheckoutSession` (POST body) adds `recurring` (optional, defaults true),
`successUrl`, `failureUrl` (optional). The two URLs are validated at the API boundary by
the shared `RedirectUrl` schema — an **http(s)** URL only, so a stored target can never be
a `javascript:` (or other-scheme) open-redirect the return page would navigate to. The
public read (`CheckoutSessionPublic`) exposes `successUrl`/`failureUrl` (the return page
needs them; they are the caller's own destinations, not subscriber data — AC-9 holds).

`CreatePaymentRequest` (operator direct-create) also gains optional `recurring`.

### Migration 0014

- `payments.recurring` / `checkout_sessions.recurring` `boolean NOT NULL DEFAULT true`
  (existing rows backfill as subscriptions).
- `checkout_sessions.successUrl` / `failureUrl` `text` (nullable).
- The **one-active-per-user** partial unique index is narrowed to
  `WHERE status = 0 AND recurring`, and the scheduler's **due** index to
  `WHERE status IN (0,1) AND recurring`.

## 3. One-time semantics (FR-003, AC-8)

`createOrExtend` branches on `params.recurring`:

- **Recurring** (default): find the user's active *recurring* payment
  (`findActiveRecurringByExternalUser`) → extend in place, else insert. Unchanged
  behaviour; one active recurring payment per user (partial unique index enforces it).
- **One-time**: **always insert** a fresh `Payment` — never extended, never collapsed
  into the recurring payment, no per-user cap. It stores **no reusable token**
  (`recurringTokenRef = null`) even when the provider returned a `recToken`, so the
  scheduler — whose `findDue` requires a token **and** `recurring = true` — can never
  pick it up. A one-time payment still sets the period anchors and emits
  `payment_created` + `initial_payment_succeeded` (period carried), so SendPulse grants
  the paid period exactly as for a recurring first charge; it simply never renews.

Provider code is untouched — `checkout`/`payment`/the pipeline stay processor-agnostic
(AC-8). A card change (`makeCardChangeMatcher`, the `/api/payment/card-change` route)
targets the **recurring** payment: the matcher marks `recurring: true`, and the route
resolves the newest recurring payment (`found.find(p => p.recurring)`), skipping any
one-time payments a user holds.

The `Match` type carries an optional `recurring` — consumed only on the `checkout`
create path (`recurring/card_change` matches act on an already-recurring payment, so it
defaults to true when absent).

## 4. Redirect URLs

The invariant (docs/26) is preserved: **state is reconciled from the webhook, never the
browser redirect.** Both providers still return the browser to our return page
(`/checkout/:id/return`), which polls the session status. When the poll observes a
webhook-confirmed outcome it then navigates to the caller's URL:

- `Completed` → `successUrl` (if set), else the built-in "confirmed" message.
- `Expired` / poll timeout → `failureUrl` (if set), else the built-in message.

A redirect therefore always reflects confirmed state — an optimistic provider bounce
never triggers it. When a URL is absent the behaviour is exactly as before.

**Known gap:** WhitePay's `failure_link` default points at the checkout page, not the
return page, so a crypto *hard failure* is not redirect-honoured until the session
times out on the return page (a slower `failureUrl` hit). The success path and the
WayForPay decline path are covered directly. Tightening the WhitePay failure default is
follow-up, not required by this change.

## 5. Acceptance criteria

- AC-4 (retry ladder) — untouched; one-time payments never enter it (no token, excluded
  from the scheduler).
- AC-5 (checkout → Payment + token) — a recurring checkout still creates a Payment and
  stores the token; a one-time checkout creates a Payment with **no** token by design.
- AC-8 (new provider/sink without core change) — provider modules untouched.
- AC-9 (`externalUserId` verbatim) — carried unchanged; redirect URLs are not derived
  from subscriber identity.
- The docs/18 "one active Payment per user" decision is restated as **one active
  *recurring* Payment per user**; one-time payments are unbounded per user.
