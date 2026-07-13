# Message Queue & Event Store — Recommendations

## 1. Requirements

### Functional

**R1 — Append-only raw event store.**
Every incoming request is written to an append-only raw event log, including duplicates. The log records what was fired and when. Rows are never updated or deleted.

**R2 — Idempotent message enqueue.**
Each message carries an idempotency key (unique per message-type invocation). On enqueue the key is checked:
- New key → message is enqueued for processing.
- Conflict → the raw event is still recorded (with its own receipt time), but no new message is fired.

**R3 — Exclusive processing in a cluster.**
The same service (running as multiple instances) consumes the queue. A message must never be processed by two or more workers simultaneously.

**R4 — Full attempt history.**
Every processing attempt — success or failure — is stored in a separate attempts table with its result. Failures store full error info (message, stack, code).

**R5 — Handler-controlled retries.**
On failure the handler decides:
- Return the message to the queue with a custom `retry_at` time, or
- After a handler-determined number of attempts, mark the message terminally processed with `fail` status.

**R6 — Message lifecycle (append-only status).**
`pending → in_progress → (retry → in_progress)* → success | fail`

Status is **not mutated in place**: each transition is a new, immutable row in an
append-only status log, timestamped, so the current status is simply the latest
transition by time. This keeps the same auditability guarantee as `raw_events`
and `attempts` — every state the message was ever in is preserved and countable,
and a transition can never silently overwrite its predecessor.

### Non-functional

**R7 — Minimal dependencies.** As few external services/resources as possible.

**R8 — Auditability.** It must always be answerable: what was fired, when, whether it was handled, by whom, with what result.

---

## 2. Options Considered

### Kafka
Canonical append-only log with consumer groups.
- ✅ R1 natively (partitioned log, long retention).
- ❌ R2 — no native idempotent produce by business key; dedupe must be built on the side.
- ❌ R4/R5 — offsets only say "processed up to X", not per-message status; custom `retry_at` requires delay-topic gymnastics.
- ❌ R7 — heavy operational dependency.
- **Rejected**: wrong shape for per-message status tracking, heaviest footprint.

### Redis Streams
Consumer groups with `XACK`/`XPENDING` map well to per-message ack state.
- ✅ R3 via consumer groups.
- ⚠️ R1 — durability/retention weaker than a real database.
- ❌ R4 — attempt history with results/errors needs a separate store anyway.
- ⚠️ R7 — one extra always-on dependency.
- **Rejected**: ends up needing a database next to it regardless.

### NATS JetStream
Durable consumers, explicit per-message acks, `NAK` with delay (fits R5 nicely), lighter than Kafka.
- ✅ R3, R5 largely native.
- ❌ R4 — no queryable attempt/result history; needs a database anyway.
- ⚠️ R7 — extra dependency.
- **Rejected for this case**: good middle ground in general, but still a second system.

### Temporal
Durable execution — retries, per-activity history, visibility.
- ✅ Replaces the "was it handled?" machinery entirely; retries/timeouts are first-class.
- ❌ R1 — workflow history is per-execution, size-limited (~50k events / 50 MB), retained only for a configured window; not a queryable long-term log.
- ❌ No pub/sub; new consumers can't replay history.
- ❌ R7 — heavy (server + persistence + workers), unless Temporal Cloud.
- **Rejected for this case**: solves durable *execution*, not durable *storage*. Reconsider if handlers become complex multi-step orchestrations.

### Postgres only
Queue is a table; exclusivity via `FOR UPDATE SKIP LOCKED`; dedupe via unique constraint; raw events and attempts are plain append-only tables.
- ✅ Every requirement R1–R8 with a single dependency most stacks already run.
- ✅ Everything queryable with SQL (R8 for free).
- ⚠️ Ceiling around thousands of msgs/sec; hot-table bloat needs autovacuum tuning + archiving.
- **Selected.**

> Note: **pg-boss** (Node.js) implements most of this pattern on Postgres (retries, singleton keys, archiving). Evaluate it before hand-rolling; the custom raw-event + attempts requirements may still justify owning the ~300 lines.

---

## 3. Recommended Design (Postgres)

### Schema

