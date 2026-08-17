# 25 — Legacy Payment Import

Import the payment history of users who are charged through **SendPulse's own
WayForPay integration** so the gateway holds their **Payment** record and
**Charge** history in one place, marks them **`external`** (non-billable — the
gateway must never charge a user already charged outside our merchant), and
**does not echo their events back to the SendPulse sink** they came from.
Migration to gateway-managed billing happens only when the user re-enters their
card through **checkout** (recurring tokens are not exportable — [04](04-open-questions.md) §Data).
Terminology and boundaries follow [01](01-scope.md), [05](05-domain-model.md),
[07](07-events.md); engineering conventions per [16](16-conventions.md).

## 1. Motivation and context

The gateway owns the billing cycle for **our** WayForPay merchant. Historically —
and still, during migration — a population of users is charged through
**SendPulse's** WayForPay integration, which is a **separate merchant** from ours.
Those charges run outside this service. We are migrating off SendPulse and need to:

- hold every such user's payment history here, keyed by `externalUserId` (the
  SendPulse `contact_id`), visible through the read/operator API ([06](06-api.md));
- guarantee the gateway never auto-charges a user already charged on SendPulse's
  merchant (no double billing);
- never deliver domain events for these imported records to the SendPulse sink —
  SendPulse is their source;
- let a user migrate to gateway-managed billing only through a fresh checkout
  (their card, re-entered), because W4P recurring tokens are not exportable
  ([04](04-open-questions.md)).

Non-goals stay as in [01](01-scope.md): no identity resolution (opaque
`externalUserId` only), no `paid_till` / access lifecycle (owned by the external
system), no token migration.

## 2. What "legacy" means on the real model

There is exactly **one** billable merchant in the system today: WayForPay config
is single-merchant and charges carry no merchant field. So `managed` vs `external`
is drawn by **data source**, not by a merchant column:

| Class      | Lives on                       | How it enters here                                                              | Billable by us |
| ---------- | ------------------------------ | ------------------------------------------------------------------------------- | -------------- |
| `managed`  | our WayForPay merchant         | checkout Purchase + callback, and the WayForPay poller (`charges.source` `wayforpay_callback` / `wayforpay_poller`) | yes            |
| `external` | SendPulse's WayForPay integration | **legacy import** from SendPulse CRM (`charges.source` `sendpulse_legacy`)     | **no**         |

Only SendPulse CRM carries the `contact_id` that maps a legacy charge to our
`externalUserId`; a raw WayForPay `TRANSACTION_LIST` row does not (it has
order/email/phone, not the contact id). So legacy import reads **SendPulse CRM
payments** (which carry `contactId`, amount, currency, method, order id, status,
timestamp), not a second WayForPay merchant journal.

## 3. Model additions

### 3.1 `Payment.origin`

Add `origin` to the `Payment` entity (`packages/shared/src/schemas/payment.ts`):

- `PaymentOrigin { Managed = 0, External = 1 }` — a numeric enum owned by the
  `payment` entity slice ([16](16-conventions.md) §6).
- `Managed` (default) — created through checkout; billable; the existing lifecycle
  applies unchanged.
- `External` — created by legacy import; never billable; `recurringTokenRef` is
  always `null`.

An `external` Payment is a **read-only handle on a recurrent payment that lives on
SendPulse's merchant**. It is not `paid_till` and not an access record
([01](01-scope.md)); it is the gateway's record that this user pays elsewhere.

### 3.2 `charges.source`

Add `sendpulse_legacy` to the `charges.source` vocabulary (today
`wayforpay_callback` | `wayforpay_poller`). A legacy charge carries
`externalUserId = sendpulse:{contactId}`, `source = sendpulse_legacy`, the
SendPulse payment as its opaque `payload`, and a stable `idemKey` derived from the
SendPulse payment id.

### 3.3 No token, no paid_till

External Payments never hold a token (`recurringTokenRef IS NULL`) and never carry
`paid_till`. Both are structurally consistent with the current schema: token-less
Payments are already skipped by the scheduler, and `paid_till` is out of scope.

## 4. Behaviour

### 4.1 Import

A worker command ingests SendPulse CRM payments and, per `contactId`:

- upserts one `external` **Payment** (`origin=External`, `recurringTokenRef=null`,
  with `amount` / `currency` / `method` / `period` from the SendPulse data),
  respecting the existing one-active-per-user constraint;
- records each SendPulse payment as a `Charge` (`source=sendpulse_legacy`) fixed to
  that Payment (a `ChargeFixation`);
- is idempotent and re-runnable (dedup by `idemKey` = SendPulse payment id;
  re-import updates, never duplicates).

Money is stored in integer minor units; timestamps are UTC.

### 4.2 Non-billable guarantees (external)

Because an external Payment has no token, the **scheduler already skips it**
(`findDue` filters `recurringTokenRef IS NOT NULL`) — no new guard is needed for
auto-charge. In addition:

