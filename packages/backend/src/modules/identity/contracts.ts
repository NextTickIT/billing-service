import { Schema } from 'effect';

export { EXTERNAL_USER_ID_CHANGE } from '@billing-service/shared';

/**
 * `external_user_id_change` payload (docs/31). The rename route enqueues this when the
 * caller opts into `refireEvents`; the worker handler turns it into the outgoing
 * `external_user_id_changed` domain event (the outbox lives only in the worker runtime).
 */
export const ExternalUserIdChangeNotify = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  movedPayments: Schema.Int,
  movedSessions: Schema.Int,
});

export type ExternalUserIdChangeNotify = Schema.Schema.Type<
  typeof ExternalUserIdChangeNotify
>;
