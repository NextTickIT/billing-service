import { Schema } from 'effect';

/**
 * Roles are numeric enums stored as numbers everywhere (db `smallint`, backend,
 * frontend); the Schema mirror validates the values. `Role` is owned by the auth
 * slice: an Admin-role credential creates tokens/operators, and a session
 * carries its operator's role.
 */
export enum Role {
  Admin = 0,
  Operator = 1,
  Service = 2,
}

export const RoleSchema = Schema.Enums(Role);

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
 * The password is a secret and is intentionally NOT part of this public shape —
 * it travels only in the backend's request schema.
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

export const CreateSession = Session.pipe(
  Schema.omit('id', 'createdAt', 'expiresAt'),
);

export type CreateSession = Schema.Schema.Type<typeof CreateSession>;
