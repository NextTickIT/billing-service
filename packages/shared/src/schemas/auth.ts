import { Schema } from 'effect';

import { RoleSchema } from '@/enums/role.js';

/**
 * Public Auth contracts — the single source of truth for the shapes that flow
 * unchanged to db, backend, and frontend. These are the PUBLIC shapes only:
 * secrets (passwords, token/session hashes) never appear here — they live in
 * the backend data-access layer and in the backend-only request contracts.
 * Static types are DERIVED from the schemas; `CreateParams` are computed via
 * `Schema.omit`, so they can never drift. Timestamps are `Date` (what the
 * Postgres driver returns and what `Clock` derives); JSON encoding to an ISO
 * string happens only at the HTTP boundary.
 */

/** An API/auth token: an admin-minted credential carrying an alias and a role. */
export const AuthToken = Schema.Struct({
  id: Schema.String,
  alias: Schema.String,
  role: RoleSchema,
  createdAt: Schema.Date,
});

export type AuthToken = Schema.Schema.Type<typeof AuthToken>;

/** Create params: the admin supplies alias + role; the server owns id + createdAt. */
export const CreateAuthToken = AuthToken.pipe(Schema.omit('id', 'createdAt'));

export type CreateAuthToken = Schema.Schema.Type<typeof CreateAuthToken>;

/** An operator: a human principal that signs in with a login + password. */
export const Operator = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  role: RoleSchema,
  createdAt: Schema.Date,
});

export type Operator = Schema.Schema.Type<typeof Operator>;

/**
 * Create params: the admin supplies login + role. The password is a secret and
 * is intentionally NOT part of this public shape — it travels only in the
 * backend's `CreateOperatorBody` request contract.
 */
export const CreateOperator = Operator.pipe(Schema.omit('id', 'createdAt'));

export type CreateOperator = Schema.Schema.Type<typeof CreateOperator>;

/** A session: minted on sign-in, carrying the operator's role and its expiry. */
export const Session = Schema.Struct({
  id: Schema.String,
  operatorId: Schema.String,
  role: RoleSchema,
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
});

export type Session = Schema.Schema.Type<typeof Session>;

/** Create params: the server owns id, createdAt, and the derived expiresAt. */
export const CreateSession = Session.pipe(
  Schema.omit('id', 'createdAt', 'expiresAt'),
);

export type CreateSession = Schema.Schema.Type<typeof CreateSession>;
