# WhitePay integration research

Status: research report (2026-07-22), produced by a deep-research workflow with 3-vote
adversarial verification of every claim against sources (104 agents; 60 claims survived
refutation, 15 overreaching claims were killed). "Verified" items survived ≥2/3 refutation
attempts against official WhitePay/WhiteBIT sources and their official/community plugin code.
Items marked **unverified** were extracted but did not clear the adversarial pass — re-check
before relying on them.

This is the WhitePay counterpart to [14-wayforpay-research.md](14-wayforpay-research.md).
It answers the request: *"can we integrate WhitePay the same way as WayForPay — generate a
checkout link, user pays, we receive a reusable token for future payments; how do we get
permission for that token; does it need support approval; is it even possible?"*

> ⚠️ Source-access caveat: the official developer docs at **docs.whitepay.com return HTTP 401
> to anonymous fetchers** and are not search-indexed — the full authoritative request/response
> and webhook schema live behind an authenticated merchant (CRM) session. The mechanics below
> were reconstructed from official doc **search snippets** plus **official/community plugin
> source code** (WooCommerce official mirror, OpenCart, Magento 2, a Go SDK) and the Corefy
> connector capability matrix. Confirm exact field names/casing against the authenticated docs
> once we have a merchant account.

## TL;DR — the make-or-break answer

**No — WhitePay cannot replicate the WayForPay `recToken` flow.** Steps 1–2 of the target
flow work; steps 3–4 do not.

| Target flow step | WhitePay? |
|---|---|
| 1. Backend generates a hosted checkout / payment link for an amount | ✅ **Yes** — `POST …/private-api/crypto-orders/{slug}` → `order.acquiring_url` |
| 2. User opens the link and pays | ✅ **Yes** — push payment: user scans a QR and sends crypto from their own wallet |
| 3. Callback returns a **reusable token / mandate / card-on-file** we store | ❌ **No such field exists** anywhere in the order object or webhook payload |
| 4. Backend later charges the user again, **no user interaction** (merchant-initiated) | ❌ **Not supported** — there is no charge-with-token / MIT endpoint |

The reason is architectural: WhitePay is a **push-based crypto acquirer** (WhiteBIT
ecosystem). Every payment is a fresh order the customer must actively sign/send from their own
wallet. There is no pull authorization the merchant can bank and re-use, unlike a card
`recToken`. This is confirmed independently by (a) the order/webhook schema, (b) a Go SDK's
status enum, (c) the **Corefy** connector capability matrix, and (d) three CMS plugins — none
of which expose recurring, tokenization, saved cards, card-on-file, or merchant-initiated
charges. See "Flow B" for what to do instead.

**Two important nuances that survived adversarial checking (don't let them mislead the team):**

1. **WhitePay's own marketing says "recurring payments" — but it does not mean tokenized
   auto-charge.** whitepay.com/product/crypto-payments says *"Ideal for recurring payments —
   let you receive multiple deposits to one fixed crypto address"* (a static-wallet /
   reconciliation feature), and crypto-acquiring copy says *"SaaS, hosting, and VPN providers
   use crypto acquiring for recurring payments."* Both mean **the customer pushes each payment
   manually / the merchant re-invoices repeatedly** — not that WhitePay stores a credential and
   pulls funds. Any claim that "WhitePay never mentions recurring" is false; any claim that
   "WhitePay supports recurring" in the WayForPay sense is also false.
2. **"Crypto physically can't do recurring" is only true for Bitcoin.** Account-based chains
   *can* do merchant-initiated pull via ERC-20 `approve`/`allowance`/`transferFrom` and
   ERC-4337 account abstraction (productized by Loop Crypto, NOWPayments, eco.com, etc.). So
   the impossibility is **WhitePay-specific, not crypto-wide** — WhitePay simply does not
   expose any allowance/mandate mechanism in its API. If unattended crypto recurring were a
   hard requirement, it would need a different (on-chain-allowance) provider, not WhitePay.

## Direct answers to the six questions

