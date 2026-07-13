# WayForPay integration research

Status: research report (2026-07-12), produced by a deep-research workflow with 3-vote
adversarial verification of every claim against sources. All "verified" items below survived
3-0 (or noted otherwise) refutation attempts against official WayForPay documentation.
Items marked **unverified** were extracted from sources but did not go through the
adversarial pass — re-check before relying on them.

Related: answers the WayForPay questions in [04-open-questions.md](04-open-questions.md);
feeds FR-002/FR-005/FR-008 in [02-functional-requirements.md](02-functional-requirements.md).

## TL;DR — recommended architecture

1. **Initial checkout (flow A)**: hosted payment page — POST form to
   `https://secure.wayforpay.com/pay` (Purchase). A successful payment with full card entry
   automatically yields a `recToken` (in the response and in the serviceUrl callback); no
   separate tokenization endpoint is needed. **Gotcha:** the tokenization-related fields
   (`regularMode` etc.) also create a WayForPay-managed charge schedule as a side effect —
   exactly what we're migrating away from. Either avoid a periodic `regularMode`, or
   immediately `REMOVE` the created schedule via regularApi, or use the separate
   Card Verify method (wiki 852189) to tokenize without a purchase.
2. **Our recurring charges (flow B)**: `transactionType=CHARGE` to
   `https://api.wayforpay.com/api` with `recToken` instead of card data. Token charges skip
   CVV and 3DS, so our scheduler can run fully unattended. Dedup/idempotency = unique
   `orderReference` (no idempotency header exists; duplicate orderReference is rejected).
3. **Migration poller (flow C)**: poll `TRANSACTION_LIST` as the operations journal with
   short overlapping time windows; dedupe on `orderReference`; use `CHECK_STATUS` to
   reconcile individual known orders and regularApi `STATUS` (`lastPayedDate`/`lastPayedStatus`)
   to watch specific legacy recurrents. The journal does **not** expose `recToken`, so tokens
   cannot be harvested — confirming migration only via user re-entry of card (00-tz §7).

## API surface (verified)

| Method | Endpoint | Auth / signature (HMAC-MD5, SecretKey, `;`-joined UTF-8) |
|---|---|---|
| Purchase (hosted page) | POST `https://secure.wayforpay.com/pay` | `merchantAccount;merchantDomainName;orderReference;orderDate;amount;currency;productName[0..n];productCount[0..n];productPrice[0..n]` |
| CHARGE (token or card) | POST `https://api.wayforpay.com/api` | same 9-field string as Purchase — `recToken`/card fields are **not** signed |
| CHECK_STATUS | POST `https://api.wayforpay.com/api` | request: `merchantAccount;orderReference`; response carries its own signature over `merchantAccount;orderReference;amount;currency;authCode;cardPan;transactionStatus;reasonCode` — verify it |
| TRANSACTION_LIST | POST `https://api.wayforpay.com/api` | `merchantAccount;dateBegin;dateEnd` (Unix timestamps) |
| Regular payments: STATUS / SUSPEND / RESUME / REMOVE / CHANGE | POST `https://api.wayforpay.com/regularApi` | **no HMAC** — plain `merchantAccount` + `merchantPassword` in the JSON body (a second credential type, obtained from WayForPay) |

Sources: wiki.wayforpay.com pages 852102 (Purchase), 852194 (Charge), 852117 (Check status),
1736786 (Transaction list), 852496 + 852526/852506/852513/852521/13271051 (regular payments),
852175 (tokenization), plus WayForPay's official PHP SDK (github.com/wayforpay/php-sdk,
github.com/wayforpay/PHP) as reference implementation.

## Flow A — initial checkout & tokenization (verified)

- `recToken` is issued automatically after a successful Purchase with full card entry;
  returned in the Purchase response and the serviceUrl callback. Caveat: example responses
  show `recToken` can be empty — community reports say tokenization must be **enabled on the
  merchant account** by WayForPay (unverified; confirm with WFP support).
- `regularMode` values: `client/none/once/daily/weekly/monthly/quarterly/bimonthly/halfyearly/yearly`;
  `regularBehavior=preset` locks the regular-payment parameters on the payment page;
  `dateNext` format is `DD.MM.YYYY`. A periodic `regularMode` creates a **WFP-managed
  schedule** — see TL;DR gotcha.
