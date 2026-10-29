# 33 — Event contract v2 + CRM sink: deploy pre-flight (B4)

Branch `event-contract-v2-rebase` (replaces PR #6, `event-contract-v2-main`): PR #5
(`wip/event-contract-v2`) replayed onto `main`, plus the CRM envelope (owner decision 1) and
the manual-renewal pin (decision 7), then replayed again onto `main` cdc3836 (checkout
options, migration `0022_checkout_options`). Production still runs 58d80ef, so that main
ships in the same deploy as this branch.
This is the checklist for the deploy that ships it (work package B4). Source: the critic
review of 2026-10-20. The runbook itself lives in `billing-service-deploy`
(`20-deployment.md`); record the deploy there as usual and link this page.

What the image adds to the database: main's `0022_checkout_options`, then this branch's
migrations `0023_event_idempotency_key` (nullable `domain_events."idempotencyKey"`, backfill,
NON-unique index), `0024_metadata_passthrough` (nullable `metadata` on checkout sessions and
payments) and `0025_crm_sink` (sink row `kind = 1`, disabled, empty URL). All three of this
branch's are additive.

## 1. Run on every database before deploying (prod, staging, shared dev)

```sql
SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id;
-- expect 1..22 ending 21 checkout_renewal, 22 checkout_options; nothing else
-- (prod, still on 58d80ef, shows 1..21: there main's 0022 applies in this same boot)
SELECT kind, enabled, config FROM sinks ORDER BY kind;
-- expect 0 (sendpulse) and 2 (email); a pre-existing kind 1 row would survive 0025's DO NOTHING
```

**Migration 0023 rewrites all of `domain_events` at boot.** The server applies migrations
before it starts serving. 0023 backfills `"idempotencyKey"` with one `UPDATE` over every
historical row, then builds a (non-concurrent) index on the column. Both run inside the
boot of the first new server. On a large table that boot takes visibly longer. While the
index builds, inserts into `domain_events` wait, so the old image's event publishing pauses
for that time. Size it before deploying:

```sql
SELECT count(*), pg_size_pretty(pg_total_relation_size('domain_events')) FROM domain_events;
```

Deploy at a quiet hour if the table runs to millions of rows. It is safe to re-run: the
`UPDATE` touches only rows still NULL.

A database that once ran PR #5's OLD numbering (0020–0022 as `event_idempotency_key`,
`metadata_passthrough`, `crm_sink`) fails the boot check `unmatchedApplied`
(`infra/migrator.ts`) with "Applied migrations have no matching file". Prod is very unlikely
to be in that state (it boots 58d80ef, which runs the same check); staging or a shared dev DB
may be. The same goes for a database that ran PR #6's image (`event-contract-v2-main`), where
0022–0024 are `event_idempotency_key`, `metadata_passthrough`, `crm_sink`: here those are
0023–0025 and 22 is `checkout_options`. Fix such a database before deploying to it.

## 2. Rollback to cdc3836 needs a manual step

Main's server boot runs the same `unmatchedApplied` check (`infra/migrator.ts`). After this
deploy the applied rows `23 event_idempotency_key`, `24 metadata_passthrough` and
`25 crm_sink` have no file in image cdc3836 (main with checkout options), so a plain redeploy of that image **refuses to
start** ("Applied migrations have no matching file"). The migrations are additive, so the
rollback removes only their bookkeeping rows, plus the CRM sink row (step 4).

The rollback target is cdc3836, not 58d80ef (what prod ran before this deploy): main's
`22 checkout_options` stays applied and cdc3836 ships its file. Going back further, to
58d80ef, would also need row 22 deleted and is a separate decision about checkout options;
it is not covered here.

**Rollback procedure:**

1. If the CRM sink was ever enabled, drain it **while it is still enabled**. Image cdc3836
   has no CRM connector: a `crm` delivery it picks up is marked failed and its queue message
   succeeds, so nothing alerts and the event never reaches the CRM. Disabling first does not
   help either. A delivery whose sink is disabled cannot be sent, so disabling before the
   drain throws the backlog away (this image dead-letters each one; older images dropped
   them silently). Leave the sink on and wait until this returns 0:

   ```sql
   SELECT count(*) FROM messages m
   JOIN event_deliveries d ON d.id::text = m.payload->>'deliveryId'
   WHERE m."messageType" = 'deliver_event' AND d.sink = 'crm'
     AND m.status IN ('pending', 'in_progress', 'retry');
   ```

   A delivery in `retry` is waiting out its backoff, which is at most a minute. If the count
   does not fall, the CRM is failing: fix that first, or accept the loss and go on to the
   next step, which records what is owed.

