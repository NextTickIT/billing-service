import { Effect } from 'effect';
import type { FastifyRequest } from 'fastify';

import { extractBearer } from '@/infra/http/bearer.js';
import { Unauthorized } from '@/infra/http/errors.js';
import { authenticateToken } from '@/modules/auth/domain.js';

/** An external system (the CRM, SendPulse) authenticating with its service token. One
 * resolver for every route that takes that credential, so they cannot drift. */
export const serviceActor = (request: FastifyRequest) => {
  const presented = extractBearer(request);
  return presented === null
    ? Effect.fail(new Unauthorized({ reason: 'missing bearer token' }))
    : authenticateToken(presented);
};
