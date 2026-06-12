# Non-Functional Requirements

Minimal NFR set for MVP and early production.

## Capacity

- Active clients: up to 100,000
- Payments per client: up to 1 scheduled payment per month
- Concurrent support UI users: about 10

## Performance

- Support UI pages: under 1 second under normal load
- Status API requests: under 500 ms under normal load
- Provider callbacks (accept and store): under 1 second under normal load
- Scheduler throughput: all due monthly payments processed within 24 hours, even if all 100,000 subscriptions are due on the same day

## Reliability

- No loss of payment status, callbacks, payment attempts, subscription state, or domain events after restart.
- Scheduler jobs must be restart-safe.
- Payment processing must be idempotent.
- Duplicate callbacks must not corrupt subscription state.

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
- manual support actions
- payment link generation
- access restore or removal events

## Observability

Structured logs and correlation IDs are required.

### Minimum metrics

- successful payments
- failed payments
- pending payments
- retry attempts
- suspended subscriptions
- quarantined subscriptions
- provider callback errors
- scheduler errors
- event delivery errors

## Backup and recovery

- Database must be backed up automatically before production release.
- For MVP, daily backup is acceptable.

## Maintainability

- Payment provider logic must be isolated from subscription domain logic.
- Business rules must be testable without real providers.
- Scheduler logic must be testable with controlled time.
