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
- A: Simple name/password/token auth. Single role.

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
- A: Kyiv: EEST (Eastern European Summer Time)

- Q: What happens for billing dates 29, 30, 31?
- A: Advance to the last valid day of the target month (e.g. Jan 31 → Feb 28).

- Q: Can user restore subscription after quarantine and how?
- A: -

## Data

- Q: What fields can be exported from SendPulse?
- A: -

- Q: What field uniquely identifies a user?
- A: -

- Q: Are Telegram ID, phone, email available?
- A: -

- Q: Are current paid periods available?
- A: -

- Q: Are existing recurring tokens available and migratable?
- A: -

## Operations

- Q: What database should be used?
- A: PG

- Q: Do we need a background worker as a separate process?
- A: Yes

- Q: What deployment environment is expected?
- A: Linux, docker, node.js
