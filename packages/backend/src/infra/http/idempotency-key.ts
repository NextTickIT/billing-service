import { Effect } from 'effect';
import type { FastifyRequest } from 'fastify';

import { UnprocessableEntity } from '@/infra/http/errors.js';

/**
 * The `Idempotency-Key` request header: how a caller opts a mutating endpoint into
 * dedup. Kept here so every endpoint reads and bounds it the same way. Fastify lowercases
 * header names; a repeated header arrives as an array and is treated as absent (a caller
 * bug, not a key).
 */
const HEADER = 'idempotency-key';
const MAX_LEN = 200;

const rawKey = (request: FastifyRequest): string | undefined => {
  const value = request.headers[HEADER];
  return typeof value === 'string' ? value : undefined;
};

/** The Idempotency-Key, normalized: a present non-empty value, else null (no dedup). */
export const idempotencyKeyOf = (request: FastifyRequest): string | null => {
  const key = rawKey(request);
  return key !== undefined && key.length > 0 ? key : null;
};

/** Reject an oversized key (422) rather than persist an unbounded string. */
export const assertIdempotencyKey = (
  request: FastifyRequest,
): Effect.Effect<void, UnprocessableEntity> => {
  const key = rawKey(request);
  return key !== undefined && key.length > MAX_LEN
    ? Effect.fail(
        new UnprocessableEntity({
          reason: `Idempotency-Key too long (max ${MAX_LEN.toString()})`,
        }),
      )
    : Effect.void;
};
