import type { SqlError } from '@effect/sql';
import { Cause, Duration, Effect } from 'effect';

import type { ContactsRepo } from '@/modules/contacts/data-access.js';
import type { SinkError } from '@/infra/sinks.js';
import type { ContactProfile } from '@/modules/sinks/sendpulse.js';

/**
 * Contacts-cache sync (docs/21): keep each payment contact's searchable profile
 * (name/username/email/phone) mirrored from SendPulse so the operator's payments
 * search resolves a name to contact ids in one SQL query. Best-effort — a failed
 * fetch is logged and retried next tick; the sync never blocks anything else.
 */
export interface ContactsSyncDeps {
  readonly contacts: ContactsRepo;
  readonly fetchProfile: (
    externalUserId: string,
  ) => Effect.Effect<ContactProfile, SinkError>;
}

export interface ContactsSyncConfig {
  readonly intervalSeconds: number;
  /** Refresh a cached contact once it is older than this. */
  readonly ttlSeconds: number;
  /** Max contacts fetched per tick (the SendPulse client rate-limits the calls). */
  readonly batchSize: number;
}

export const contactsSyncTick = (
  deps: ContactsSyncDeps,
  config: ContactsSyncConfig,
): Effect.Effect<number, SqlError.SqlError> =>
  Effect.gen(function* () {
    const ids = yield* deps.contacts.staleContactIds(
      config.ttlSeconds,
      config.batchSize,
    );
    yield* Effect.forEach(
      ids,
      (id) =>
        deps.fetchProfile(id).pipe(
          Effect.flatMap((profile) => deps.contacts.upsert(id, profile)),
          // Isolate each contact: one failed fetch must not abort the batch.
          Effect.catchAllCause((cause) =>
            Effect.logWarning('contacts sync: fetch failed').pipe(
              Effect.annotateLogs({
                contactId: id,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
      { discard: true, concurrency: 5 },
    );
    return ids.length;
  });

export const runContactsSync = (
  deps: ContactsSyncDeps,
  config: ContactsSyncConfig,
): Effect.Effect<never> =>
  contactsSyncTick(deps, config).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError('contacts sync tick failed').pipe(
        Effect.annotateLogs('cause', Cause.pretty(cause)),
      ),
    ),
    Effect.andThen(Effect.sleep(Duration.seconds(config.intervalSeconds))),
    Effect.forever,
  );
