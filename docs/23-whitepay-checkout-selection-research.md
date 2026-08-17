# WhitePay hosted-checkout: coin/network selection & conversion (follow-up research)

Status: research report (2026-07-23). Produced by two deep-research workflows (211 agents
total) with 3-vote adversarial verification of every claim against source code + vendor docs.
Follow-up to [17-whitepay-research.md](17-whitepay-research.md); it **corrects one factual
error in doc 17** (see "Correction to doc 17" below) and answers the open coin/network /
conversion questions that fed the recurring spec [22-whitepay-recurring-spec.md](22-whitepay-recurring-spec.md).

> ⚠️ Same source-access caveat as doc 17: **docs.whitepay.com returns HTTP 401** and
> help.whitebit.com 403 to anonymous fetchers. All API-shape findings rest on **plugin/SDK
> source code** (strongest available evidence for required-vs-optional fields) and all
> hosted-page/UX findings on **official vendor walkthroughs with screenshots**. "Optional/absent"
> is proven as "not sent by any of four independent integrations," not "the server rejects it."

## TL;DR — the make-or-break answers

| Question | Answer | Confidence |
|---|---|---|
| Does the merchant set coin+chain at link creation, or the payer at checkout? | **The payer**, on the hosted page. Create-order is **fiat-denominated only**. | high (3-0 ×2) |
| Is the payer forced to pay in our receiving wallet's coin/network? | **No.** Payer picks any supported coin+network; an FX layer converts to our settlement asset. | high (3-0) |
| Can we pre-force / pre-fill a coin or network? | **No** on the live endpoint. That only existed on the **deprecated** `/acquiring/{slug}/pay`. | high (3-0) |
| Order / `acquiring_url` TTL? | **Unknown.** The "~2 min" is only the **rate re-quote** window, not the order lifetime. No TTL field in any SDK. | medium — needs authenticated docs / live test |
| Does the webhook/order reveal the coin+network used? | **Coin: yes** (`deposited_currency`/`received_currency`). **Network: no explicit field** — inference-only. | high (coin) / low (network) |
| Public sandbox / demo checkout URL? | **None reachable anonymously.** Real checkouts need a merchant-created order. Use vendor screenshots or a demo account. | high (3-0) |

## Q1 — Who selects coin + network (merchant at creation, or payer at checkout)?

**The payer selects both the cryptocurrency and the blockchain network on the hosted page
(`order.acquiring_url`). The merchant only denominates the order in a fiat/invoice currency.**

- **Create-order body is fiat-only.** All four independent integrations POST only
  `{amount, currency, external_order_id}` (+ optional `successful_link`/`failure_link` a.k.a.
  `return_url`/`cancel_url`) to `POST /private-api/crypto-orders/{slug}`. There is **no**
  `currency_id`, `method`, or `network` field. Critically, **`currency` here is a FIAT ticker**
  (UAH/USD/…), not crypto — WooCommerce sends the store fiat currency; OpenCart hardcodes `UAH`;
  the Go SDK comments label it "invoice currency (ticker)".
- **The payer picks on the hosted page.** Vendor walkthroughs, verbatim: *"select the asset and
  the network in which the payment will be made"* (external-wallet path); *"Select the
  cryptocurrency you would like to use… you can also specify a preferred network"*; the WhiteBIT-app
  path selects the asset and auto-handles the network. Amount is computed **after** the payer picks,
  at a rate **locked ~2 minutes (120 s)**.

Sources: `github.com/common-repository/whitepay-for-woocommerce` (`class-whitepay-api-handler.php`),
`github.com/vzaichikov/opencart-whitepay`, `git-seb/whitepay-magento2`,
`github.com/FairyTale5571/go-whitepay` (`crypto.go` `CreateNewOrderRequest`),
`whitepay.com/news/how-to-pay-for-purchases-with-whitepay`,
`whitepay.com/news/how-to-quickly-and-securely-pay-with-crypto`,
`whitepay.com/product/crypto-acquiring`. Verified unanimous 3-0 across both workflows.