2. Disable the CRM sink (console → Sinks → CRM → off) and **record the disable time (UTC)
   in the deploy log**. Soon after, no event gets a CRM delivery at all: publish fans out
   only to enabled sinks. That covers the rest of this image's life and everything cdc3836
   publishes until a roll-forward re-enables the sink. Those events have no
   `sink = 'crm'` row, so no query over `event_deliveries` can list them. The B5 backfill
   must re-post every event whose **`domain_events."createdAt"`** (when billing stored it)
   is at or after the recorded disable time, up to the moment the sink is enabled again.
   Select by `createdAt`, never by `"occurredAt"`, which is the provider's time. A
   quarantine an operator binds later, or a charge the poller catches up on, is published
   inside the window with an `occurredAt` from long before it, and would be missed.

   ```sql
   SELECT id, name, "occurredAt", "createdAt"
   FROM domain_events
   WHERE "createdAt" >= :disabled_at   -- and < the re-enable time, once known
   ORDER BY "createdAt";
   ```

   **Wait out the sink cache before the next query.** Every process caches the sink list
   for `SINKS_CACHE_TTL_MS` (default 10 s), so for up to that long after the switch an
   event can still fan out to the CRM. Its delivery then fails because the sink is off.
   Wait at least the cache TTL (say 30 s), then list the events that fanned out to the CRM
   and never arrived: deliveries that failed or dead-lettered, any still pending from the
   window between the drain and the switch, and those from the cache window. Record their
   ids in the deploy log; B5 re-posts these too. This query covers only deliveries that
   exist, so run it **after** the wait, not before the switch. An event can be on both
   lists; the CRM dedupes on the event `id`.

   ```sql
   SELECT d."eventId", d.status, d."lastError"->>'message' AS error
   FROM event_deliveries d
   WHERE d.sink = 'crm' AND d.status <> 'delivered'
   ORDER BY d."createdAt";
   ```

3. Stop the new image: the server AND the worker.
4. Delete the three bookkeeping rows and the CRM sink row by hand:

   ```sql
   DELETE FROM effect_sql_migrations WHERE migration_id IN (23, 24, 25);
   DELETE FROM sinks WHERE kind = 1;
   ```

   The sink row has to go because main's `toView` has no case for kind 1, so its console
   Sinks list answers 500 while the row exists (§5). The delete also removes the CRM
   token, so a later roll-forward needs it pasted again.

5. Leave everything else the migrations added in place (main ignores it, see below).
6. Start image cdc3836 (server and worker).

**What stays behind, and why it is harmless to main:**

| Migration | Adds | Under cdc3836 |
|---|---|---|
| 0023 | `domain_events."idempotencyKey"` text, nullable, no default (backfilled from `id`); index `domain_events_idempotency_key_idx` (NON-unique) | main never reads or writes it; its inserts leave it NULL |
| 0024 | `checkout_sessions.metadata` jsonb, nullable; `payments.metadata` jsonb, nullable | main never reads or writes them; its inserts leave them NULL |
| 0025 | `sinks` row `kind = 1` (CRM), disabled, `config = {"url":""}`, empty token | deleted by rollback step 4; left in place, main's console Sinks list would return 500 (§5) |

The `event_deliveries` rows for `sink = 'crm'` also stay. Main runs nothing for them once
step 1 has drained their queue messages; its operator deliveries list may still show them.

Rolling forward again later is safe. 0023 re-runs as `ADD COLUMN IF NOT EXISTS`, then
backfills only rows still NULL, which are the events written under cdc3836. 0024 also uses
`IF NOT EXISTS`. 0025 re-seeds the CRM row the rollback deleted, disabled with no URL or
token, so §7 applies again.

## 3. Stuck lapses will fire at the first tick

The lapse queue key is now `lapse:{id}:{dueMs}:{cancelRequestedAt}`. Under main's
`lapse:{id}:{dueMs}`, a payment can be stuck cancel-pending forever: a tick enqueues the lapse,
an operator reactivates before the handler runs (the handler is a guarded no-op), and the
payment is cancelled again before the next tick — the next tick hits the spent key, so the row
is re-offered every tick and never lapses or charges. Every such row gets a new key at the
first post-deploy tick, lapses, and emits `renewal_failed (reason: cancelled)` to SendPulse,
possibly for a cancellation from weeks ago. Count them before deploy:

