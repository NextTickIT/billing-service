import { Redacted } from 'effect';
import type { FastifyRequest } from 'fastify';

import { Unauthorized } from '@/infra/http/errors.js';

/**
 * Assert the shared BFF secret header on BFF-proxied routes (F-C). Applied
 * per-route on the explicit allowlist: `/api/payment*`, `/api/quarantine*`,
 * public checkout session-read and pay. Not applied to the provider callback
 * (WayForPay cannot send it) or `POST /api/checkout-sessions` (SendPulse calls
 * the backend directly with a service token) or `/health`.
 *
 * When `BFF_SECRET` env is unset the gate is disabled so dev/test environments
 * work without configuration.
 */
export const assertBffSecret = (request: FastifyRequest): void => {
  const secret = Redacted.value(request.server.appConfig.bffSecret);
  if (secret.length === 0) {
    return; // gate disabled in dev/test
  }
  const presented = request.headers['x-bff-secret'];
  if (presented !== secret) {
    throw new Unauthorized({ reason: 'missing or invalid BFF secret' });
  }
};
