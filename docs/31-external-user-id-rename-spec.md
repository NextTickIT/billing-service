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
Request : { "from": "<oldId>", "to": "<newId>", "reason"?: "<text>" }
Response: { "from", "to", "movedPayments": <n>, "movedSessions": <n> }   (200)
```

Errors (typed, each with `toHttp`):

- `422 UnprocessableEntity` — `from`/`to` empty, or `from === to` (a no-op).
- `409 Conflict` — both ids already hold an **active recurring payment**; the remap would
  collide on the one-active-recurring-per-user index. Surfaced from the SQLSTATE 23505
  via the generic `onUniqueViolation` mapper (`infra/db/pg-errors`).
- `404 NotFound` — no live record matched `from` (nothing to remap).

## 4. Semantics (docs, `modules/identity`)

The whole operation runs in **one transaction** (`sql.withTransaction`), so a conflict or
an empty match rolls back cleanly with nothing moved and no ledger row:

1. Validate `from`/`to` (non-empty, distinct) — carried **verbatim**, never trimmed.
2. `payments.renameExternalUser(from, to)` → moved count; a 23505 unique violation maps
   to `Conflict`.
3. `checkout.renameOpenSessionsExternalUser(from, to)` → moved count (created/pending).
4. If nothing moved → `NotFound` (transaction rolls back).
5. Append one `external_user_id_changes` row with the from/to, source (`service`),
   reason, and the two counts.
6. Return the counts.

Module layout mirrors `auth` (a new module = a new capability, AC8 spirit):

- `identity/data-access.ts` — the ledger repo (`append`).
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
- Merging two users that both hold an active recurring payment (currently a 409).
