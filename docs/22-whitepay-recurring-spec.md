# WhitePay recurring payments spec (planner input)

> Status: decision-locked with the user (2026-07-22), ready for planning. Grounded in
> [17-whitepay-research.md](17-whitepay-research.md). Nothing here is committed as code yet.
>
> **Why this spec exists:** WhitePay has **no reusable token** (see 17 — the make-or-break
> finding). So recurring billing cannot be an unattended server-side charge like WayForPay's
> `recToken` CHARGE. Instead, each due date **prompts the user to pay a freshly-minted checkout
> link**. This spec defines that flow so it rides the same outbox→sink + matching pipeline the
> gateway already uses.

## Decisions locked (with the user)

| # | Decision | Resolution |
|---|----------|-----------|
| D1 | Domain shape | **No subscription entity.** A recurring **Payment** carries scheduled attempt dates (the same retry schedule as card recurring). |
| D2 | When to prompt | **On the due date** (no early pre-notification / no grace period — there is no subscription to keep alive). |
| D3 | When to create the WhitePay order | **On click, on demand.** The outbound event carries **our** link; the real WhitePay checkout is minted only when the user presses "Pay". |
| D4 | On exhaustion | After the **last** scheduled attempt lapses → mark Payment **FAILED** + fire an outgoing `payment.failed` event. **No suspend, no downgrade.** |
| D5 | Payment window | A user may take **up to ~48h** to pay after being prompted; that is one attempt's live window. |

## Model

Two levels of state:

```
Payment (the recurring payable)
  DUE ──any attempt paid──► PAID
      ──all attempts lapsed──► FAILED

Attempt (one scheduled try, on its due date)
  SCHEDULED ──fire "pay now" event──► NOTIFIED
  NOTIFIED  ──user clicks, order minted──► AWAITING_PAYMENT (fresh acquiring_url)
  AWAITING_PAYMENT ──webhook order::completed──► (Payment → PAID)
                   ──~48h window elapses, no COMPLETE──► LAPSED ──► next attempt
```

- A **Payment** is `DUE` until either any attempt is paid (`PAID`) or every scheduled attempt
  lapses (`FAILED`).
- Each **Attempt** maps to one **Charge** (the incoming-payment fact). `external_order_id` on
  the WhitePay order = the **charge id** (deterministic per attempt).

## Flow — one attempt

1. **Due date reached** → the scheduler emits a `payment.due` (“pay now”) domain event into the
   outbox. The sink delivers it to the user (email / messenger / in-app) with a button that
   points at **our** on-click endpoint (not a WhitePay URL).
2. **User presses "Pay"** → our on-click endpoint creates a **fresh** WhitePay crypto order
   (`POST …/private-api/crypto-orders/{slug}`, Bearer auth) with `external_order_id = chargeId`,
   receives `order.acquiring_url`, records the `order.id ↔ chargeId` mapping, and **302-redirects**
   the user to `acquiring_url`. Minting here (not at step 1) means every link carries a fresh
   rate-lock and fresh TTL — the ~2-min crypto rate lock and unknown link expiry never bite.
3. **User pays** → WhitePay POSTs a webhook (`order::completed`, status `COMPLETE`). We verify
   the HMAC, match `external_order_id → charge → Payment`, set **Payment = PAID**, and **cancel
   the remaining scheduled attempts**.
4. **No payment within the ~48h window** (or WhitePay `DECLINED`/expired) → the attempt is
   **LAPSED**; the next scheduled attempt date will fire a new `payment.due` event.
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
| `payment.due` (“pay now”) | `paymentId`, `chargeId`, `attemptNumber`, `amount` (minor units), `currency`, `payUrl` (our on-click link), `dueDate`, `windowExpiresAt` (dueDate + ~48h) |
| `payment.paid` | `paymentId`, `chargeId`, `amount`, `paidAt`, `providerOrderId`, `receivedTotal` |
| `payment.failed` | `paymentId`, `amount`, `attemptsMade`, `lastAttemptAt`, `reason` |

## Inbound webhook (from WhitePay) — contract in [17](17-whitepay-research.md)

- HMAC-SHA256 over the **raw body** with the per-page **Webhook Token**, in the `Signature`
  header, strict `===` (also accept the `X-Secret-Key` shared-secret mode defensively).
- Match `order.external_order_id (= chargeId)` → charge → Payment. Statuses:
  `COMPLETE → paid`, `DECLINED/CANCELED → attempt failed`, `PARTIALLY_FULFILLED → underpaid`
  (treat as not-yet-paid; reconcile).
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
| One attempt = | server-side `CHARGE` with `recToken` (immediate success/fail, unattended) | **fire `payment.due` event + await webhook (≤48h)** — user pays a freshly-minted link |

## Open questions for WhitePay (confirm at onboarding — none block this design)

1. **Order / `acquiring_url` TTL, and when the rate locks** (at creation vs when the user opens
   the page). On-click minting is safe regardless; this only decides whether we *could* also
   embed links directly.
2. **`external_order_id` reuse** — must it be unique per order, or can attempts reuse it? Drives
   charge-id-per-attempt vs an order-suffix scheme.
3. **Does WhitePay push a webhook on expiry/decline, or only on `COMPLETE`?** If only `COMPLETE`,
   our ≤48h timer is the sole lapse signal.