- 3DS applies to full-card flows (`WaitingAuthComplete`, reasonCode 1120); token charges are
  documented as "without input of CVV and without 3-D Secure authentication". Note: no 3DS
  does not guarantee approval — issuers can still decline merchant-initiated charges.

## serviceUrl callback contract (verified)

- HTTP POST from WayForPay; verify HMAC-MD5 signature over exactly 8 fields:
  `merchantAccount;orderReference;amount;currency;authCode;cardPan;transactionStatus;reasonCode`.
- Payload includes `transactionStatus`, `reason`, `reasonCode`, `recToken`, `cardPan`, `fee`,
  `createdDate`, `processingDate`.
- Required acknowledgment: JSON `{orderReference, status:"accept", time, signature}` with
  signature over `orderReference;status;time`.
- **At-least-once delivery: retries for 4 days** until a correct response is received
  (retry cadence within the window is undocumented). Idempotent, raw-logged processing keyed
  on `orderReference` is mandatory — matches FR-007/FR-010.
- `returnUrl` is a browser redirect only; no retries, no server semantics.
- Practitioner quirks (unverified): content-type varies (JSON vs form-encoded) across flows;
  WFP's own plugins skip fields absent from the payload when rebuilding the signature string.

## Flow B — gateway-controlled recurring charges (verified)

- CHARGE with `recToken`; either full card data or `recToken` is obligatory.
- No idempotency header. `orderReference` uniqueness is the dedup mechanism —
  reasonCode **1112 "Duplicate Order ID"** is returned on reuse (1112 itself: unverified).
  Design: deterministic orderReference per billing attempt, e.g.
  `sub_{subscriptionId}_{period}_{attempt}`.
