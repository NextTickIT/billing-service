# 22 — Scenario-specific payment events (initial vs. recurring)

Splits the single `payment_succeeded` event into scenario-specific variants and adds a
first-payment failure event, so an external sink (SendPulse) can run a **different flow**
per scenario. Supersedes the single-event vocabulary in [07](07-events.md) §Event
vocabulary; the envelope, storage, delivery SLA, and `externalUserId`-verbatim rule are
unchanged.

## Why

`payment_succeeded` fired for **both** a customer's first checkout payment and every
automated renewal, so a sink could not tell "welcome / first payment" from "renewed".
And a **declined first payment** produced no dedicated event — it fell through the
matcher (which only matched `succeeded`) and was quarantined as
`unknown_payment_quarantined`, which is wrong: a decline on a session **we know** is not
an unknown payment. These are genuinely different customer-facing scenarios that need
different messaging.

## Vocabulary change

Removed: `payment_succeeded`.

Added:

| Event | Fires when | Discriminator |
|-------|------------|---------------|
| `initial_payment_succeeded` | first checkout payment approved | match kind `checkout` |
| `recurring_payment_succeeded` | a renewal charge approved (and an operator-bound quarantine) | match kind `recurring` |
| `initial_payment_failed` | first checkout payment **declined** for a known session | match kind `checkout` + charge status `failed` |

Unchanged: `charge_retry_failed`, `renewal_failed` (the **recurring** failure ladder),
`payment_created`, `payment_cancelled`, `unknown_payment_quarantined`.

The two success variants carry the **same** payload (`amount, currency, method, period,
source`); `initial_payment_failed` adds `reason` (the provider decline text/code).

## Where it hooks (single-point split)

Every success already funnels through one builder in `charge/domain.ts`, and the
`Match` carries `kind: 'checkout' | 'recurring'` (`charge/contracts.ts`). So:

- **Success split** is a branch on `match.kind` at the emit point — no new plumbing.
  The recurring scheduler feeds its approved charge back through the *same* pipeline as
  an incoming event (`billing/events.ts` → `ingest`), so it naturally resolves to
  `kind: 'recurring'` → `recurring_payment_succeeded`.
- **Initial failure**: the checkout matcher now also matches a `failed` charge for a
  known session (previously only `succeeded`), and `process()` branches on status —
  a matched non-success emits `initial_payment_failed` and returns **without** recording
  a payment or quarantining. Intermediate statuses (`pending`, `refunded`) and unknown
  refs still fall through to quarantine, unchanged. Recurring failures never enter the
  pipeline (the scheduler emits their events directly), so a matched non-success is
  always a checkout decline.

## Decisions

- **Recurring failure stays a two-event ladder.** `charge_retry_failed` (per attempt,
  days 0/1/3/5/7) then `renewal_failed` (terminal) already model the recurring dunning
  path with finer granularity than a single event would; a sink maps each to its own
  flow. No `recurring_payment_failed` is added.
- **Initial failure has no retry ladder.** Recovery is the **customer re-initiating a new
  checkout**, not an automated schedule — so `initial_payment_failed` is a single
  terminal signal. The declined session is left open (not marked completed/expired), so
  the same link can be retried; a fresh checkout also works.
- **A declined *known* session emits the fail event instead of quarantining.** Unknown
  refs still quarantine (`unknown_payment_quarantined`); a decline we can attribute to a
  session is a first-payment failure, not an unknown payment.
- **Operator-bound quarantine → `recurring_payment_succeeded`.** A bind reconciles a
  previously-unknown (usually legacy/migration-tail) payment; mapping it to the "welcome"
  initial flow would mis-message an existing customer, so it maps to the renewal variant.
- **Feasibility.** WayForPay's serviceUrl callback fires on a real *Declined*, so
  `initial_payment_failed` covers actual declines. Pure abandonment (the customer never
  submits a card) sends no callback and stays silent — by design.

## Impact / migration

- Shared source of truth: `packages/shared/src/schemas/event.ts` (`EVENT_NAMES`, the three
  new structs, `DomainEvent` union).
- Backend: `charge/domain.ts` (builders + `process()` branch), `checkout/domain.ts`
  (matcher accepts a declined known session), `billing/events.ts` (comment).
- Frontend: the operator Sinks page maps flows per event; the picker derives its list from
  `EVENT_NAMES`, so the three new names appear automatically. i18n labels added for
  `initial_payment_succeeded` / `recurring_payment_succeeded` / `initial_payment_failed`
  (en/ru/uk); the old `payment_succeeded` label removed.
- No data migration: the prod sink ships with an empty flow map, so no stored
  `flows.payment_succeeded` key needs rewriting; the operator maps the new events once.
- The outbox is name-agnostic (fans out by sink, delivers the stored event), so delivery,
  idempotency, and the 60 s SLA are untouched.

## Acceptance

- A first checkout success emits `payment_created` + `initial_payment_succeeded`.
- A renewal charge success emits `recurring_payment_succeeded` (no `payment_created`).
- A declined first checkout for a known session emits `initial_payment_failed`, records
  no payment, and does not quarantine.
- The recurring ladder still emits `charge_retry_failed` then `renewal_failed`.
- Covered by `charge/test/domain.test.ts`, `checkout/test/matcher.test.ts`, and the
  `charge/test/pipeline.e2e.ts` scenarios.