```sql
SELECT id, "externalUserId", "nextPaymentDate", "cancelRequestedAt"
FROM payments
WHERE status IN (0, 1)            -- Active, PastDue
  AND "cancelRequestedAt" IS NOT NULL
  AND "nextPaymentDate" < now() - interval '1 hour';
```

Zero rows: nothing changes. Any row needs an owner decision: let it lapse, or reactivate it
first. Old- and new-shape lapse messages mixed during the rolling deploy are safe: the flip
and its publish run in one transaction under `markCancelledLapsed`'s guard, so exactly one
`renewal_failed` goes out.

## 4. A cancellation spanning the deploy may be announced twice

`payment_cancelled` is now keyed on `cancelRequestedAt`
(`evt_sub_{id}_cancelled_{stamp}`); main used the constant `evt_sub_{id}_cancelled`. If an
operator soft-cancelled a payment before the deploy (main emitted the constant id) and the
scheduler's pre-charge SendPulse tag check fires `cancelUpstream` after it, the upstream path
keeps the old stamp (COALESCE) but emits under the new id: two `payment_cancelled` events. A
SendPulse flow mapped to `payment_cancelled` runs twice, and the CRM stores two facts. The
volume is bounded by the cancel-pending rows at deploy time — the query in §3 without the
due-date filter:

```sql
SELECT id, "externalUserId", "nextPaymentDate", "cancelRequestedAt"
FROM payments
WHERE status IN (0, 1)            -- Active, PastDue
  AND "cancelRequestedAt" IS NOT NULL;
```

## 5. Rolling window: the old image's Sinks list can 500

Until the old server process is gone, main's `toView` has no case for kind 1, so the old
image's console Sinks list can return a 500 once 0025 has run. Main's `buildConnector` drops
unknown kinds and the row is disabled anyway, so no delivery is affected. Do not configure
sinks until the old process is gone.

## 6. Watch: metadata reaches SendPulse

The SendPulse connector spreads the whole payload into `external_data`. Success events now
also carry `periodStart`, `periodEnd`, `recurring` and `metadata` (the caller's nested object,
echoed verbatim). When a checkout first carries metadata, check that delivery in SendPulse.

## 7. After deploy: enable the CRM sink, only once the gates hold

Enabling sends every billing event to the CRM, including the three success kinds the
CRM pays and attributes on. Do not enable it until gates (a) to (c) hold, and do not let the
CRM payments consumer be switched on until (d) holds too. Record each one in the deploy log.

(a) **guildmaster PR #28 is deployed** to the CRM this sink points at. That release makes
the CRM door answer 422 for a money-kind payload its registry rejects, instead of 200
`rejected`. Billing also refuses anything but `validated` for those kinds (docs/21 §14.2),
but the CRM side has to be live too.

(b) **The billing token is minted in the CRM with scopes `events`, `money_events` and
`billing_events`, and is NOT a trusted proxy.** The CRM door requires `billing_events` for
every billing kind, and `money_events` for its projected money kinds; without either it
answers 403. Billing treats a 403 as permanent, so every such event would dead-letter. A
trusted-proxy token is the Guild proxy's kind. The door answers 400 to it without a client
fingerprint header, which billing never sends, and 403 to a billing or money kind even with
one. Both are permanent here. Check the client's scopes and proxy flag in the CRM's
API-clients list before pasting the token.

(c) **A test POST of each success kind answers `validated`, made and cleaned up with the
CRM owner's sign-off.** The test events are real rows in the CRM, and a validated success
event is what the CRM pays and attributes on. So this step needs the CRM owner's sign-off
before it starts, and runs in this order:

1. Confirm with the CRM owner that the CRM's payments consumer switch is OFF. While it is
   off, a stored event is not acted on.
2. Post exactly one event of each success kind (`initial_payment_succeeded`,
   `recurring_payment_succeeded`, `one_time_purchase_succeeded`). Use the URL and token you
   are about to paste, the docs/21 §14.1 body shape, a fresh `id` each time, and one
   dedicated test `external_user_id` that belongs to no real contact (agree the value with
   the CRM owner and record it in the deploy log). The payload must carry every field a
   real success event does, as below: the CRM registry rejects a success payload that lacks
   `currency`, `method` or `period`. `charge_kind` is `scheduled` or `checkout`, the only two
   values the registry accepts.
3. Each must answer 200 with `"schema_status":"validated"`. Anything else (`unregistered`,
   `rejected`, 4xx) means the CRM would refuse real payments: stop, delete what was posted
   (step 4) and fix the CRM side.
