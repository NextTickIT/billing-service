import type { SqlError } from '@effect/sql';
import {
  type RenameAccepted,
  type RenameExternalUserRequest,
} from '@billing-service/shared';
import { Effect } from 'effect';

import { onUniqueViolation } from '@/infra/db/pg-errors.js';
import type { Conflict } from '@/infra/http/errors.js';
import { NotFound, UnprocessableEntity } from '@/infra/http/errors.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import type { ExternalUserIdChangeRepo } from '@/modules/identity/data-access.js';

export interface RenameDeps {
  readonly payments: PaymentRepo;
  readonly checkout: CheckoutRepo;
  readonly ledger: ExternalUserIdChangeRepo;
}

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
      if (cmd.from.length === 0 || cmd.to.length === 0) {
        return yield* Effect.fail(
          new UnprocessableEntity({ reason: 'from and to must be non-empty' }),
        );
      }
      if (cmd.from === cmd.to) {
        return yield* Effect.fail(
          new UnprocessableEntity({ reason: 'from and to are identical' }),
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
