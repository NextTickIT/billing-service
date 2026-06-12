# recurring-payments

Minimal recurring payment processing service skeleton.

Specification lives in [docs/](./docs/): scope, functional requirements, API, domain model, and events.

## Runtime

- Node.js 20+
- No external dependencies are required for the skeleton.

## Local start

```bash
npm i
node src/main.js
```

Optional environment variables: `PORT`, `PUBLIC_BASE_URL`, `SERVICE_TOKEN`, `WAYFORPAY_MERCHANT_ACCOUNT`, `WAYFORPAY_SECRET_KEY`, `WHITEPAY_API_KEY`.

## Status

Prepared architecture and implementation skeleton. Provider integrations and production persistence are not complete yet. Open decisions are tracked in [docs/04-open-questions.md](./docs/04-open-questions.md).