- the operator **cancel** action (`POST /operator/payment/:id/cancel`) returns
  `409` for `origin=External` — we cannot cancel a charge that runs on SendPulse's
  merchant;
- `reactivate` and `defer` likewise `409` for external (nothing here to
  reactivate/extend);
- external Payments never enter a retry ladder.

### 4.3 Single active across both worlds

The existing partial-unique constraint
`payments_one_active_per_user (externalUserId) WHERE status = Active` already
enforces **one active recurrent payment per user across `managed` and `external`**:
an active external Payment occupies the slot, blocking a second active managed one.
This is exactly the product invariant — no concurrent double billing.

### 4.4 Migration / takeover and overlap

A user migrates to gateway-managed billing only by completing a **checkout**
(re-entering their card), since tokens are not exportable. When a checkout succeeds
for a user who has an active `external` Payment:

- the external Payment is **superseded** — moved to `Cancelled` with reason
  `migrated`, freeing the active slot — and the new `managed` Payment is created by
  the existing `createOrExtend` applier, in the same transaction (so the unique
  constraint is never violated);
- because SendPulse's merchant may still charge the user for a short window (their
  recurring lives outside us and we cannot cancel it), the supersession raises a
  **support notification** (operator console / audit — **not** a SendPulse event)
  so a human confirms the SendPulse-side charge is stopped;
- if the two ever appear concurrently through import lag, the same overlap signal is
  raised for operator reconciliation, reusing the quarantine/operator surface
  ([06](06-api.md)).

### 4.5 Events and the SendPulse sink

Legacy import writes Payment and Charge **history**; it does not replay the
historical domain-event stream. Any event that a future external-Payment action
does produce is recorded in the outbox for audit, but its delivery to the
**SendPulse sink is suppressed** — SendPulse is the source of these records and must
not receive echoes. The sink filters only by event name today
([21](21-sinks-module-plan.md)), so this adds an origin guard to the SendPulse
connector: an event whose origin is `external` is a no-op delivery (marked
delivered, no HTTP call), exactly like the existing `externalUserId === null` skip.
Other and future sinks are unaffected.

## 5. API surface (deltas)

- `GET /api/payment?externalUserId=...` and `GET /operator/payment?...` return
  `origin` so callers can tell external records apart.
- `POST /operator/payment/:id/{cancel,reactivate,defer}` → `409` for
  `origin=External`.
- `POST /api/payment/card-change` and `POST /api/checkout-sessions` stay available
  for external users — they are the migration path.
- A new worker command (no public HTTP) runs the import.

## 6. Acceptance criteria

- [ ] AC-1 Import creates one `external` Payment per SendPulse `contactId`, with
      `origin=External` and `recurringTokenRef=null`.
- [ ] AC-2 Each SendPulse payment becomes a `Charge` (`source=sendpulse_legacy`) +
      `ChargeFixation` on that Payment; money in minor units, timestamps UTC.
- [ ] AC-3 Import is idempotent: re-running does not duplicate Charges or Payments
      (dedup by SendPulse payment id).
- [ ] AC-4 The scheduler never selects an external Payment (token-less ⇒ already
      filtered; asserted explicitly).
- [ ] AC-5 `cancel` / `reactivate` / `defer` on an external Payment return `409`.
- [ ] AC-6 At most one active Payment per `externalUserId` across managed + external
      (constraint holds).
- [ ] AC-7 A successful checkout for a user with an active external Payment
      supersedes it (`Cancelled`, reason `migrated`), creates the managed Payment in
      the same transaction, and raises the operator overlap notification.
- [ ] AC-8 No event tied to an external Payment is delivered to the SendPulse sink;
      the outbox still records it.
- [ ] AC-9 `externalUserId` is carried verbatim (`sendpulse:{contactId}`) end to end.

## 7. Open questions

- (OQ-1) External Payment **status**: does an imported external Payment sit at
  `Active` (occupying the single-active slot) until superseded, or a value derived
  from SendPulse payment recency? What re-import cadence keeps it fresh?
- (OQ-2) SendPulse CRM export: which exact endpoint/fields are authorized
  ([04](04-open-questions.md) "what fields can be exported from SendPulse" is open)?
  Is `/crm/v1/payments/all` the agreed source?
- (OQ-3) `period` for an external Payment — inferred from SendPulse cadence or a
  fixed default?
- (OQ-4) Overlap-notification transport — a new operator-only event name, an audit
  row, or the existing quarantine surface?
- (OQ-5) Multiple products per user ([04](04-open-questions.md) §11.5, open) — does
  one active external Payment per user hold when a user has several SendPulse
  products?
- (OQ-6) Does legacy import emit any sink-facing events at all, or only
  Payment/Charge history with zero outgoing events?

## 8. Out of scope

- Charging, retrying, or cancelling on SendPulse's merchant.
- Importing `paid_till` or access state (owned externally — [01](01-scope.md)).
- Migrating W4P recurring tokens ([04](04-open-questions.md)).
- Two-way sync back to SendPulse; SendPulse CRM / bot / analytics replacement.