**A. Is it even possible?** No, not the reusable-token / merchant-initiated repeat charge
(steps 3–4). Verified across the order schema, webhook payload, Go SDK, Corefy matrix, and 3
plugins — none reference a token, mandate, saved method, card-on-file, or MIT charge. WhitePay
*does* also offer **fiat / national-currency acquiring and crypto↔fiat POS exchange** with
next-day fiat settlement, but there is **no evidence of card tokenization on the fiat side
either** — so fiat is not a rescue path for token re-use.

**B. Checkout-link creation.** `POST https://api.whitepay.com/private-api/crypto-orders/{slug}`
(the official mirror plugin uses base `https://api.whitepay.com/` + path `private-api/crypto-orders/`;
an older OpenCart plugin uses `https://pay.whitepay.com/private-api/crypto-orders/{slug}`).
Auth = **`Authorization: Bearer <token>`** (a static API key from the CRM, *not* per-request
HMAC signing like WayForPay's `merchantSignature`). Returns an **order object** with `id` and
**`acquiring_url`** (the hosted checkout link to redirect/send the user to). Hosted page model;
also CMS plugins and POS. See the API-surface table.

**C. Token / recurring permission.** N/A — there is no reusable token to grant permission for.
The only "consent" is the user completing a single push payment for a single order. Nothing
token-, mandate-, or allowance-shaped is returned in any response or webhook field.

**D. Support / approval requirements.** **Yes — mandatory.** KYB (Know Your Business) is
required for *all* partners who use the WhitePay API; WhitePay's legal department reviews
applications **up to 5 working days**, after which you **sign a crypto-acquiring license
agreement** and the workspace is activated. Only legal entities / sole proprietors can use the
API (not individuals). See "Onboarding" for the two entry routes (sales/partnership vs.
self-register-via-WhiteBIT) and the demo-account situation.

**E. Webhook/callback contract.** Server-to-server POST; **HMAC-SHA256 over the raw body**
keyed with a per-payment-page **Webhook Token**, delivered in the **`Signature`** header,
compared with strict `===` (some plugins also accept an `X-Secret-Key` shared-secret header).
Events `order::completed` / `order::declined` / `transaction::complete`; order statuses
`INIT / OPEN / COMPLETE / DECLINED / PARTIALLY_FULFILLED / CANCELED`. Ack with HTTP 200. See
"Webhook contract".

**F. SDKs.** **No official Node.js/TS SDK, no public OpenAPI, no Postman collection.** REST/JSON
+ hosted pages only. Community references: a Go SDK (`FairyTale5571/go-whitepay`) and CMS
plugins (WooCommerce official mirror, OpenCart, Magento 2). ⚠️ **Disambiguation:**
`WhitePayments/white-php` (whitepayments.com) is a **different company** — a Middle-East fiat
card processor — *not* WhiteBIT's crypto WhitePay. Do not integrate against it.

## API surface (verified from plugin code + doc snippets)

| Concern | Detail |
|---|---|
| Base URL | `https://api.whitepay.com/` (WooCommerce official plugin). CRM/dashboard at `https://crm.whitepay.com/`. Older OpenCart plugin targets `https://pay.whitepay.com/`. |
| Create order | `POST /private-api/crypto-orders/{slug}` (also seen as `/private-api/orders`). Returns `order.id` + `order.acquiring_url` (hosted checkout link). |
| Get order details | `GET /private-api/crypto-orders/{slug}/{orderID}` |
| Auth | `Authorization: Bearer <API token>`; token generated in CRM **Settings → Tokens** (requires 2FA / Google Authenticator enabled first). Per-merchant **`slug`** appended to the path. **No request-body HMAC.** |
| Request body (**live** `/crypto-orders` — CORRECTED 2026-07-23) | `{amount, currency, external_order_id}` + optional `successful_link`/`failure_link` (a.k.a. `return_url`/`cancel_url`). **`currency` is a FIAT ticker** (e.g. `UAH`/`USD`) — the order is **fiat-denominated**. There is **no `currency_id`/`method`/`network`**: the **payer** selects coin + network on the hosted page. Verified 3-0 across all four integrations (WooCommerce mirror, OpenCart, Magento2, Go SDK `CreateNewOrderRequest`). See [29-whitepay-checkout-selection-research.md](29-whitepay-checkout-selection-research.md). |
| Request body `currency_id`+`method`+`network` — **DEPRECATED endpoint, do NOT use** | The `{amount, currency_id (UUID), method:"WALLET", network:"TRX"}` shape belongs to the **separate `POST /acquiring/{slug}/pay`** endpoint, explicitly marked `// Deprecated: DO NOT USE THIS METHODS RIGHT NOW` in the Go SDK — **not** the live hosted-checkout contract. An earlier version of this table wrongly labeled it "authoritative"; corrected 2026-07-23. |
| Order object fields | `id, currency, value, expected_amount, received_total, exchange_rate, is_internal, deposited_currency, received_currency, status, external_order_id, created_at, completed_at, acquiring_url, successful_link, failure_link, order_number, transactions[]`. **No token/mandate/recToken/saved-method/card-on-file field.** |
| Order statuses | `INIT, OPEN, COMPLETE, DECLINED, PARTIALLY_FULFILLED, CANCELED`. `PARTIALLY_FULFILLED` matters — crypto amounts can arrive underpaid (tie to `received_total`). |
| Crypto mechanics | fiat→crypto rate locked for ~2 minutes; optional auto-conversion of receipts to USDT/USDC; QR of merchant wallet shown to the payer. |
| Three credentials needed | **Slug** (payment-page / merchant id), **API Token** (Bearer), **Webhook Token** (per payment page). |

Sources: official docs snippets `docs.whitepay.com/docs/http-api/auth` and
`…/acquiring/crypto`; official WooCommerce plugin mirror
`github.com/common-repository/whitepay-for-woocommerce`
(`includes/class-whitepay-api-handler.php`, `class-wc-gateway-whitepay.php`); OpenCart plugin
`github.com/vzaichikov/opencart-whitepay`; Magento 2 `git-seb/whitepay-magento2`; Go SDK
`github.com/FairyTale5571/go-whitepay`; `corefy.com/connectors/whitepay/`.

## Flow A — checkout & the token question (verified)

- Create a crypto order (backend, Bearer-authenticated) → receive `order.id` +
  `order.acquiring_url`. Redirect/send the user to `acquiring_url` (this is the WayForPay-style
  hosted link the request asks for). **This half maps cleanly onto our existing checkout
  slice.**
- The user pays by scanning a QR containing the merchant wallet address and **sending crypto
  from their own wallet** (or paying via the WhiteBIT app "express payment", which settles
  inside the exchange but still requires the user to confirm each payment).
- **No `recToken` analogue is issued** — not in the order-creation response, not in the
  webhook. There is nothing to store for a later unattended charge. This is the decisive
  divergence from WayForPay, where a full-card Purchase auto-issues a reusable `recToken`.
- Practical redirect caveat (OpenCart plugin note): the crypto gateway historically *"supports
  only post-payment from the success page because the gateway doesn't temporarily support
  customer redirection on success or fail. All webhooks are working."* → **treat the webhook as
  the source of truth for payment status; do not rely on browser redirect.** (Confirm current
  behavior — this note is from a community plugin.)

## Webhook / callback contract (verified from plugin code)

- **Transport:** WhitePay POSTs a JSON body with a top-level `order` object to the URL you
  configure per payment page (CRM: **Payment Pages → Webhooks**, then copy the generated
  **Webhook Token**).
- **Signature:** `HMAC-SHA256(rawBody, webhookToken)` compared **strict-equal** to the
  **`Signature`** header (`$_SERVER['HTTP_SIGNATURE']`). The WooCommerce (official) plugin
  HMACs the **raw request body** (`php://input`); the OpenCart plugin HMACs a **re-encoded**
  `json_encode($json)` and also accepts an alternative **`X-Secret-Key`** header equal to the
  shared secret. ⚠️ **Canonicalization pitfall:** sign/verify against the **raw body**, not a
  re-serialized JSON — re-encoding is a real-world signature-mismatch trap. Support both the
  `Signature` (HMAC) and `X-Secret-Key` (shared-secret) header modes defensively.
- **Payload fields used in practice:** `order.id`, `order.external_order_id` (our own id, used
  to match), `order.status`, `order.received_total`, `order.completed_at`.
- **Events / statuses:** events `order::completed`, `order::declined`, `transaction::complete`;
  statuses `INIT / OPEN / COMPLETE / DECLINED / PARTIALLY_FULFILLED / CANCELED`. Typical
  mapping: `COMPLETE → paid`, `DECLINED/CANCELED → failed`, `PARTIALLY_FULFILLED → underpaid /
  pending`.
- **Ack:** respond HTTP 200 on success; plugins return 500 on signature failure. (Exact
  retry / at-least-once semantics are **not documented publicly** — reconcile idempotently on
  `external_order_id`/`order.id` and confirm retry behavior with support. This mirrors how our
  WayForPay pipeline treats callbacks as at-least-once.)
- The server-to-server webhook is **distinct** from the browser `successful_link`/`failure_link`
  redirect — reconcile order state from the webhook, never from the redirect.

## Flow B — the recurring problem, and what to do instead

There is **no WhitePay equivalent of `transactionType=CHARGE` with a stored token.** To bill a
user every period on WhitePay, the realistic options are:

1. **Fresh checkout link per billing cycle (WhitePay-native, recommended if we must use
   WhitePay).** Our scheduler creates a **new** crypto order each period, then delivers the new
   `acquiring_url` (or QR) to the user (email / messenger / in-app) and waits for the webhook.
   This is *reminder-based recurring* — **the user must actively pay each cycle.** It is exactly
   what WhitePay itself markets as "recurring payments." It cannot be made unattended.
2. **On-chain allowance / pull subscriptions (NOT WhitePay).** ERC-20 `approve`+`transferFrom`
   or ERC-4337 session keys give a genuine merchant-initiated pull after a one-time user
   authorization — but **WhitePay does not expose this.** It would mean adding a different
   crypto-subscription provider (Loop Crypto, NOWPayments subscriptions, etc.) or a custom smart
   contract — a separate integration, out of scope for "integrate WhitePay."
3. **Keep unattended recurring on the card rail (WayForPay `recToken`); use WhitePay only for
   one-time crypto payments / top-ups.** This preserves the existing unattended scheduler
   (WayForPay flow B) and adds WhitePay purely as a *one-time* crypto acceptance method
   (checkout + webhook), where it fits our pipeline perfectly. **This is the recommended
   architecture if unattended recurring is a hard requirement.**

**Bottom line for the team:** if the requirement is *"reusable token → future unattended
charges,"* WhitePay is the wrong tool and no amount of onboarding/support approval unlocks it —
the capability does not exist in the product. If the requirement is *"accept crypto for a
checkout, get a clean webhook, reconcile it,"* WhitePay slots straight into our existing
checkout/callback pipeline.

## Onboarding, KYB & support approval (item D — verified)

- **KYB is mandatory** for all API partners (*"the KYB procedure [is] mandatory for all our
  partners who use: Whitepay API to accept online cryptocurrency payments"*). Only **legal
  entities / sole proprietors** may use the API — individuals cannot.
- **Approval timeline:** WhitePay's **legal department reviews applications up to 5 working
  days**, after which a **crypto-acquiring license agreement is signed and the workspace is
  activated**. Powered by EU-licensed WhiteBIT (registered VASP, incl. National Bank of
  Georgia); AML/CFT + Chainalysis screening apply.
- **Two entry routes (verified):**
  - **Sales / partnership:** "Contact Sales" form, `partnerships@whitepay.com`, or Telegram →
    a **personal account manager** guides KYB → sign agreement → activate.
  - **Self-register via WhiteBIT (faster):** *"Sign up via WhiteBIT"* using a **verified
    WhiteBIT exchange account with 2FA** → **immediate demo account**, with *"complete
    functionality available within 24 hours."* KYB + signed agreement are still required to go
    live for real acceptance.
- **Sandbox/test:** no formally labeled public sandbox, but a **demo account is available after
  registration** to exercise the flow. API keys are self-generated in **CRM → Settings →
  Tokens** *after* 2FA is enabled and the workspace is approved.
- **Support:** `support@whitepay.com` (technical), `partnerships@whitepay.com` (onboarding).

**What to write in the access request to WhitePay** (so we're unblocked fast):
1. Confirm our **legal entity** details for KYB and ask for the current KYB document checklist
   (it *"might undergo changes based on regulatory updates"* — not published).
2. Ask directly: **"Is there any mechanism for merchant-initiated / recurring charges, saved
   payment methods, or a reusable payment token — or is every charge a fresh customer-paid
   order?"** (Get the negative in writing; also ask whether any allowance/subscription product
   is on the roadmap.)
3. Ask for the **authenticated API docs access** (the public docs are 401-gated) and confirm:
   the exact **live** create-order schema — expected to be **fiat-only `{amount, currency, external_order_id}`**
   with the **payer** picking coin+network on the hosted page (see doc 23), NOT `currency_id`/`method`/`network`
   (those are the deprecated `/acquiring/{slug}/pay` shape) — the full **webhook event list +
   retry/at-least-once semantics + header casing**, whether webhooks fire for every status transition,
   and the **order/`acquiring_url` TTL**.
4. Confirm whether the **fiat/national-currency acquiring** side offers any card tokenization
   (expected: no) and its settlement terms.

## SDK / integration surface (item F — verified)

- **No official Node/TS SDK, no public OpenAPI/Postman.** REST/JSON + hosted pages. Hand-roll
  the client inside our provider adapter (same approach as the WayForPay adapter — matches the
  `PaymentProvider` boundary in [05-domain-model.md](05-domain-model.md)).
- **Reference implementations to port tests against:** `github.com/common-repository/whitepay-for-woocommerce`
  (official plugin mirror — best for the webhook contract), `github.com/vzaichikov/opencart-whitepay`
  (dual-header signature check), `git-seb/whitepay-magento2`, and the Go SDK
  `github.com/FairyTale5571/go-whitepay` (canonical status enum).
- ⚠️ **Trap:** `github.com/WhitePayments/white-php` and `white-ruby` belong to **whitepayments.com**
  (a Middle-East **fiat card** processor: `White_Charge::create`, test card `4242…`). This is a
  **different company** — ignore it entirely when searching for a "WhitePay SDK".

## Marketing-language traps (killed claims — record so we don't re-learn them)

The adversarial pass **refuted 15 overreaching claims.** The recurring themes:

- ❌ *"WhitePay never mentions recurring / subscriptions"* — **false**; it markets "recurring
  payments" (static-wallet reconciliation) and SaaS/VPN "recurring" use cases. ✅ The correct
  statement is: WhitePay mentions recurring **but has no tokenized merchant-initiated charge.**
- ❌ *"Crypto at the protocol level can't do recurring / has no account abstraction"* —
  **false**; that's Bitcoin/UTXO-specific. Ethereum/EVM support pull via ERC-20 allowances and
  ERC-4337. ✅ Correct: **WhitePay specifically** doesn't expose it.
- ❌ *"WhitePay has no fiat/card acquiring anywhere"* — **false**; it markets fiat/national-currency
  acquiring and crypto↔fiat POS exchange with next-day fiat settlement. ✅ Correct: fiat exists,
  **but no card tokenization on the fiat side either** (so still no token re-use path).
- ❌ *"Onboarding is not self-serve at all"* — **overreach**; you *can* self-register via a
  verified WhiteBIT account and get a 24h demo. ✅ Correct: **KYB + a signed agreement are
  mandatory to go live**, regardless of entry route.
- ⚠️ **CORRECTED 2026-07-23 — this item was itself wrong.** The earlier claim that the create-order
  body "requires `currency_id`+`method`+`network`" conflated the **deprecated `/acquiring/{slug}/pay`**
  endpoint with the **live `/private-api/crypto-orders/{slug}`** endpoint. ✅ Correct: the live body is
  **`{amount, currency (FIAT), external_order_id}`** (+ optional redirect links); the **payer** selects
  coin + network on the hosted page. Verified 3-0 across four independent integrations + vendor
  walkthroughs — see [29-whitepay-checkout-selection-research.md](29-whitepay-checkout-selection-research.md).

## What this means for our billing service

Mapping onto the WayForPay flows in [17-payment-flows](14-wayforpay-research.md)-style terms:

- **Checkout (flow A): fully portable.** WhitePay becomes another `PaymentProvider` adapter:
  create order → `acquiring_url` → redirect/deliver → webhook → same ingest→match→subscription
  pipeline. Idempotency key on `external_order_id` (+ `order.id`/status), raw-log + HMAC-verify
  the webhook exactly like the WayForPay `serviceUrl` handler. **Reuses the existing backbone
  with no core change** (the pipeline was designed source-agnostic).
- **Recurring scheduler (flow B): NOT portable.** There is no token to charge. If WhitePay must
  carry recurring, it degrades to *"generate a fresh link each cycle and ask the user to pay"*
  (option 1 above). Unattended recurring stays on WayForPay's `recToken` rail (option 3).
- **Migration poller (flow C):** N/A for WhitePay (that was a WayForPay-legacy concern).
- Recall the WayForPay plan already listed **"Crypto/Whitepay"** as out-of-scope for MVP — this
  research confirms *why*: WhitePay covers acceptance, not the reusable-token recurring model
  the gateway is built around.

## Known gaps / follow-ups for WhitePay support

1. **Authoritative API schema** — public docs are 401-gated. Get authenticated-docs access;
   confirm the **live** create-order body is fiat-only `{amount, currency, external_order_id}`
   (payer picks coin+network on the hosted page — see doc 23; `currency_id`/`method`/`network`
   belong to the deprecated `/acquiring/{slug}/pay`), and whether `api.whitepay.com` vs
   `pay.whitepay.com` and `/crypto-orders/{slug}` vs `/orders` are current.
2. **Webhook retry / at-least-once semantics + header casing** — undocumented publicly; confirm
   so we size idempotency/dedup correctly.
3. **Recurring/token capability in writing** — get an explicit yes/no on any merchant-initiated
   or allowance/subscription mechanism (and roadmap), so the "not possible" conclusion is
   vendor-confirmed, not just inferred.
4. **Fiat-side tokenization** — confirm the national-currency acquiring path has no card-on-file
   (expected: none).
5. **Rate limits** for `api.whitepay.com` — none documented; keep a client-side limiter (as
   03-nfr.md already requires).
6. **Underpayment handling** — `PARTIALLY_FULFILLED` lifecycle: how/when it resolves, and
   whether a top-up or refund path exists.

## Sources

Official (WhitePay / WhiteBIT):
`docs.whitepay.com/docs/http-api/auth`, `docs.whitepay.com/docs/http-api/acquiring/crypto`,
`docs.whitepay.com/docs/http-api/static-wallets` (all 401-gated to anonymous fetch, corroborated
via snippets); `whitepay.com/product/crypto-acquiring`, `…/product/crypto-payments`;
`whitepay.com/news/what-is-crypto-payments-api`, `…/express-payments-via-whitepay-and-whitebit-how-does-it-work`,
`…/accept-crypto-payments-with-fast-and-secure-crypto-payment-gateway-or-whitepay`,
`…/kyb-unlocking-success-in-partnership-with-whitepay`;
`help.whitebit.com/hc/en-gb/articles/25649783537565-What-is-Whitepay`;
`blog.whitebit.com/en/whitepay-everything-you-need-to-know/`,
`blog.whitebit.com/en/whitepay-invoicing-for-cryptocurrency-payments/`.

Plugin / SDK source (primary code evidence):
`github.com/common-repository/whitepay-for-woocommerce` (official plugin mirror),
`github.com/vzaichikov/opencart-whitepay`, `git-seb/whitepay-magento2`,
`github.com/FairyTale5571/go-whitepay`.

Third-party / capability enumeration:
`corefy.com/connectors/whitepay/` (flows = HPP + Payout only; recurring/tokenization/card-on-file/MIT
all absent), `help.zenedu.io/en/articles/9273269-how-to-connect-whitepay` (onboarding + credential steps).

Adversarial / context:
`ccn.com/education/crypto/bitcoin-recurring-payments-possible-limitations/` (why Bitcoin is
push-only), plus ERC-20 allowance / ERC-4337 references used to scope the "crypto can't do
recurring" claim to Bitcoin only.

Disambiguation (do **not** use): `github.com/WhitePayments/white-php` — different company
(whitepayments.com, Middle-East fiat card processor).