4. Delete the three test events through the CRM admin, by that `external_user_id`.
5. Only then may the CRM owner turn the payments consumer switch on, and only once gate
   (d) below is clean.

(d) **No scheduled charge was ever booked twice.** Before the per-order guard
(`recordSuccessOnce` in `charge/domain.ts`), one Approved token charge could reach the
pipeline as two `charges` rows: the scheduler's own copy (`w4p:<ref>|CHARGE|<date>`) and the
WayForPay callback for the same order (`w4pcb:<ref>|Approved`). Both settled, each with its
own `recurring_payment_succeeded`. The B5 backfill would hand both to the CRM as two
payments. Run on the production billing database before the CRM payments consumer is
switched on:

```sql
-- orders with more than one succeeded copy, and how many success events they produced
SELECT c."externalRef",
       count(DISTINCT c.id)  AS copies,
       count(e.id)           AS success_events,
       string_agg(DISTINCT c.source, ', ') AS sources
FROM charges c
LEFT JOIN domain_events e
  ON e."correlationId" = c."idemKey" AND e.name = 'recurring_payment_succeeded'
WHERE c."externalRef" LIKE 'sub\_%' AND c.status = 'succeeded'
GROUP BY c."externalRef"
HAVING count(DISTINCT c.id) > 1;
```

Zero rows: nothing to do. Any row with `success_events` above 1 is a charge reported twice.
Record the event ids in the deploy log. The CRM owner decides, before the switch, which one
the CRM keeps; B5 must not re-post the other.

```sh
# preflight-recurring_payment_succeeded.json, the shape crmBody sends (docs/21 §14.1).
# For the other two kinds change name and id; one_time_purchase_succeeded has
# "next_payment_date": null, "recurring": false, "charge_kind": "checkout".
# occurred_at must be the current UTC time: the CRM answers 400 occurred_at_in_future to
# a time ahead of its clock (beyond its skew allowance), so never paste a fixed date here.
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > preflight-recurring_payment_succeeded.json <<JSON
{
  "id": "evt_preflight_recurring_1",
  "idempotency_key": "evt_preflight_recurring_1",
  "name": "recurring_payment_succeeded",
  "occurred_at": "${NOW}",
  "external_user_id": "<the agreed test external_user_id>",
  "correlation_id": "preflight-recurring-1",
  "aggregate_id": "preflight-payment-1",
  "payload": {
    "amount": 150000,
    "currency": 0,
    "method": 0,
    "period": "P1M",
    "source": "wayforpay_charge",
    "charge_kind": "scheduled",
    "next_payment_date": "2026-11-22T09:00:00.000Z",
    "period_start": "2026-10-22T09:00:00.000Z",
    "period_end": "2026-11-22T09:00:00.000Z",
    "recurring": true,
    "metadata": null,
    "aggregate_id": "preflight-payment-1",
    "correlation_id": "preflight-recurring-1"
  }
}
JSON
curl -sS -X POST "$CRM_URL" \
  -H "Authorization: Bearer $CRM_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: preflight-recurring-1' \
  --data @preflight-recurring_payment_succeeded.json
# → {"status":"ok","event_id":"…","schema_status":"validated"}
```

Then: console → Sinks → CRM, paste the URL and the bearer token, and enable. The console
refuses to enable it with either one missing (422). Watch `event_deliveries` for
`sink = 'crm'`, and watch the watchdog for `DEAD_LETTER`. A refused payment logs
`DEAD_LETTER queue message failed permanently` with `crm stored <kind> as <status>` in its
error.

