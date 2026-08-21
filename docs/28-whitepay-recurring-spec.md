# WhitePay recurring payments spec (planner input)

> Status: decision-locked with the user (2026-07-22), extended 2026-07-23. Ready for planning.
> Grounded in [27-whitepay-research.md](27-whitepay-research.md) and
> [29-whitepay-checkout-selection-research.md](29-whitepay-checkout-selection-research.md).
> Nothing here is committed as code yet.
>
> **Why this spec exists:** WhitePay has **no reusable token** (see 17 — the make-or-break
> finding). So recurring billing cannot be an unattended server-side charge like WayForPay's
> `recToken` CHARGE. Instead, each due date **prompts the user to pay a freshly-minted checkout
> link**. This spec defines that flow so it rides the same outbox→sink + matching pipeline the
> gateway already uses.
>
> **2026-07-23 extension (grounded in doc 23):** confirmed that on WhitePay's hosted checkout the
> **payer** selects the coin **and** network (the create-order call is **fiat-denominated only** —
> we neither collect nor pass a coin/network), and generalized the recurring trigger into one
> **provider-agnostic charge function** (autocharge if a usable token exists, else fire a
> `payment.manual_required` prompt). See decisions D6–D12 and "Provider-agnostic recurring charge".

## Decisions locked (with the user)

| # | Decision | Resolution |
|---|----------|-----------|
| D1 | Domain shape | **No subscription entity.** A recurring **Payment** carries scheduled attempt dates (the same retry schedule as card recurring). |
| D2 | When to prompt | **On the due date** (no early pre-notification / no grace period — there is no subscription to keep alive). |
| D3 | When to create the WhitePay order | **On click, on demand.** The outbound event carries **our** link; the real WhitePay checkout is minted only when the user presses "Pay". |
| D4 | On exhaustion | After the **last** scheduled attempt lapses → mark Payment **FAILED** + fire an outgoing `payment.failed` event. **No suspend, no downgrade.** |
| D5 | Payment window | A user may take **up to ~48h** to pay after being prompted; that is one attempt's live window. Held by **our own checkout session** (below), *not* by the WhitePay order — the WhitePay order is minted on click and lives only ~2 min of rate lock. |
| D6 | Who picks coin/network | **The payer, on WhitePay's hosted page** (confirmed, doc 23). Our create-order call is **fiat-denominated** (`{amount, currency=FIAT, external_order_id}`). We do **not** collect or pass coin/network, and cannot pre-force one (that only existed on a deprecated endpoint). "Preselect crypto" therefore means only **"route this session to the WhitePay provider,"** not a coin/network choice. |
| D7 | Recurring trigger is provider-agnostic | One `attemptCharge(payment)` on the provider boundary. The predicate is **per-payment, not per-provider**: `hasUsableToken(payment)` → **autocharge** (server-side, WayForPay `recToken`); else → fire a **`payment.manual_required`** event (prompt-to-pay). WhitePay is always the `else` branch. |
| D8 | "Default to previous method" is provider-level | Because the payer re-picks coin/network on WhitePay every cycle and we can only reliably record the coin (not the chain, doc 23 Q4), "default to previous method" means **defaulting the provider/method** (WayForPay-card vs WhitePay-crypto), **changeable** by the user — *not* a coin/network default within WhitePay. |
| D9 | Autocharge decline → **retry on schedule** | When a usable token *is* present and the server-side autocharge **declines**, we **retry on the existing recurring schedule** — we do **not** fire a same-cycle `payment.manual_required` fallback. (Locked 2026-07-23.) |
| D10 | Event name | The prompt-to-pay event is **`payment.manual_required`** (renamed from the earlier `payment.due` / "pay now"). **One** event only. (Locked 2026-07-23.) |
| D11 | Manual session is multi-provider; card pay captures the token (graduation) | The 48h session supports **both** provider checkouts. If the user switches to **card**, it runs as a one-time **WayForPay** checkout that **captures a `recToken`** → the existing **`RecurringToken`** (doc 05) flips `missing → active`, so the **next** cycle autocharges. The branch is decided purely from the **latest payment's token state** (D7/Q2), so graduation needs no extra mechanism. (Locked 2026-07-23.) |
| D12 | `payment.manual_required` is recurring-only | The **initial** payment is always a manual checkout already, so we do **not** fire `payment.manual_required` for it — the event fires only for **recurring** attempts (2nd cycle onward). (Locked 2026-07-23.) |

## Model

Two levels of state:

