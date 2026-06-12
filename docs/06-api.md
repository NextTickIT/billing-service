# API Draft

Public and support HTTP surface. Authentication requirements are noted per section.

## Health

- `GET /health` (auth: none)

## Users

- `POST /api/users` (auth: service token)

### `POST /api/users`

Request body:

```json
{
  "externalId": "sendpulse:123",
  "telegramId": "123456",
  "email": "user@example.com",
  "phone": "+380000000000"
}
```

## Subscriptions

- `POST /api/subscriptions` (auth: service token)
- `GET /api/subscriptions/:id` (auth: service token)

## Payment links

- `POST /api/payment-links` (auth: service token)

## Provider callbacks

- `POST /api/providers/:provider/callback` (auth: provider signature)

## Support

- `GET /api/users?query=value` (auth: support token)
- `GET /api/users/:id/payments` (auth: support token)
- `GET /api/subscriptions/:id/events` (auth: support token)

All support endpoints require authentication.
