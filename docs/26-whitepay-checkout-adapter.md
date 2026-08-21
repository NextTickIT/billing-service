# WhitePay checkout adapter — implementation notes

> What shipped for the first WhitePay increment: a **one-time crypto checkout method**.
> Grounded in [27-whitepay-research.md](27-whitepay-research.md),
> [28-whitepay-recurring-spec.md](28-whitepay-recurring-spec.md),
> [29-whitepay-checkout-selection-research.md](29-whitepay-checkout-selection-research.md);
> credentials in [25-whitepay-credentials-uk.md](25-whitepay-credentials-uk.md).

## Scope (this increment)

WhitePay as a **crypto checkout method only** — the "fully portable" Flow A from doc 27.
It reuses the existing ingest → match → pipeline backbone with **no core change** (AC8): a
new provider is a new module plus a branch in the shared `pay`/callback routes.

**Explicitly NOT in this increment:** the recurring "manual_required" subsystem (doc 28,
D7–D12: provider-agnostic `attemptCharge`, `payment.manual_required`, our 48h session, the
on-click `GET /pay/{token}` mint, card graduation). A WhitePay checkout creates a Payment
with **no `recurringTokenRef`**, so the scheduler's `findDue` skips it — a crypto Payment is
simply never auto-charged, which is exactly correct (WhitePay has no reusable token). Layering
the manual-required flow on top is the natural next increment.

## What was built

- **`modules/whitepay/`** (mirrors `wayforpay`, processor-agnostic pipeline unchanged):
  - `config.ts` — `WhitePayConfig` tag: `slug`, `apiToken`, `webhookToken`, `apiUrl`, links.
  - `client.ts` — `createOrder` → `POST {apiUrl}/private-api/crypto-orders/{slug}`, **Bearer**
    auth (not per-request HMAC), fiat body `{amount, currency, external_order_id,
    successful_link, failure_link}` → `{ id, acquiringUrl, status }`. Rate-limited + transient
    retry, tolerant decode (`order` envelope OR flat).
  - `callback.ts` — `verifyWebhook`: **HMAC-SHA256 over the RAW body** keyed by the webhook
    token, `Signature` header (constant-time), `X-Secret-Key` shared-secret accepted
    defensively. `normalizeWebhook` → `Charge` (`source: whitepay_callback`, idemKey
    `wp:{order.id}|{status}`, `externalRef = external_order_id` = our session id).
  - `mapping.ts` — `COMPLETE → succeeded`, `DECLINED`/`CANCELED → failed`, everything else
    (incl. `PARTIALLY_FULFILLED`) → `pending`; amount → minor units, tolerant date/currency.
  - `contracts.ts` — permissive order/envelope schemas; `errors.ts` — typed errors with
    `toHttp()` (502 provider fault, 503 crypto-unavailable).
- **Shared** `PayInstruction = form | redirect` (discriminated on `kind`): card → a WFP form
  to POST; crypto → a `redirect` to the WhitePay `acquiring_url`. `PurchaseForm` gained
  `kind: 'form'`.
- **`checkout/routes.ts`**: `pay` branches on method — `Crypto` mints a fresh order **on-click**
  and returns the redirect (guarded by `WHITEPAY_ENABLED`); the `:provider` callback dispatches
  to the WFP or WhitePay verifier. Order minted on-click (not at session creation) so WhitePay's
  ~2-min rate lock is always fresh (doc 29).
- **Raw body**: `app.ts` now stashes `request.rawBody` for `application/json` too, so the
  WhitePay HMAC verifies the exact bytes (re-serializing the JSON is a signature-mismatch trap).
- **Runtime**: the WhitePay client lives on the **HTTP** runtime (the order is minted inside the
  request-serving `pay` route), not the worker.
- **Frontend**: `pay(id, method)` + a "Pay with crypto" button gated on
  `VITE_WHITEPAY_ENABLED`; the page follows a `redirect` instruction via `window.location`.
- **Tests**: `whitepay/test/{mapping,callback,client}.test.ts` (24 hermetic unit tests).

## Ships gated OFF

`WHITEPAY_ENABLED=false` until the slug + API token + webhook token are all provisioned
(docs/25) — mirrors how the W4P poller/scheduler ship dark. Disabled ⇒ no crypto method on the
checkout page, and the `pay` crypto branch returns 503.

## Assumptions to confirm at onboarding (401-gated docs)

1. **Create-order amount** is sent as **major units** (`minor / 100`) with a **fiat** currency
   ticker (`client.ts orderRequestBody`). Confirm the wire type (number vs string) and that the
   endpoint is `/private-api/crypto-orders/{slug}` on `api.whitepay.com`.
