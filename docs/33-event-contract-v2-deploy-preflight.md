# 33 — Event contract v2 + CRM sink: deploy pre-flight (B4)

Branch `event-contract-v2-main`: PR #5 (`wip/event-contract-v2`) replayed onto `main`
(58d80ef), plus the CRM envelope (owner decision 1) and the manual-renewal pin (decision 7).
This is the checklist for the deploy that ships it (work package B4). Source: the critic
review of 2026-10-20. The runbook itself lives in `billing-service-deploy`
(`20-deployment.md`); record the deploy there as usual and link this page.

What the image adds to the database: migrations `0022_event_idempotency_key` (nullable
`domain_events."idempotencyKey"`, backfill, NON-unique index), `0023_metadata_passthrough`
(nullable `metadata` on checkout sessions and payments) and `0024_crm_sink` (sink row
`kind = 1`, disabled, empty URL). All three are additive.

## 1. Run on every database before deploying (prod, staging, shared dev)

```sql
SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id;
-- expect 1..21 ending 20 checkout_email, 21 checkout_renewal; nothing else
SELECT kind, enabled, config FROM sinks ORDER BY kind;
-- expect 0 (sendpulse) and 2 (email); a pre-existing kind 1 row would survive 0024's DO NOTHING
```

A database that once ran PR #5's OLD numbering (0020–0022 as `event_idempotency_key`,
`metadata_passthrough`, `crm_sink`) fails the boot check `unmatchedApplied`
(`infra/migrator.ts`) with "Applied migrations have no matching file". Prod is very unlikely
to be in that state (it boots 58d80ef, which runs the same check); staging or a shared dev DB
may be. Fix such a database before deploying to it.

## 2. Rollback to 58d80ef needs a manual step

Main's server boot runs the same `unmatchedApplied` check (`infra/migrator.ts`). After this
deploy the applied rows `22 event_idempotency_key`, `23 metadata_passthrough` and
`24 crm_sink` have no file in image 58d80ef, so a plain redeploy of that image **refuses to
start** ("Applied migrations have no matching file"). The migrations are additive, so the
rollback removes only their bookkeeping rows, plus the CRM sink row (step 4).

**Rollback procedure:**

1. If the CRM sink was ever enabled, drain it **while it is still enabled**. Image 58d80ef
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

2. Disable the CRM sink (console → Sinks → CRM → off). Then list every event the CRM still
   lacks: whatever was published between the drain and the switch, plus anything that
   dead-lettered earlier. Record the ids in the deploy log; the B5 backfill re-posts them.

   ```sql
   SELECT d."eventId", d.status, d."lastError"->>'message' AS error
   FROM event_deliveries d
   WHERE d.sink = 'crm' AND d.status <> 'delivered'
   ORDER BY d."createdAt";
   ```

3. Stop the new image: the server AND the worker.
4. Delete the three bookkeeping rows and the CRM sink row by hand:

   ```sql
   DELETE FROM effect_sql_migrations WHERE migration_id IN (22, 23, 24);
   DELETE FROM sinks WHERE kind = 1;
   ```

   The sink row has to go because main's `toView` has no case for kind 1, so its console
   Sinks list answers 500 while the row exists (§5). The delete also removes the CRM
   token, so a later roll-forward needs it pasted again.

5. Leave everything else the migrations added in place (main ignores it, see below).
6. Start image 58d80ef (server and worker).

**What stays behind, and why it is harmless to main:**

| Migration | Adds | Under 58d80ef |
|---|---|---|
| 0022 | `domain_events."idempotencyKey"` text, nullable, no default (backfilled from `id`); index `domain_events_idempotency_key_idx` (NON-unique) | main never reads or writes it; its inserts leave it NULL |
| 0023 | `checkout_sessions.metadata` jsonb, nullable; `payments.metadata` jsonb, nullable | main never reads or writes them; its inserts leave them NULL |
| 0024 | `sinks` row `kind = 1` (CRM), disabled, `config = {"url":""}`, empty token | deleted by rollback step 4; left in place, main's console Sinks list would return 500 (§5) |

The `event_deliveries` rows for `sink = 'crm'` also stay. Main runs nothing for them once
step 1 has drained their queue messages; its operator deliveries list may still show them.

Rolling forward again later is safe. 0022 re-runs as `ADD COLUMN IF NOT EXISTS`, then
backfills only rows still NULL, which are the events written under 58d80ef. 0023 also uses
`IF NOT EXISTS`. 0024 re-seeds the CRM row the rollback deleted, disabled with no URL or
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
image's console Sinks list can return a 500 once 0024 has run. Main's `buildConnector` drops
unknown kinds and the row is disabled anyway, so no delivery is affected. Do not configure
sinks until the old process is gone.

## 6. Watch: metadata reaches SendPulse

The SendPulse connector spreads the whole payload into `external_data`. Success events now
also carry `periodStart`, `periodEnd`, `recurring` and `metadata` (the caller's nested object,
echoed verbatim). When a checkout first carries metadata, check that delivery in SendPulse.

## 7. After deploy: enable the CRM sink, only once three gates hold

Enabling sends every billing event to the CRM, including the three success kinds the
CRM pays and attributes on. Do not enable it until all three gates below hold. Record each
one in the deploy log.

(a) **guildmaster PR #28 is deployed** to the CRM this sink points at. That release makes
the CRM door answer 422 for a money-kind payload its registry rejects, instead of 200
`rejected`. Billing also refuses anything but `validated` for those kinds (docs/21 §14.2),
but the CRM side has to be live too.

(b) **The billing token is minted in the CRM with scopes `events` and `money_events`, and
is NOT a trusted proxy.** Without `money_events` the door answers 403 to the success kinds.
Billing treats a 403 as permanent, so every payment event would dead-letter. A trusted-proxy
token is the Guild proxy's kind. The door answers 400 to it without a client fingerprint
header, which billing never sends, and 403 to a money kind even with one. Both are permanent
here. Check the client in the CRM's API-clients list before pasting
the token.

(c) **A test POST of each success kind answers `validated`.** Use the URL and the token you
are about to paste, and a body in the docs/21 §14.1 shape: name
`initial_payment_succeeded`, `recurring_payment_succeeded` and
`one_time_purchase_succeeded` in turn, a fresh `id` each time, and an `external_user_id`
that belongs to no real contact. Each must answer 200 with
`"schema_status":"validated"`. Anything else (`unregistered`, `rejected`, 4xx) means the CRM
would refuse real payments, so stop and fix the CRM side. These test events are real rows
in the CRM. Agree with the CRM owner, before posting, how they are recognised and removed.

```sh
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
