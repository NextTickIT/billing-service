# 31 — External-user-id rename (with change history)

Spec for a specific action that remaps a user's opaque `externalUserId`, keeping a full
append-only history of every change. Prescriptive; cites the invariants it upholds.

## 1. Motivation

`externalUserId` is opaque and carried verbatim (docs/00 §2, AC9) — the gateway never
transforms it and never matches identity by email/phone. But the external system
(SendPulse) may **reissue** a user's id (account merge/migration). We need a deliberate
action to point the user's billing records at the new id, going forward, **without**
losing the record of the change.

This is an explicit, recorded remap — not automatic identity matching — so AC9 holds.

## 2. Trigger & scope (chosen)

- **Trigger:** a **service-token** endpoint, the same surface SendPulse already uses for
  card-change (identity originates there). No operator UI.
- **Scope:** remap the **live** billing records; keep the raw journal immutable; record
  every change in a dedicated append-only ledger.

  | records                        | on rename                          |
  | ------------------------------ | ---------------------------------- |
  | `payments` (all of the user's) | → new id (live billing entity)     |
  | `checkout_sessions` (open)     | → new id (created/pending only)    |
  | `incoming_payment_events`      | unchanged (raw fact, AC3)          |
  | `domain_events` (outbox)       | unchanged (raw fact, AC3)          |
  | `external_user_id_changes`     | append `{from,to,source,reason,…}` |

Past emitted events and raw charges keep their original id — they are immutable facts;
the ledger is the link between a user's old and new ids. Completed/expired checkout
sessions are historical and also keep their original id; only in-flight (created/pending)
sessions move, so a payment mid-checkout completes under the new id.

## 3. API

`POST /api/payment/rename-external-user` (service token; same auth as card-change, no BFF
secret — the service calls directly).

```
Request : { "from": "<oldId>", "to": "<newId>", "reason"?: "<text>", "refireEvents"?: false }
Response: { "from", "to", "movedPayments": <n>, "movedSessions": <n> }   (200)
```

Errors (typed, each with `toHttp`):

- `422 UnprocessableEntity` — `from`/`to` empty, or `from === to` (a no-op).
- `409 Conflict` — the **target id is already in use** (`to` already owns any payment). A
  rename targets an UNUSED id, so an occupied target is refused rather than merged — this
  prevents silently stacking two recurring payments under one user (the unique index only
  catches the active+active case, not active+past_due, so it can't be the sole guard). A
  concurrent active-recurring collision is still caught as a backstop by the SQLSTATE
  23505 → `onUniqueViolation` mapper (`infra/db/pg-errors`).
- `404 NotFound` — `from` owns no live record and no prior remap is on record (nothing
  to do). A repeated identical rename is **not** a 404 — see idempotency below.

**Idempotent retry.** The service call is safe to retry: if `from` owns no payment yet an
identical `from` → `to` remap is already recorded in the ledger, the earlier call ran and
emptied `from`, so the retry replays that recorded result (200, same counts) instead of a
404. If `from` still owns payments it is a fresh rename (e.g. after a reverse), so the
move proceeds normally.

**Events are opt-in (`refireEvents`, default `false`).** By default the rename is
**silent** — a pure remap + ledger, no events — so a sink is not re-notified. Set
`refireEvents: true` to emit a **single** `external_user_id_changed` event (payload
`{from, to, movedPayments, movedSessions}`, envelope `externalUserId` = the **new** id).
Payment success events are **never** re-emitted (no double-grant). The route enqueues an
`external_user_id_change` queue message inside the rename transaction (so the notify is
atomic with the remap); the worker's handler publishes the domain event via the outbox,
exactly like the payment lifecycle notifies (docs/23). A deterministic idemKey +
event id dedupe a retried rename, so the event fires at most once.

## 4. Semantics (docs, `modules/identity`)

The whole operation runs in **one transaction** (`sql.withTransaction`), so a conflict or
an empty match rolls back cleanly with nothing moved and no ledger row:

1. Validate `from`/`to` (non-empty, distinct) — carried **verbatim**, never trimmed.
2. Idempotent replay: if `from` owns no payment and an identical `from` → `to` remap is on
   record (`ledger.findLatestChange`), return that recorded result — a retried call is safe.
3. Refuse if `to` already owns any payment (`findByExternalUser(to)` non-empty) →
   `Conflict`. A rename targets an unused id; an occupied target is a merge, not a rename.
4. `payments.renameExternalUser(from, to)` → moved count; a 23505 unique violation maps
   to `Conflict` (backstop for the concurrent case).
5. `checkout.renameOpenSessionsExternalUser(from, to)` → moved count (created/pending).
6. If nothing moved → `NotFound` (transaction rolls back).
7. Append one `external_user_id_changes` row with the from/to, source (`service`),
   reason, and the two counts.
8. Return the counts.

Module layout mirrors `auth` (a new module = a new capability, AC8 spirit):

- `identity/data-access.ts` — the ledger repo (`append`, `findLatestChange`).
- `identity/domain.ts` — `renameExternalUser(deps)(cmd, source)`; composes the two
  cross-module repos (`PaymentRepo`, `CheckoutRepo`) + the ledger. Plain functions, no
  new service tag.
- `identity/routes.ts` — the service-token route; wraps the domain in the transaction.
- `PaymentRepo.renameExternalUser` / `CheckoutRepo.renameOpenSessionsExternalUser` — each
  module owns writes to its own table.

### Migration 0015

`external_user_id_changes` (append-only): `id`, `fromExternalUserId`, `toExternalUserId`,
`source`, `reason`, `movedPayments`, `movedSessions`, `occurredAt`; indexed on both
`from` and `to` so the chain of a user's ids is traceable either direction.

## 5. Interactions & acceptance

- **One active recurring per user** (docs/18/30) — preserved: the DB index is the guard;
  a rename that would create a second active recurring payment for `to` is refused (409),
  never silently merged.
- **One-time payments** (docs/30) — all of a user's one-time payments carry `from` and
  move to `to` with the rest; they never conflict (the index is recurring-only).
- **AC3** — the raw journal (incoming events, emitted domain events) is never rewritten;
  the ledger is the change history.
- **AC9** — `externalUserId` is carried verbatim; only the owning id changes, by explicit
  action, recorded.

## 6. Deferred / not in scope

- A read endpoint / operator console view of the history (the ledger is written; exposing
  it is a follow-up).
- Emitting an `external_user_id_changed` domain event to sinks — unnecessary while the
  service that owns identity is the initiator.
- Merging two users with billing history: any rename onto an occupied `to` is a 409 (a
  rename targets an unused id). A real merge is a separate, out-of-scope operation.