## Q2 — Wallet-match vs conversion: can the payer pay in a different coin/chain than we receive?

**Yes. The payer is not forced to match our receiving/settlement asset. WhitePay has a built-in
FX/auto-conversion + rate-lock layer.**

- The fiat invoice is quoted into whatever coin the payer picks; **payer pays coin X while the
  merchant settles in coin Y**. The API data model encodes the split directly: `Order.currency`
  (invoice/fiat) vs `Order.received_currency` ("balance currency" = settlement) vs
  `Order.deposited_currency` (what the payer sent), reconciled by a **fixated `exchange_rate`**.
- **Merchant settlement is configured separately** (fiat OR crypto, chosen at account setup):
  auto-convert receipts to USDT/USDC, Balance Swap between assets, and at-withdrawal conversion of
  the stablecoin balance into a chosen crypto "at the current rate… rate locks at request time."
  WooCommerce plugin doc: *"All funds received are converted to fiat or crypto, depending on what
  the merchant chose during account setup."*
- **Broad pay-in menu.** Marketed 140–200+ assets "from any wallet"; each coin carries multiple
  networks (`CryptoCurrency.Networks` map in the SDK — e.g. USDT across TRC-20/ERC-20/BEP-20).
  ⚠️ The exact count is **inconsistent marketing** (140+/200+/250+/~270) and never appears in API
  docs — treat as "many," not a spec. No reachable page enumerates the full coin+network list.

Net for us: **we can expose many pay-in options to payers without touching our receiving-wallet
config, and we don't collect or pass coin/network at all.** Sources: `go-whitepay/entities.go`,
`whitepay.com/product/volatility-prevention`, `…/product/conversion-withdrawal`,
`…/product/balance-swap`, `help.whitebit.com/…/What-is-Whitepay`, OpenCart extension page.
Verified 3-0.

## Q3 — Order / acquiring_url TTL and rate-lock timing

- **Rate lock: ~2 minutes (120 s), fixed when the payer selects the currency** on the hosted page
  (not at merchant order creation). Consistent across vendor pages: *"converted… at the current
  exchange rate and fixed for 2 minutes"*; *"frozen for 120 seconds."* Verified 3-0.
- **Order/`acquiring_url` lifetime: UNKNOWN.** No expiry/TTL field appears on the Go SDK `Order`
  struct. The ~2-min figure is the **rate re-quote** window, **not** confirmed to equal the order's
  technical lifetime. Whether the order transitions to EXPIRED/CANCELED and on what clock can only
  be confirmed on the 401-gated authenticated docs or via a live test. **(medium confidence.)**

**Design consequence:** mint the WhitePay order **on click, not at prompt time** — the rate clock is
only ~2 minutes, so any pre-minted link would re-price or die long before a 48h payment window.
This is exactly the on-click design already locked in doc 22 (D3); this research strengthens its
rationale rather than changing it.

## Q4 — Does the order/webhook reveal the coin + network the payer used?

- **Coin: yes.** `Order.deposited_currency`, `Order.received_currency`, and `Transaction.currency`
  record the asset. **(high confidence.)**
- **Network: no explicit field** on `Order` or `Transaction` — a `Network` type exists only in the
  currency **catalog** (available options), not on the paid order. The chain used is **inference-only**.
  Three competing "the webhook cleanly reveals coin+network" claims were **refuted** during
  verification (votes 0-3 / 1-2). **(low confidence on network.)**

Consequence: "remember the method the payer used last cycle" can capture the **coin but not reliably
the chain** — and see the spec note below on why coin-level memory is largely moot for WhitePay anyway.

## Q5 — Test / demo checkout (to see it yourself)

**No anonymously reachable public sandbox or demo checkout URL.** `pay.whitepay.com` is live
(Cloudflare-fronted) but its bare root returns **HTTP 404 JSON**; real hosted checkouts live only at
`merchant.pay.whitepay.com/crypto-orders/{order_id}`, which require a merchant-created order.