```sql
-- R1: append-only, every receipt including duplicates. Never updated.
CREATE TABLE raw_events (
  id            BIGSERIAL PRIMARY KEY,
  message_type  TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  was_duplicate BOOLEAN NOT NULL
);

-- R2/R6: the queue. One row per unique invocation.
CREATE TABLE messages (
  id            BIGSERIAL PRIMARY KEY,
  message_type  TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
                -- pending | in_progress | retry | success | fail
                -- Denormalized cache of the latest message_status_events row,
                -- advanced only inside the same transaction that appends it.
                -- Kept on the row so the claim query can filter cheaply.
  attempt_count INT NOT NULL DEFAULT 0,
  retry_at      TIMESTAMPTZ,
  locked_by     TEXT,
  locked_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  UNIQUE (message_type, idem_key)
);

CREATE INDEX messages_claimable ON messages (retry_at, id)
  WHERE status IN ('pending', 'retry');

-- R4: one row per attempt. Append-only.
CREATE TABLE attempts (
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT NOT NULL REFERENCES messages(id),
  attempt_no  INT NOT NULL,
  worker_id   TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      TEXT NOT NULL,          -- success | fail
  result      JSONB,
  error       JSONB                   -- { message, stack, code, ... }
);
```

### Ingest — one transaction (R1 + R2)

Dedupe rides on the unique constraint; no read-then-write race:

```sql
BEGIN;

INSERT INTO messages (message_type, idem_key, payload)
VALUES ($1, $2, $3)
ON CONFLICT (message_type, idem_key) DO NOTHING
RETURNING id;                     -- NULL → duplicate

INSERT INTO raw_events (message_type, idem_key, payload, was_duplicate)
VALUES ($1, $2, $3, /* previous RETURNING was NULL */);

NOTIFY new_message;               -- wake idle workers

COMMIT;
```

Duplicate → raw event still recorded with its own timestamp; no new message fired. True append-only (a new raw row per receipt) is preferred over updating a timestamp: every receipt is preserved and duplicates are countable.

### Claim — cluster-safe (R3)

```sql
WITH next AS (
  SELECT id FROM messages
  WHERE status IN ('pending', 'retry')
    AND (retry_at IS NULL OR retry_at <= now())
  ORDER BY id
  LIMIT $1                        -- batch size
  FOR UPDATE SKIP LOCKED
)
UPDATE messages m
SET status = 'in_progress',
    locked_by = $2,
    locked_at = now(),
    attempt_count = attempt_count + 1
FROM next
WHERE m.id = next.id
RETURNING m.*;
```

`FOR UPDATE SKIP LOCKED` guarantees no two workers claim the same row. The claim commits immediately — no long-held transactions during processing.

### Complete — one transaction (R4 + R5 + R6)

Insert the `attempts` row and update `messages` atomically:

| Outcome                          | `attempts.status` | `messages` update                          |
|----------------------------------|-------------------|--------------------------------------------|
| Handler succeeded                | `success`         | `status='success', finished_at=now()`      |
| Handler failed, wants retry      | `fail`            | `status='retry', retry_at=<handler value>` |
| Handler failed, retries exhausted| `fail`            | `status='fail', finished_at=now()`         |

The handler owns the retry policy: max attempts, backoff curve, custom `retry_at`.

### Operational details

**Crashed workers (stale locks).** An `in_progress` row whose worker died would be stuck forever. Any worker runs a reaper every ~30 s:

```sql
UPDATE messages
SET status = 'retry', retry_at = now(), locked_by = NULL
WHERE status = 'in_progress'
  AND locked_at < now() - interval '5 minutes';
```

Corollary: handlers must be idempotent, or the visibility timeout must exceed worst-case processing time (or extend `locked_at` via heartbeats).

**Wakeup latency.** Poll every 1–5 s as the baseline; layer `LISTEN/NOTIFY` on top for near-instant pickup of new messages. Retries still rely on polling — `retry_at` fires by clock, not by event.

**Table bloat.** The hot `messages` table churns dead tuples. Tune autovacuum aggressively for that table and periodically move terminal (`success`/`fail`) rows to an archive table. `raw_events` and `attempts` are insert-only — no bloat concern.

---

## 4. Verdict

**Postgres-only.** Single dependency (`postgres` + the `pg` driver), and it satisfies every requirement directly: unique constraint for idempotency, `FOR UPDATE SKIP LOCKED` for cluster-safe exclusive claims, plain append-only tables for the raw log and attempt history, and a status column for the exact lifecycle required. Full auditability comes free via SQL.

Revisit only if:
- sustained throughput exceeds ~5–10k msgs/sec → NATS JetStream or Kafka for transport, keeping Postgres for attempts/audit;
- handlers grow into multi-step, long-running orchestrations → Temporal for the execution side, keeping the Postgres raw-event log as the source of truth.

Before hand-rolling, spend an hour evaluating **pg-boss** — if its retry/singleton-key/archive semantics cover R1–R6 closely enough, use it and keep only the custom `raw_events` and `attempts` tables.
