# Non-Functional Requirements

Minimal NFR set for MVP and early production.

## Capacity

- Active clients: up to 100,000
- Payments per client: up to 1 scheduled payment per period (typically monthly)
- Concurrent support UI users: about 10
- Client UI: 10,000 (effective 100)
- We need to limit calls to WayForPay (rate limitter, queue)

## Performance

- Support UI pages: under 1-2 second under normal load
- Status API requests: under 500ms - 1s under normal load
- Provider callbacks (accept and store): under 2 second under normal load
- Outgoing event delivery: each sink updated within **60 seconds** of payment fixation (AC1)
- Scheduler throughput: all due payments processed within 24 hours, even if all 100,000 subscriptions are due on the same day

## Reliability

- No loss of payment status, callbacks, payment attempts, subscription state, or domain events after restart.
- Scheduler jobs must be restart-safe.
- Payment data must be idempotent.
- Duplicate callbacks must not corrupt subscription state.

## Money and time

- Amounts are stored only in integer minimal currency units.
- All timestamps are stored and emitted in UTC.

## Consistency

- A subscription must have one clear current status.
- The same billing period must not have two successful charges by internal logic.
- Successful payment must update subscription state before integration events are emitted.

## Security

- No storage of card numbers, CVV, or raw payment credentials.
- Provider tokens must be treated as sensitive data.
- Admin and support APIs must require authentication.
- Service-to-service APIs must require token-based authentication.
- Secrets must be stored outside source code.

## Privacy

- Store only data required for payment processing, support, audit, and integrations.
- Logs must not contain card data, provider secrets, raw tokens, or unnecessary personal data.

## Auditability

Audit records are required for:

- payment attempts
- provider callbacks
- subscription status changes
- retry scheduling
- manual support actions (quarantine binding, cancellation)
- checkout session creation (payment link issuance)

## Observability

Structured logs and correlation IDs are required.

### Minimum metrics

- successful payments
- failed payments
- pending payments
- retry attempts
- provider callback errors
- scheduled processes errors
- quarantine queue size
- undelivered outgoing events
- subscriptions currently in retry
- migration poller freshness
- migration tail (not-yet-migrated W4P recurrents)

Each operator queue (quarantine, undelivered events, subscriptions in retry, poller freshness, migration tail) must have an alert.

## Backup and recovery

- For MVP, daily backup is acceptable (to external storage)
