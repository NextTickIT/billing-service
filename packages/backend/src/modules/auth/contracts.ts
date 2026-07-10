import { RoleSchema } from '@billing-service/shared';
import { Schema } from 'effect';

/**
 * Backend-only transport contracts. These carry SECRETS (plaintext passwords),
 * so — unlike the public entity shapes in `@billing-service/shared` — they live
 * here, not in `shared`. Passwords decode straight into `Redacted` so they are
 * never accidentally logged; the plaintext is unwrapped only inside `Hasher`.
 */

/** `POST /auth/tokens` body: admin mints a token with an alias + role. */
export const CreateAuthTokenBody = Schema.Struct({
  alias: Schema.String,
  role: RoleSchema,
});
export type CreateAuthTokenBody = Schema.Schema.Type<
  typeof CreateAuthTokenBody
>;

/** `POST /auth/operators` body: admin creates an operator (login + password). */
export const CreateOperatorBody = Schema.Struct({
  login: Schema.String,
  password: Schema.Redacted(Schema.String),
  role: RoleSchema,
});
export type CreateOperatorBody = Schema.Schema.Type<typeof CreateOperatorBody>;

/** `POST /auth/sessions` body: an operator signs in. */
export const CreateSessionBody = Schema.Struct({
  login: Schema.String,
  password: Schema.Redacted(Schema.String),
});
export type CreateSessionBody = Schema.Schema.Type<typeof CreateSessionBody>;
