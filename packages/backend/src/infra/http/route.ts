import { Effect, Either, Schema } from 'effect';
import type { ManagedRuntime } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { toHttp, type HttpReply } from '@/infra/http/reply.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * One route declared in one place: its method + path, the input schema that
 * decodes the body into a domain command, the output schema that encodes the
 * result, and an Effect handler over the runtime's services `R`.
 */
export interface RouteDef<In, InEnc, Out, OutEnc, R> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly input: Schema.Schema<In, InEnc>;
  readonly output: Schema.Schema<Out, OutEnc>;
  /** Success status for a handled request (default 200). */
  readonly status?: number;
  readonly handler: (
    input: In,
    request: FastifyRequest,
  ) => Effect.Effect<Out, unknown, R>;
}

const INVALID_BODY: HttpReply = {
  status: 400,
  body: { error: 'Invalid request body' },
};

/**
 * Binds the route helper to a single Effect runtime (e.g. the DB-backed one).
 * The returned `route(fastify, def)` decodes the body (400 on a schema miss),
 * runs the handler on that runtime, encodes the result, and maps every failure
 * through the one consistent `toHttp` transform. Reused by any module whose
 * handlers run on `runtimeOf`.
 */
export const makeRoute =
  <R, ER>(
    runtimeOf: (app: FastifyInstance) => ManagedRuntime.ManagedRuntime<R, ER>,
  ) =>
  <In, InEnc, Out, OutEnc>(
    fastify: FastifyInstance,
    def: RouteDef<In, InEnc, Out, OutEnc, R>,
  ): void => {
    fastify.route({
      method: def.method,
      url: def.path,
      handler: async (request, reply) => {
        const decoded = Schema.decodeUnknownEither(def.input)(request.body);
        const result: HttpReply = Either.isLeft(decoded)
          ? INVALID_BODY
          : await runtimeOf(request.server).runPromise(
              def.handler(decoded.right, request).pipe(
                Effect.flatMap((out) => Schema.encode(def.output)(out)),
                Effect.map((body): HttpReply => ({
                  status: def.status ?? 200,
                  body,
                })),
                Effect.catchAll((error) => Effect.succeed(toHttp(error))),
              ),
            );
        reply.status(result.status).send(result.body);
      },
    });
  };