2. **Webhook signature**: HMAC-SHA256 hex over the raw body in the `Signature` header. Confirm
   header casing and whether `X-Secret-Key` is actually used.
3. **`PARTIALLY_FULFILLED`** (crypto underpayment) maps to `pending` → the checkout matcher does
   not complete it, so it **falls through to quarantine** (operator alert) rather than silently
   completing. Doc 28 wants a reconcile alert here; quarantine provides that today. Revisit if a
   dedicated underpayment path is desired.
4. Order / `acquiring_url` **TTL** (only the ~2-min rate lock is known) — on-click minting makes
   this a non-issue for checkout, but confirm for any future embedded-link use.

## Go-live checklist

1. Provision the three credentials (docs/25); set `WHITEPAY_SLUG`, `WHITEPAY_API_TOKEN`,
   `WHITEPAY_WEBHOOK_TOKEN`.
2. Register the webhook in the CRM → `https://bill.nexttick.it/api/providers/whitepay/callback`;
   copy the webhook token.
3. Set `WHITEPAY_ENABLED=true` (backend) and `VITE_WHITEPAY_ENABLED=true` (frontend build).
4. Create one order against a demo workspace, open its `acquiring_url`, pay, confirm the webhook
   drives a `payment` + `initial_payment_succeeded` end-to-end.

## Live validation (2026-08-21)

Validated against the real WhitePay API + a real-Postgres inbound e2e:
- Create-order `POST /private-api/crypto-orders/{slug}` Bearer-auth → **200**, `acquiring_url`
  returned, `external_order_id` echoed verbatim, **no token field** on the live response
  (recurring must stay on the card rail). Body `{amount, currency, external_order_id}` accepted;
  amount as number or string both parse.
- **Minimum order value ≈ 216.80 UAH / ~5.00 USD** — below-min returns HTTP **422**
  `{message, errors}` (surfaced now as a 422 with the provider message; see hardening below).
- Inbound: signed webhook → 200, tampered → 401, Payment(crypto, no token, active) +
  `initial_payment_succeeded`.

## Review hardening (2026-08-21) — applied after a 4-lens review (architect / critic / crypto / security)

- **Removed the `X-Secret-Key` shared-secret webhook fallback** — HMAC `Signature` is now
  required. The fallback was an attacker-preferred auth downgrade that transmits the secret in a
  header (`callback.ts verifyWebhook`).
- **Double-pay guard** — a completed checkout session no longer re-credits: the `pay` route
  returns 409 for a completed/expired session (no second order minted), and the checkout matcher
  ignores a success/late-decline for an already-completed session (→ quarantine = refund-candidate
  alert) instead of a second create-or-extend / spurious failure (`checkout/routes.ts`,
  `checkout/domain.ts`).
- **Below-minimum → 422, not 502** — WhitePay 400/422 now maps to `CryptoOrderRejected` (422)
  carrying the provider message, distinct from a retryable transport 502 (`whitepay/errors.ts`,
  `client.ts`).
- **Currency parsing case-normalized** — `currencyFromCode` upper/trims, so a `usd`/` USD ` from
  a provider isn't silently booked as UAH (`shared/schemas/payment.ts`).
- **Strict JSON + body limit** — the JSON content-type parser rejects malformed JSON with a 400
  (no silent `{}`) while still capturing `rawBody`; `bodyLimit` set to 256 KiB (`app.ts`).

### Tracked follow-ups (not blocking the gated Phase-1 checkout, do before scaling)

1. **Book amount/currency from the session, not the webhook** (defense-in-depth): thread
   `session.amount`/`currency` through the `Match` and use them in the checkout applier; cross-check
   the webhook `value` and quarantine on mismatch. Limits the blast radius of a webhook-token leak.
2. **Underpayment guard on `COMPLETE`**: once `received_total`/`expected_amount` units are confirmed
   at onboarding, reject/quarantine a `COMPLETE` whose `received_total` is materially short.
3. **Durable idempotency**: a UNIQUE constraint tying at most one checkout-sourced fixation to a
   session/payment (closes the concurrent double-credit race the matcher check only narrows).
4. **Commit a WhitePay inbound e2e** scenario (single COMPLETE → one credit; two COMPLETEs → one
   credit + alert; PARTIALLY_FULFILLED → quarantine; below-min → 422).
5. **`npm audit`**: transitive HIGH advisories (notably `undici`, on the outbound fetch path).
6. Minor: restore a typed union for the provider-callback ack output; capture FX fields
   (`deposited_currency`/`exchange_rate`) structurally; derive the minor-unit divisor from a
   per-currency exponent instead of a hardcoded `/100`.
