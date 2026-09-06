import { SqlClient } from '@effect/sql';
import {
  RenameAccepted,
  RenameExternalUserRequest,
} from '@billing-service/shared';
import { Effect } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { extractBearer } from '@/infra/http/bearer.js';
import { Unauthorized } from '@/infra/http/errors.js';
import { makeRoute } from '@/infra/http/route.js';
import { enqueue } from '@/infra/queue/store.js';
import { authenticateToken } from '@/modules/auth/domain.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { EXTERNAL_USER_ID_CHANGE } from '@/modules/identity/contracts.js';
import { makeExternalUserIdChangeRepo } from '@/modules/identity/data-access.js';
import {
  renameExternalUser,
  type RenameDeps,
} from '@/modules/identity/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';

const route = makeRoute((app: FastifyInstance) => app.runtime);

/** The external system authenticates with a service token (same surface as card-change). */
const serviceActor = (request: FastifyRequest) => {
  const presented = extractBearer(request);
  return presented === null
    ? Effect.fail(new Unauthorized({ reason: 'missing bearer token' }))
    : authenticateToken(presented);
};

/** Enqueue the opt-in `external_user_id_changed` notify (docs/31). A deterministic
 * idemKey dedupes a retried rename, so the event fires exactly once. */
const enqueueChange = (sql: SqlClient.SqlClient, result: RenameAccepted) =>
  enqueue(sql)({
    messageType: EXTERNAL_USER_ID_CHANGE,
    idemKey: `euidchg:${result.from}|${result.to}`,
    payload: {
      from: result.from,
      to: result.to,
      movedPayments: result.movedPayments,
      movedSessions: result.movedSessions,
    },
  }).pipe(Effect.asVoid);

/**
 * Remap a user's opaque external id (docs/31). The whole remap + ledger append (and the
 * opt-in notify enqueue) runs in one transaction, so a conflict or empty match rolls back
 * with nothing moved and no event. Events fire only when the caller sets `refireEvents`.
 */
const rename = (input: RenameExternalUserRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    const sql = yield* SqlClient.SqlClient;
    const deps: RenameDeps = {
      payments: makePaymentRepo(sql),
      checkout: makeCheckoutRepo(sql),
      ledger: makeExternalUserIdChangeRepo(sql),
    };
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const result = yield* renameExternalUser(deps)(input, 'service');
        if (input.refireEvents === true) {
          yield* enqueueChange(sql, result);
        }
        return result;
      }),
    );
  });

export default function identity(fastify: FastifyInstance): void {
  route(fastify, {
    method: 'POST',
    path: '/api/payment/rename-external-user',
    input: RenameExternalUserRequest,
    output: RenameAccepted,
    handler: rename,
  });
}
