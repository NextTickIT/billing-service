# Open Questions

Unresolved decisions grouped by area. Resolve before or during the relevant milestone.

## Product

- Q: Is SendPulse integration included in the first release?
- A: -

- Q: Must this service manage Telegram chat and channel access directly?
- A: No. Telegram bot is out of scope; SendPulse remains the communication channel.

- Q: Is support UI included in MVP?
- A: -

- Q: What support roles and permissions are needed?
- A: Simple name/password/token auth. Single role. Exact operator boundaries (who may bind quarantined payments and cancel subscriptions) still open — see below.

## Payment providers

- Q: What exact WayForPay recurring API methods are available?
- A: -

- Q: Does WayForPay support recurring token cancellation through API?
- A: -

- Q: Does WayForPay send callbacks for recurring successful charges?
- A: -

- Q: Does WayForPay send callbacks for recurring failed charges?
- A: -

- Q: Does WayForPay support idempotency keys?
- A: -

- Q: Does Whitepay support recurring payments?
- A: -

- Q: Does Whitepay support payment links?
- A: -

- Q: Can provider status be queried if callback was missed?
- A: -

## Billing rules

- Q: What timezone is canonical for billing?
- A: UTC. All timestamps are stored and emitted in UTC; billing-day arithmetic is also done in UTC.

- Q: What happens for billing dates 29, 30, 31?
- A: Advance to the last valid day of the target month (e.g. Jan 31 → Feb 28).

- Q: How does a user resume paying after `renewal_failed`?
- A: Via a new checkout session; a successful payment creates or extends the gateway subscription (00 §5.1). Whether extra business rules apply is open.

- Q: Refunds: do they pass through the gateway, is there a `payment_refunded` event, and how does a refund affect the subscription? (00 §11.1)
- A: -

- Q: Card change on an active subscription without a charge failure (user wants to update the card)? (00 §11.2)
- A: -

- Q: User-initiated cancellation: through which channel (bot → gateway API?) and what happens to the next charge date? (00 §11.3)
- A: -

- Q: Currencies: today USD/UAH; is the subscription currency fixed forever at creation? (00 §11.4)
- A: -

- Q: Multiple subscriptions per `external_user_id`: allowed, or one active (do we do "multiple products" right away)? (00 §11.5)
- A: -

- Q: Checkout link security: session lifetime, protection from guessing, who may create sessions? (00 §11.6)
- A: -

- Q: Operator rights and boundaries for quarantine binding and subscription cancellation? (00 §11.7)
- A: -

## Data

- Q: What fields can be exported from SendPulse?
- A: -

- Q: What field uniquely identifies a user?
- A: The opaque `external_user_id` supplied by the calling system. The gateway performs no identity matching (00 §2).

- Q: Are Telegram ID, phone, email available?
- A: Not needed by the gateway — it stores no contact data (00 §2).

- Q: Are current paid periods available?
- A: Not imported. paid_till is owned by the external system; gateway subscriptions appear through checkout payments (00 §2, §7).

- Q: Are existing recurring tokens available and migratable?
- A: No. W4P tokens are not exportable; migration happens only through the user re-entering the card via checkout (00 §7).

## Operations

- Q: What database should be used?
- A: PG

- Q: Do we need a background worker as a separate process?
- A: Yes

- Q: What deployment environment is expected?
- A: Linux, docker, node.js
