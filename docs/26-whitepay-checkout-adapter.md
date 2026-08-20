# WhitePay checkout adapter — implementation notes

> What shipped for the first WhitePay increment: a **one-time crypto checkout method**.
> Grounded in [17-whitepay-research.md](17-whitepay-research.md),
> [22-whitepay-recurring-spec.md](22-whitepay-recurring-spec.md),
> [23-whitepay-checkout-selection-research.md](23-whitepay-checkout-selection-research.md);
> credentials in [25-whitepay-credentials-uk.md](25-whitepay-credentials-uk.md).

## Scope (this increment)

WhitePay as a **crypto checkout method only** — the "fully portable" Flow A from doc 17.
It reuses the existing ingest → match → pipeline backbone with **no core change** (AC8): a
new provider is a new module plus a branch in the shared `pay`/callback routes.

**Explicitly NOT in this increment:** the recurring "manual_required" subsystem (doc 22,
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
  ~2-min rate lock is always fresh (doc 23).
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
   completing. Doc 22 wants a reconcile alert here; quarantine provides that today. Revisit if a
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