```
Payment (the recurring payable)
  DUE ──any attempt paid──► PAID
      ──all attempts lapsed──► FAILED

Attempt (one scheduled try, on its due date)
  SCHEDULED ──fire payment.manual_required event──► NOTIFIED
  NOTIFIED  ──user clicks, order minted──► AWAITING_PAYMENT (fresh acquiring_url)
  AWAITING_PAYMENT ──webhook order::completed──► (Payment → PAID)
                   ──~48h window elapses, no COMPLETE──► LAPSED ──► next attempt
```

- A **Payment** is `DUE` until either any attempt is paid (`PAID`) or every scheduled attempt
  lapses (`FAILED`).
- Each **Attempt** maps to one **Charge** (the incoming-payment fact). `external_order_id` on
  the WhitePay order = the **charge id** (deterministic per attempt).

## Flow — one attempt

1. **Due date reached** → the scheduler runs `attemptCharge` (D7); on the manual branch it emits a
   `payment.manual_required` domain event into the outbox. The sink delivers it to the user
   (email / messenger / in-app) with a button that points at **our** on-click endpoint (not a
   WhitePay URL).
2. **User presses "Pay"** → our on-click endpoint creates a **fresh** WhitePay crypto order
   (`POST …/private-api/crypto-orders/{slug}`, Bearer auth) with `external_order_id = chargeId`,
   receives `order.acquiring_url`, records the `order.id ↔ chargeId` mapping, and **302-redirects**
   the user to `acquiring_url`. Minting here (not at step 1) means every link carries a fresh
   rate-lock and fresh TTL — the ~2-min crypto rate lock and unknown link expiry never bite.
3. **User pays** → WhitePay POSTs a webhook (`order::completed`, status `COMPLETE`). We verify
   the HMAC, match `external_order_id → charge → Payment`, set **Payment = PAID**, and **cancel
   the remaining scheduled attempts**.
4. **No payment within the ~48h window** (or WhitePay `DECLINED`/expired) → the attempt is
   **LAPSED**; the next scheduled attempt date will fire a new `payment.manual_required` event.
5. **Last scheduled attempt lapses** → **Payment = FAILED** → emit `payment.failed`. Done.

## The on-click mint endpoint

- Public `GET /pay/{attemptToken}` (opaque, unguessable token → resolves to the charge/attempt).
- On hit: create the WhitePay order **now**, persist `order.id ↔ chargeId`, `302 → acquiring_url`.
- **Every click mints a fresh order** (fresh rate/TTL). Multiple live orders for one attempt are
  fine — see idempotency. (Optionally short-circuit to the last still-open order for the same
  attempt to avoid spamming orders; not required for correctness.)

## Event contracts (outbound, outbox → sink)

| Event | Key fields |
|---|---|
| `payment.manual_required` (prompt-to-pay; formerly `payment.due`) | `paymentId`, `chargeId`, `attemptNumber`, `amount` (minor units), `currency`, `payUrl` (our on-click link), `defaultMethod` (last-used provider, changeable), `dueDate`, `windowExpiresAt` (dueDate + ~48h) |
| `payment.paid` | `paymentId`, `chargeId`, `amount`, `paidAt`, `providerOrderId`, `receivedTotal` |
| `payment.failed` | `paymentId`, `amount`, `attemptsMade`, `lastAttemptAt`, `reason` |

## Inbound webhook (from WhitePay) — contract in [17](27-whitepay-research.md)

- HMAC-SHA256 over the **raw body** with the per-page **Webhook Token**, in the `Signature`
  header, strict `===` (also accept the `X-Secret-Key` shared-secret mode defensively).
- Match `order.external_order_id (= chargeId)` → charge → Payment. Statuses:
  `COMPLETE → paid`, `DECLINED/CANCELED → attempt failed`, `PARTIALLY_FULFILLED → underpaid`
  (treat as not-yet-paid; reconcile).
- **Where `PARTIALLY_FULFILLED` comes from (Q4):** only the crypto push model — the payer sends
  **less** than `expected_amount` from their own wallet (wrong amount, network fees, partial/multi-send,
  or rate drift vs the ~2-min quote). It is **not `COMPLETE`**, so the Payment stays `DUE` and the
  attempt lapses normally; but funds *were* received, so raise an **ops/reconcile alert** (top-up or
  refund is a manual decision). **No state-machine branch.** Rare in the hosted flow (amount + QR are
  pre-filled); confirm exact semantics at onboarding.
- Raw-log every callback; ack HTTP 200. Same at-least-once handling as the WayForPay `serviceUrl`
  callback.

## Idempotency & dedup

- **Pay-once wins.** The first `COMPLETE` that resolves to a `DUE` Payment sets it `PAID`. Any
  later `COMPLETE` for the same Payment (e.g. the user opened two attempt links and paid both) is
  a **no-op** and flagged as a **refund candidate + alert** — crypto double-pays are real.