To see a real coin/network selector, ranked:
1. **Vendor walkthroughs with screenshots** — `whitepay.com/news/how-to-pay-for-purchases-with-whitepay`,
   `…/how-to-quickly-and-securely-pay-with-crypto`, `…/how-to-pay-for-a-bitcoin-invoice`,
   `whitepay.com/product/crypto-acquiring`.
2. **A live checkout via a demo account** — verified WhiteBIT account + 2FA → demo workspace
   (full functionality ~24h), self-generate an API token in **CRM → Settings → Tokens**, create one
   order, open its `acquiring_url`. (From prior research; not re-verified live. No public testnet/faucet
   checkout surfaced.)

## Correction to doc 17

Doc 17's "API surface" table (and killed-claim #5) called the create-order body
`{amount, currency_id (UUID), method:"WALLET", network:"TRX"}` the **"authoritative"** shape and
labeled the fiat-only `{amount, currency, external_order_id}` a "subset/older shape." **This was
backwards.** The `currency_id`+`method`+`network` shape belongs to the **separate, explicitly
deprecated** `POST /acquiring/{slug}/pay` endpoint (`// Deprecated: DO NOT USE THIS METHODS RIGHT
NOW` in the Go SDK). The **live** `POST /private-api/crypto-orders/{slug}` takes only the fiat-denominated
`{amount, currency (FIAT), external_order_id}` (+ optional redirect links), and the **payer** selects
coin+network on the hosted page. Doc 17 has been annotated accordingly.

## Implications for the recurring spec (doc 22)

1. **"If the user selects everything at checkout, it's simple" → CONFIRMED.** We create a
   fiat-denominated order and let WhitePay own coin/network. We collect nothing crypto-specific and
   can't pre-set it. This is the simplest branch.
2. **"Payment method preselected as crypto"** in our own pre-checkout session = **"this session
   routes to the WhitePay (crypto) provider."** There is no coin/network sub-selection for us to
   preselect — WhitePay's page owns it.
3. **"Default to previous method, but changeable" is largely moot at the WhitePay layer.** The payer
   re-picks coin+network fresh on WhitePay's page every cycle and we can't pre-fill it; and we can
   only reliably record the coin, not the chain. So "default to previous" only makes sense one level
   up — **defaulting the provider/method (WayForPay-card vs WhitePay-crypto)**, not the coin/network.
4. **On-click minting is reinforced,** not changed: the ~2-min rate lock makes any pre-minted WhitePay
   link non-viable; our own 48h session (below) holds the window, WhitePay is minted at click.

## Open questions (confirm at onboarding / on the authenticated docs)

1. Can a merchant **restrict** the pay-in coin/network menu (e.g. accept only USDT-TRC20), or is the
   full asset list always shown? (Marketing shows a broad menu; an allowlist toggle is 401-gated.)
2. **Actual order/`acquiring_url` TTL** and expiry status transitions — the one gap that touches our
   48h claim.
3. Does the **webhook** include the blockchain network the payer used, beyond the coin ticker?
4. Is payer-coin→merchant-coin **auto-conversion** always-on or opt-in, and what spread/fees apply on
   the FX and the ~2-min lock?

## Sources

Primary code: `github.com/common-repository/whitepay-for-woocommerce`,
`github.com/vzaichikov/opencart-whitepay`, `git-seb/whitepay-magento2`,
`github.com/FairyTale5571/go-whitepay` (`crypto.go`, `entities.go`, `acquiring.go` [deprecated]).
Vendor: `whitepay.com/news/how-to-pay-for-purchases-with-whitepay`,
`…/how-to-quickly-and-securely-pay-with-crypto`, `…/how-to-pay-for-a-bitcoin-invoice`,
`whitepay.com/product/crypto-acquiring`, `…/volatility-prevention`, `…/conversion-withdrawal`,
`…/balance-swap`, `help.whitebit.com/hc/en-gb/articles/25649783537565-What-is-Whitepay`,
`blog.whitebit.com/en/whitebit-pay-how-does-it-work/`. Liveness check: `pay.whitepay.com/` → HTTP 404
JSON (host up, root not a checkout). docs.whitepay.com — 401-gated (not readable).
