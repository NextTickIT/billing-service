# Vertical slices inside horizontal architectural boundaries

We will organize development by vertical slices and keep horizontal architectural boundaries inside each slice.
A vertical slice is a complete user or business value path through the system. For example:

```text
billing page
  -> billing API
  -> use case
  -> billing rules
  -> billing storage
  -> domain events / outbox
```

Horizontal boundaries still exist, but they are not used as delivery phases.
They define dependency direction, isolation, and code consistency.

Each valuable billing scenario should be implemented as a complete slice from API to domain rules, persistence, provider boundary, and events.

Initial slices should be ordered by product value and risk:

1. user creation or import
2. subscription creation
3. payment link generation
4. first payment callback
5. recurring billing attempt
6. duplicate charge protection
7. failed payment retry
8. suspension and access removal event
9. quarantine
10. recovery payment link
11. support read API
12. provider adapter extension boundary

Each slice must respect these horizontal boundaries:
- api: accepts transport input, auth, routing, request shape
- application: executes use cases, transactions
- domain: owns subscription state, billing rules, period calculation, policies
- infrastructure: implements db access, provider clients, outbox delivery, worker runtime

The dependency direction is inward: api -> application -> domain

Infrastructure is allowed to implement interfaces needed by application and domain, but domain rules must not depend on PostgreSQL, WayForPay, Whitepay, SendPulse, HTTP, Docker, queues, or the worker runtime.

## Alternatives considered

### Big bucket: UI -> API -> database

This is the fastest way to create a demo, but it makes the database the implicit domain model. Billing state, retry policy, provider callback semantics, outbox events, and support reads become coupled through tables and ad-hoc queries.

Rejected because the service owns payment and subscription state, must prevent duplicate charges, and must process callbacks idempotently. These rules need explicit domain and application boundaries.

### Horizontal layers as implementation phases

This gives clean folders and familiar architecture, but work can be split into database tasks, API tasks, domain tasks, and UI tasks without any finished user value. Feedback comes too late, integration risk accumulates, and rejected requirements cause unused layer work.

Rejected as a delivery model. Accepted only as an internal code boundary.

### Clean architecture only

Clean architecture gives strong dependency direction and testability:

```text
              +-----------------------------+
   gui <----> | infrastructure              |
              | db / http / queue / cache   |
              |   +---------------------+   |
              |   | controllers / repo  |   |
              |   |   +-------------+   |   |
              |   |   | application |   |   |
              |   |   | use cases   |   |   |
              |   |   | +---------+ |   |   |
              |   |   | | domain  | |   |   |
              |   |   | +---------+ |   |   |
              |   |   +-------------+   |   |
              |   +---------------------+   |
              +-----------------------------+
```

Accepted as a dependency model, but not sufficient as a planning model.
The team still needs to deliver complete vertical slices of value.

## Consequences

Positive:

- each change can be shown, checked, used, and evaluated
- feedback arrives earlier
- the riskiest billing scenarios are tested sooner
- architecture supports delivery of value in small pieces
- layers remain isolated without delaying product validation
- domain rules stay consistent across user stories
- provider-specific details remain outside domain rules
- durable outbox and callback idempotency can be implemented slice by slice

Negative:

- each slice requires touching several layers
- the team must maintain naming and structure consistency across slices
- early slices need minimal versions of all required boundaries
- excessive slice-local shortcuts can duplicate infrastructure code
- without discipline, vertical slices can degrade into feature folders with hidden coupling

## Implementation rules

1. Do not create a layer-only milestone unless it enables the next vertical slice.
2. Every slice must have an observable result.
3. Every slice must pass through domain rules when billing state changes.
4. The database must not become the only place where business rules live.
5. Provider callbacks must enter through application use cases, not directly through storage updates.
6. Domain events must be written to the durable outbox before integration delivery.
7. Duplicate charge protection must be enforced at application/domain level and supported by persistence constraints.
8. Provider adapters must be replaceable behind application contracts.
9. Support read API must not mutate billing state.
10. SendPulse integration must consume billing events and must not become the source of truth for billing.

## Suggested repository structure

```text
api/billing/name.js - endpoints
static/billing/component-name.js - frontend
domain/billing/user-story.js - domain logic
```

alternatively:

```text
billing/
  api/name.js - endpoints
  static/name.js - frontend
  domain/user-story.js - domain logic
```