- Incoming dedup key mirrors WayForPay: `order.id | status` (raw-logged, idempotent enqueue).
- `external_order_id = chargeId`, one charge per attempt; multiple charges roll up to one Payment.

## Retry & final failure

- Attempt dates come from the **same recurring schedule as card recurring** (no new schedule).
- An attempt fails when its ~48h window lapses with no `COMPLETE` (or an explicit WhitePay
  decline/expiry, if WhitePay sends one).
- **Overlap is harmless:** a 48h window can outlast the next attempt date, so several attempt
  links may be live at once — pay-once idempotency makes any one of them complete the Payment.
- After the final scheduled attempt → `payment.failed`. No suspension logic.

## Difference from WayForPay recurring — the only swap

Everything else (scheduler, retry schedule, final-failure event, outbox/sink, matching pipeline,
raw-log + idempotency) is shared. The single substitution:

| | WayForPay | WhitePay |
|---|---|---|
| One attempt = | server-side `CHARGE` with `recToken` (immediate success/fail, unattended; decline → retry on schedule, D9) | **fire `payment.manual_required` event + await webhook (≤48h)** — user pays a freshly-minted link |

## Provider-agnostic recurring charge (D7–D12)

The due-date trigger is one function on the `PaymentProvider` boundary ([05-domain-model.md](05-domain-model.md)),
so the scheduler stays source-agnostic:

```
attemptCharge(payment):
  if hasUsableToken(payment):          # per-PAYMENT, not per-provider
      autocharge server-side           # WayForPay recToken CHARGE (existing flow B)
      on decline → retry on schedule   # D9: NO same-cycle manual fallback
  else:
      create our 48h checkout session (method defaulted to last-used provider, changeable)
      emit `payment.manual_required`  # the prompt-to-pay event
```

Truth table:

| Case | `hasUsableToken` | Branch |
|---|---|---|
| WhitePay (any) | always false | **manual** (prompt-to-pay) |
| WayForPay + stored token | true | **autocharge** |
| WayForPay, no token yet (e.g. original payment predates recurring-token capture) | false | **manual** — and it **graduates**: a completed manual WayForPay **card** payment captures a `recToken` → `RecurringToken` `missing → active` (doc 05), so subsequent cycles autocharge |

> **`hasUsableToken(payment)` = the customer's `RecurringToken` (doc 05) is `active`.** WhitePay never
> creates one (always `missing` → always manual). Per D7/Q2, each cycle reads the **latest** token state,
> so a card payment that just captured a token makes the next cycle autocharge with no special
> graduation code. The manual session is **multi-provider** (D11): the user can pay by WhitePay-crypto
> *or* switch to card; a card pay is the graduation trigger.

**Our 48h checkout session (first-class object).** The manual branch creates *our* session (TTL ~48h,
opaque `payUrl`, `method` defaulted to the last-used provider but changeable). The event carries the
session link — so the button is live the instant the user receives it. The **WhitePay order is minted
only when the user clicks Pay** inside the session (D3), keeping the ~2-min WhitePay rate clock always
fresh. Two independent clocks: **our session TTL (48h)** = the attempt window; **WhitePay order TTL
(unknown, ~2-min rate lock minimum)** = starts at click.

> Naming note (locked, D10): `payment.manual_required` is the renamed `payment.due` ("pay now")
> event, repositioned as the `else` branch of `attemptCharge`. It is a **single** event — no second
> overlapping event — to avoid dedup pain.

## Open questions

**Answered by doc 23 (2026-07-23):**
- ~~Who selects coin/network~~ → **the payer**, on WhitePay's page; create-order is fiat-only (D6).
- ~~Can we preselect/default a coin/network~~ → **no** on the live endpoint; "default to previous" is
  provider-level, not coin/network (D8).
- **Rate lock** → ~2 min (120 s), fixed when the payer selects the currency. On-click minting confirmed
  correct.

**Still open for WhitePay (confirm at onboarding — none block this design):**
1. **Order / `acquiring_url` TTL** — the ~2-min figure is only the *rate re-quote* window; the actual
   order lifetime has no known field and needs the authenticated docs or a live test. (Only affects
   whether we *could* also embed links directly; on-click minting is safe regardless.)
2. **`external_order_id` reuse** — must it be unique per order, or can attempts reuse it? Drives
   charge-id-per-attempt vs an order-suffix scheme.
3. **Does WhitePay push a webhook on expiry/decline, or only on `COMPLETE`?** If only `COMPLETE`,
   our ≤48h timer is the sole lapse signal.
4. **Can a merchant restrict the pay-in coin/network menu** shown to payers, or is the full asset list
   always exposed? (401-gated; see doc 23.)

*(Former open Q "autocharge-decline fallback" is now **resolved → D9**: retry on schedule, no
same-cycle manual fallback.)*
