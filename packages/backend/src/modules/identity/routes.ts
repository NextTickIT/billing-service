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
import { authenticateToken } from '@/modules/auth/domain.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
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

/**
 * Remap a user's opaque external id (docs/31). The whole remap + ledger append runs in
 * one transaction, so a conflict or an empty match rolls back with nothing moved.
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
      renameExternalUser(deps)(input, 'service'),
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