**A misconfigured sink's dead letters have to be re-posted after the fix.** A delivery that
fails because of configuration (a wrong or missing token, a wrong URL, a CRM refusing the
payload) is retried five times over about 15 seconds (`QUEUE_MAX_ATTEMPTS`, default 5),
then dead-letters. Fixing the configuration does not bring those events back. This repo
offers **no** command or route to requeue a dead letter (`sinks/routes.ts`: "a dead letter is
terminal, there is no requeue"). Do not reset `messages` rows by hand either: every status
change appends its `message_status_events` row in the same statement (docs/09), and a hand
`UPDATE` breaks that log. After the fix, list the failed deliveries with the §2 step 2
query and hand the event ids to the B5 backfill, which re-posts them from outside this repo.
That query covers only events that fanned out to the CRM. If the sink was switched off
while the fix was made, the events published while it was off have no CRM delivery row:
record the off and on times, and have B5 re-post every event whose
`domain_events."createdAt"` falls in that window as well (§2 step 2, including the wait for
the sink cache).

(e) **Adding `payment_refunded` (docs/34) to a sink that is already enabled.** The CRM
must answer `validated` for it before the billing release that emits it is deployed: the
kind is a money kind for this sink, so any other answer dead-letters every refund. With the
CRM owner's sign-off, as in (c), post one refund with a fresh `id` and the agreed test
`external_user_id`, expect `"schema_status":"validated"`, then delete it through the CRM
admin. The CRM writes no `payments` row for a refund (plan D12), so this test row moves no
money. `original_event_id` and `order_reference` are required by the CRM registry;
`reason` is optional.

```sh
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > preflight-payment_refunded.json <<JSON
{
  "id": "evt_preflight_refund_1",
  "idempotency_key": "evt_preflight_refund_1",
  "name": "payment_refunded",
  "occurred_at": "${NOW}",
  "external_user_id": "<the agreed test external_user_id>",
  "correlation_id": "preflight-refund-1",
  "aggregate_id": "preflight-payment-1",
  "payload": {
    "amount": 150000,
    "currency": 0,
    "source": "wayforpay_callback",
    "order_reference": "preflight-order-1",
    "original_event_id": "evt_preflight_recurring_1",
    "aggregate_id": "preflight-payment-1",
    "correlation_id": "preflight-refund-1"
  }
}
JSON
curl -sS -X POST "$CRM_URL" \
  -H "Authorization: Bearer $CRM_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: preflight-refund-1' \
  --data @preflight-payment_refunded.json
# → {"status":"ok","event_id":"…","schema_status":"validated"}
```

What B5 must send is in §9.

## 8. Accepted risk: a late remap retry can undo a revert

Accepted by the owner on 2026-10-21. The CRM can remap a contact A→B and then revert it
B→A. If a delayed retry of the first A→B arrives after the revert, it re-applies the old
remap. B is live again, and the relay calls billing's external-user-id rename again. There
is no idempotency key per remap through the relay and billing. The owner chose to accept
this rather than add one.

What it does to billing: the remap's billing rename (`POST /api/payment/rename-external-user`,
called by the relay) stays on the CRM's `ingest` path. It moves
the payments and open sessions to the new id and does not re-fire events (`refireEvents`
is not set, so no `external_user_id_changed` goes out; docs/31). A repeated rename moves
data and sends nothing to any sink.

## 9. What the B5 backfill must send

B5 (the history backfill; not built yet, and not in this repo) re-posts stored
`domain_events` to the CRM in the docs/21 §14.1 dialect. Three rules come from this release:

1. **Select windows by `domain_events."createdAt"`**, never by `"occurredAt"` (§2 step 2).
2. **Send `charge_kind` on every success event**: `initial_payment_succeeded`,
   `recurring_payment_succeeded` and `one_time_purchase_succeeded`. Analytics reads
   `charge_kind` directly. It has no `source` fallback any more, and its derive run fails
   on a billing success without the field. An event stored before `chargeKind` shipped
   (c70cd9a; 412f876 on PR #6) has none in its payload, so B5 derives it from the order reference, with the
   same rule billing applies to a bound charge (`boundChargeKind`, `charge/domain.ts`):
   reference starting `sub_` or containing `_WFPREG-` → `scheduled`; anything else →
   `checkout`. The reference is the `externalRef` of the charge the event came from. A
   success event's `correlationId` is that charge's `idemKey`:

   ```sql
   SELECT e.id, e.name, c."externalRef",
          CASE WHEN c."externalRef" LIKE 'sub\_%' OR c."externalRef" LIKE '%\_WFPREG-%'
               THEN 'scheduled' ELSE 'checkout' END AS charge_kind
   FROM domain_events e
   JOIN charges c ON c."idemKey" = e."correlationId"
   WHERE e.name IN ('initial_payment_succeeded', 'recurring_payment_succeeded',
                    'one_time_purchase_succeeded')
     AND NOT (e.payload ? 'chargeKind');
   ```

   An event that already carries `chargeKind` is sent as stored. A success event with no
   matching `charges` row would be a defect. Stop and report it; do not guess.
3. **Skip the second event of a doubled charge** that §7 gate (d) found. Re-post only the
   one the CRM owner chose to keep.
4. **Skip quarantine events** (`unknown_payment_quarantined`), as the live sink does (owner
   decision 2026-10-21; docs/21 §14.2). A quarantine that was later bound already has its
   own `recurring_payment_succeeded`, which B5 sends like any success. One still open is
   unfixed and is not sent at all.

