import type { SqlError } from '@effect/sql';
import {
  type DomainEvent,
  type ExternalUserIdChangedEvent,
  type RenameAccepted,
  type RenameExternalUserRequest,
} from '@billing-service/shared';
import { Clock, Effect, Option, Schema } from 'effect';

import { onUniqueViolation } from '@/infra/db/pg-errors.js';
import {
  Conflict,
  NotFound,
  UnprocessableEntity,
} from '@/infra/http/errors.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  EXTERNAL_USER_ID_CHANGE,
  ExternalUserIdChangeNotify,
} from '@/modules/identity/contracts.js';
import type { ExternalUserIdChangeRepo } from '@/modules/identity/data-access.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';

export interface RenameDeps {
  readonly payments: PaymentRepo;
  readonly checkout: CheckoutRepo;
  readonly ledger: ExternalUserIdChangeRepo;
}

/**
 * Idempotent-retry check: when `from` owns no payment yet an identical `from` → `to`
 * remap is already on record, the earlier rename ran and emptied `from` — so a repeated
 * call replays that recorded result rather than failing NotFound. If `from` still owns
 * payments it is a fresh rename (even if `from` → `to` ran before, e.g. after a reverse),
 * so this returns None and the caller proceeds to move.
 */
const priorReplay = (
  deps: RenameDeps,
  cmd: RenameExternalUserRequest,
): Effect.Effect<Option.Option<RenameAccepted>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const fromPayments = yield* deps.payments.findByExternalUser(cmd.from);
    if (fromPayments.length > 0) {
      return Option.none<RenameAccepted>();
    }
    const prior = yield* deps.ledger.findLatestChange(cmd.from, cmd.to);
    return Option.map(prior, (p) => ({
      from: cmd.from,
      to: cmd.to,
      movedPayments: p.movedPayments,
      movedSessions: p.movedSessions,
    }));
  });

/**
 * Remap a user's opaque external id (docs/31). Moves the LIVE billing records — every
 * Payment row and any open (created/pending) checkout session — from `from` to `to`,
 * then appends the change to the history ledger. Past raw charges and emitted events
 * are immutable and keep their original id (AC3); the ledger IS the change history.
 *
 * The one-active-recurring-per-user index is the guard: if both ids already hold an
 * active recurring payment the remap would collide, surfaced as a `Conflict` (the
 * caller starts from a clean state). A rename that touches no live record is a
 * `NotFound` — the whole effect runs in a transaction, so it rolls back cleanly.
 * `externalUserId` is carried verbatim; only the owning id changes (AC9).
 */
/** Reject an empty id or a no-op (`from === to`); ids are carried verbatim, not trimmed. */
const validateCmd = (
  cmd: RenameExternalUserRequest,
): Effect.Effect<void, UnprocessableEntity> => {
  if (cmd.from.length === 0 || cmd.to.length === 0) {
    return Effect.fail(
      new UnprocessableEntity({ reason: 'from and to must be non-empty' }),
    );
  }
  if (cmd.from === cmd.to) {
    return Effect.fail(
      new UnprocessableEntity({ reason: 'from and to are identical' }),
    );
  }
  return Effect.void;
};

export const renameExternalUser =
  (deps: RenameDeps) =>
  (
    cmd: RenameExternalUserRequest,
    source: string,
  ): Effect.Effect<
    RenameAccepted,
    SqlError.SqlError | Conflict | NotFound | UnprocessableEntity
  > =>
    Effect.gen(function* () {
      yield* validateCmd(cmd);
      // Idempotent retry: a repeated identical rename replays its recorded result.
      const replay = yield* priorReplay(deps, cmd);
      if (Option.isSome(replay)) {
        return replay.value;
      }
      // Rename targets an UNUSED id. If `to` already owns billing records this would be
      // a merge — silently stacking two recurring payments under one user (the unique
      // index only catches the active+active case, not active+past_due) and risking a
      // double charge. Refuse it; merging two live users is a separate operation.
      const existingAtTarget = yield* deps.payments.findByExternalUser(cmd.to);
      if (existingAtTarget.length > 0) {
        return yield* Effect.fail(
          new Conflict({ field: 'target external user' }),
        );
      }
      const movedPayments = yield* deps.payments
        .renameExternalUser(cmd.from, cmd.to)
        .pipe(
          Effect.catchAll(
            onUniqueViolation(
              'active recurring payment for target external user',
            ),
          ),
        );
      const movedSessions = yield* deps.checkout.renameOpenSessionsExternalUser(
        cmd.from,
        cmd.to,
      );
      if (movedPayments + movedSessions === 0) {
        return yield* Effect.fail(
          new NotFound({
            resource: 'external user (no live records to remap)',
          }),
        );
      }
      yield* deps.ledger.append({
        fromExternalUserId: cmd.from,
        toExternalUserId: cmd.to,
        source,
        reason: cmd.reason ?? null,
        movedPayments,
        movedSessions,
      });
      return { from: cmd.from, to: cmd.to, movedPayments, movedSessions };
    });

/**
 * `external_user_id_changed` envelope (docs/31). `externalUserId` is the NEW id (the
 * go-forward contact); the id is deterministic on `from` → `to` so a redelivered
 * message dedupes in the outbox.
 */
export const externalUserIdChanged = (
  notify: ExternalUserIdChangeNotify,
  now: Date,
): ExternalUserIdChangedEvent => ({
  id: `evt_euidchg_${notify.from}_${notify.to}`,
  name: 'external_user_id_changed',
  occurredAt: now,
  correlationId: notify.to,
  externalUserId: notify.to,
  aggregateId: notify.to,
  payload: {
    from: notify.from,
    to: notify.to,
    movedPayments: notify.movedPayments,
    movedSessions: notify.movedSessions,
  },
});

/** The `external_user_id_change` handler: decode the payload, then emit the event. */
export const externalUserIdChangedNotify =
  (publish: (event: DomainEvent) => Effect.Effect<void, SqlError.SqlError>) =>
  (payload: unknown): Effect.Effect<void, SqlError.SqlError> =>
    Schema.decodeUnknown(ExternalUserIdChangeNotify)(payload).pipe(
      Effect.flatMap((notify) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((ms) =>
            publish(externalUserIdChanged(notify, new Date(ms))),
          ),
        ),
      ),
      Effect.catchTag('ParseError', (error) =>
        Effect.die(
          `invalid ${EXTERNAL_USER_ID_CHANGE} payload: ${error.message}`,
        ),
      ),
    );
