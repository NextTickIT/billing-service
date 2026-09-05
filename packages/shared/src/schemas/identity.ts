import { Schema } from 'effect';

/**
 * External-user-id remap history (docs/31). `externalUserId` is opaque and carried
 * verbatim (AC9); when the external system reissues a user's id, a specific action
 * remaps that user's LIVE billing records (Payment rows, open checkout sessions) to
 * the new id and appends one row here. This table is append-only — the full history
 * of every change — so the chain of a user's ids is traced by following `from` → `to`.
 * Past raw charges and emitted events are immutable and keep their original id.
 */
export const ExternalUserIdChange = Schema.Struct({
  id: Schema.String,
  fromExternalUserId: Schema.String,
  toExternalUserId: Schema.String,
  // What initiated the remap (the service caller). Kept for the audit trail.
  source: Schema.String,
  reason: Schema.NullOr(Schema.String),
  // How many live records moved, captured at the time of the change.
  movedPayments: Schema.Int,
  movedSessions: Schema.Int,
  occurredAt: Schema.Date,
});

export type ExternalUserIdChange = Schema.Schema.Type<
  typeof ExternalUserIdChange
>;

/** Append params: the server owns `id` and `occurredAt`. */
export const NewExternalUserIdChange = ExternalUserIdChange.pipe(
  Schema.omit('id', 'occurredAt'),
);

export type NewExternalUserIdChange = Schema.Schema.Type<
  typeof NewExternalUserIdChange
>;

/**
 * POST /api/payment/rename-external-user body (service token): remap all of a user's
 * live billing records from one opaque id to another. `from`/`to` are carried verbatim
 * (never transformed); the domain rejects an empty id or a no-op (`from === to`).
 */
export const RenameExternalUserRequest = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  reason: Schema.optional(Schema.String),
});

export type RenameExternalUserRequest = Schema.Schema.Type<
  typeof RenameExternalUserRequest
>;

/** POST /api/payment/rename-external-user response: the ids and how many records moved. */
export const RenameAccepted = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  movedPayments: Schema.Int,
  movedSessions: Schema.Int,
});

export type RenameAccepted = Schema.Schema.Type<typeof RenameAccepted>;
