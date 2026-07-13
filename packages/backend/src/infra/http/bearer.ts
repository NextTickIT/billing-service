import { Redacted } from 'effect';
import type { FastifyRequest } from 'fastify';

const BEARER_PREFIX = 'Bearer ';

/** Pull a `Bearer <token>` credential off a request, or null if absent/empty. The
 * token stays wrapped in `Redacted` so it never leaks into logs. */
export const extractBearer = (
  request: FastifyRequest,
): Redacted.Redacted | null => {
  const header = request.headers.authorization;
  if (header?.startsWith(BEARER_PREFIX) !== true) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length === 0 ? null : Redacted.make(token);
};