- Raw-card CHARGE requires PCI/host2host account approval; token charge is the practical path.
- Retry policy is entirely ours (that's the point). WFP's own legacy retry on insufficient
  funds is **daily, merchant-uncontrolled, with undocumented termination** — verified from
  official docs, confirming the migration motivation.

## Flow C — migration poller design (verified)

- **Journal**: `TRANSACTION_LIST` with `dateBegin`/`dateEnd` Unix timestamps. Response fields
  per transaction: `transactionType, orderReference, createdDate, amount, currency,
  transactionStatus, processingDate, reasonCode, reason, email, phone, paymentSystem,
  cardPan, cardType, issuerBankCountry, issuerBankName, fee, settlementDate`
  (apiVersion 2 adds `regularCreated`, `regularCheckout`, delivery/products/clientFields).
  **No `recToken` anywhere in the journal.**
- **No documented window cap, pagination, or rate limits** — verified by grepping the raw
  EN/RU/UK doc pages. The oft-repeated "31-day maximum window" appears in no official source.
  Design conservatively: short sliding windows (poll every few minutes with, say, a 1–24h
  overlapping lookback), dedupe on `orderReference` (+ `processingDate` for refund/void state
  changes), client-side rate limiter (03-nfr.md already requires one).
- ~~Refunds/chargebacks appear as state changes on the same orderReference~~ —
  **disproven on live production data** (metatech/analytics recon, 2026-07-05): a refund
  is a **separate journal row** (`transactionType: REFUND`, own `createdDate`, same
  orderReference); the original PURCHASE row's status did not change in 36/36 observed
  refunds. Late refunds are therefore caught by the normal polling window at their own
  date. (`CHECK_STATUS` on the original order does reflect `refundAmount`.)
- `CHECK_STATUS` = per-known-order reconciliation. regularApi `STATUS` = per-subscription
  lifecycle (`Active, Suspended, Created, Removed, Confirmed, Completed` + `mode, dateBegin,
  dateEnd, nextPaymentDate, lastPayedDate, lastPayedStatus`) — only the most recent charge is
  exposed, so it supplements but cannot replace the journal.
- Freshness metric: track `max(processingDate)` seen per poll and lag vs wall clock;
  migration-tail metric: count of legacy recurrents whose regularApi STATUS is still Active.

## Answers to docs/04 open questions

| Question | Answer |
|---|---|
| Exact WFP recurring API methods? | `STATUS`, `SUSPEND`, `RESUME`, `REMOVE`, `CHANGE` on `https://api.wayforpay.com/regularApi` (merchantPassword auth). CHANGE edits amount/frequency/dateNext/dateEnd. |
| Recurring token cancellation via API? | The **schedule** can be cancelled (`REMOVE`) and modified via API. Revoking a `recToken` itself is not documented. |
| Callbacks for recurring successful charges? | **Undocumented.** Not confirmed either way for WFP-initiated charges. For our 500+ legacy recurrents the callback URL can't be repointed anyway — poller remains the detection mechanism (via TRANSACTION_LIST + regularApi STATUS `lastPayedDate/lastPayedStatus`). |
| Callbacks for recurring failed charges? | **Undocumented**, same as above. |
| Idempotency keys? | No header/key mechanism. `orderReference` uniqueness is the API-level dedup (duplicate → reasonCode 1112, unverified). Callback side: at-least-once for 4 days → dedupe on `orderReference`. |

## Statuses & error codes

Transaction statuses seen in official docs: `Approved, Declined, InProcessing,
WaitingAuthComplete, Refunded, Voided` (+ `Pending`/`Expired` referenced in status docs).

reasonCode catalog lives at wiki page **852131** ("Codes of responses"), ~40–50 codes in the
1100s/4100s/5100 ranges. Extracted but **unverified** (verification was cut short in run 1;
confirm against the page before encoding a retry matrix):
`1100` Ok · `1101` Declined to card issuer · `1104` Insufficient funds (retryable) ·
`1112` Duplicate Order ID (dedup signal, not an error to retry) · `1114` Fraud (terminal) ·
`1120` 3DS authentication required (`WaitingAuthComplete`) · `1131` Transaction in processing
(poll, don't retry).

## Test environment (unverified)

Public shared test merchant: `merchantAccount=test_merch_n1`,
`merchantSecretKey=flk3409refn54t54t*FNJRET` (wiki test page). Good for exercising signature
computation and the checkout flow without a live account.

## SDK situation

No official Node.js SDK. Official PHP SDK (github.com/wayforpay/php-sdk, last activity 2025)
is the de-facto reference implementation — its signature field lists match the docs and are
worth porting tests against. Community TS/JS packages exist (wayforpay-ts-integration,
node-wayforpay-library) but are unofficial/thin — **hand-roll the client** inside our
provider adapter (matches the PaymentProvider boundary in 05-domain-model.md).

## Addendum: live probe results (2026-07-12)

A read-only probe against the public test merchant (TRANSACTION_LIST + CHECK_STATUS)
confirmed the signature formulas work and corrected two details above:

- `TRANSACTION_LIST` with **apiVersion 1** already returns `baseAmount`, `baseCurrency`,
  `settlementReference`, `clientName`, `clientPhone`, `clientEmail`, `clientComment`,
  `prroLink`, `prroNumber` — wider than documented. Amounts are string decimals, dates are
  string epoch seconds; `transactionType` includes non-payment ops (`SETTLE`).
  Still no `recToken`.
- **`CHECK_STATUS` trap**: an order just returned by TRANSACTION_LIST answered
  `reasonCode 1127 "Order Not Found"` while also carrying `transactionStatus: "Declined"` —
  branch on `reasonCode` before trusting `transactionStatus`.
- **Correction (2026-07-13 probe): the 31-day window cap is REAL, just undocumented.**
  Spans > 31 days fail with `reasonCode 1109 "Format Error.dateEnd:Period shall not
  exceed 31.041666666667 days"`. The claim above that it "appears in no official source"
  remains true of the documentation — but the server enforces it. Historical windows are
  accepted arbitrarily far back (probed to 2014), so chunked backfill works.
- **Test-account quirk**: the shared test merchant ignores `dateBegin`/`dateEnd` filtering
  entirely (1-day windows in 2014/2020 return the same 2025 transactions). Validate real
  filtering behavior on the production account; clients should filter rows defensively.

Poller design details live in [15-wayforpay-poller-spec.md](15-wayforpay-poller-spec.md).

## Known gaps / follow-ups for WFP support

1. Rate limits for `api.wayforpay.com` — nothing documented; ask support, keep client-side limiter.
2. ~~TRANSACTION_LIST max window~~ (answered empirically: 31 days, rc=1109 beyond) —
   still open: behavior on huge result sets within a window (no pagination documented)
   and journal retention depth.
3. Whether serviceUrl callbacks fire for WFP-initiated regular charges (success and failure).
4. Whether tokenization (`recToken` issuance) needs account-level enablement.
5. WFP legacy retry termination: how many daily retries before a recurrent is suspended.
6. Callback retry schedule within the 4-day window.
