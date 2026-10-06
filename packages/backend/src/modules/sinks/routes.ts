import { SqlClient } from '@effect/sql';
import {
  Role,
  SinkFlowsResponse,
  SinkKind,
  SinkView,
  UpdateSinkRequest,
  codeToKind,
} from '@billing-service/shared';
import type { Sink } from '@billing-service/shared';
import { Effect, Option, Redacted, Schema } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { assertBffSecret } from '@/infra/http/bff-secret.js';
import { extractBearer } from '@/infra/http/bearer.js';
import {
  NotFound,
  Unauthorized,
  UnprocessableEntity,
} from '@/infra/http/errors.js';
import { makeRateLimiter } from '@/infra/rate-limiter.js';
import { makeRoute } from '@/infra/http/route.js';
import { authenticate, requireRole } from '@/modules/auth/domain.js';
import { makeChargeRepo } from '@/modules/charge/data-access.js';
import { makeSinksRepo } from '@/modules/sinks/data-access.js';
import { mergeUpdate, toView } from '@/modules/sinks/domain.js';
import { isReceiptable } from '@/modules/sinks/receipt.js';
import { listFlows } from '@/modules/sinks/sendpulse.js';

type UpdateBody = Schema.Schema.Type<typeof UpdateSinkRequest>;

const route = makeRoute((app: FastifyInstance) => app.runtime);

/** Operator credential: session token → Operator role (mirrors quarantine/routes). */
const operatorActor = (request: FastifyRequest) => {
  const presented = extractBearer(request);
  if (presented === null) {
    return Effect.fail(new Unauthorized({ reason: 'missing bearer token' }));
  }
  return authenticate(Redacted.value(presented)).pipe(
    Effect.mapError(() => new Unauthorized({ reason: 'invalid session' })),
    Effect.flatMap((session) =>
      requireRole({ role: session.role }, Role.Operator).pipe(
        Effect.as({ role: session.role }),
      ),
    ),
  );
};

const readCode = (request: FastifyRequest): string =>
  (request.params as { readonly code: string }).code;

const list = (_input: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    yield* operatorActor(request);
    const sql = yield* SqlClient.SqlClient;
    const sinks = yield* makeSinksRepo(sql).listWithSecret();
    return sinks.map(toView);
  });

/**
 * Refuse an email sink that cannot actually deliver.
 *
 * Both checks exist because the alternative is silent and permanent. An event with no
 * template is in scope for the channel but renders to nothing, so every occurrence
 * hard-fails and dead-letters — and a dead letter is terminal, there is no requeue. Blank
 * credentials do the same thing on the first send. The seeded row ships disabled with
 * empty credentials by design, so the moment to catch this is the operator enabling it.
 */
const assertEmailDeliverable = (
  sink: Sink,
): Effect.Effect<void, UnprocessableEntity> => {
  if (sink.kind !== SinkKind.Email || !sink.enabled) {
    return Effect.void;
  }
  const untemplated = sink.config.events.filter((e) => !isReceiptable(e));
  if (untemplated.length > 0) {
    return Effect.fail(
      new UnprocessableEntity({
        reason: `no receipt template for: ${untemplated.join(', ')}`,
      }),
    );
  }
  const missing = [
    sink.config.clientId === '' ? 'clientId' : null,
    sink.auth.token === '' ? 'auth.token' : null,
    sink.config.from.email === '' ? 'from.email' : null,
  ].filter((v): v is string => v !== null);
  return missing.length > 0
    ? Effect.fail(
        new UnprocessableEntity({
          reason: `cannot enable the email sink without: ${missing.join(', ')}`,
        }),
      )
    : Effect.void;
};

const update = (body: UpdateBody, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    const actor = yield* operatorActor(request);
    const kind = codeToKind(readCode(request));
    if (kind === undefined) {
      return yield* Effect.fail(new NotFound({ resource: 'sink' }));
    }
    const sql = yield* SqlClient.SqlClient;
    const repo = makeSinksRepo(sql);
    const found = yield* repo.getWithSecret(kind);
    if (Option.isNone(found)) {
      return yield* Effect.fail(new NotFound({ resource: 'sink' }));
    }
    const merged = mergeUpdate(found.value, body);
    yield* assertEmailDeliverable(merged);
    yield* repo.write(merged);
    yield* makeChargeRepo(sql).insertAudit({
      actor: Role[actor.role],
      action: 'update_sink',
      targetType: 'sink',
      targetId: readCode(request),
      detail: {
        enabled: merged.enabled,
        tokenSet: merged.auth.token.length > 0,
        // Per-kind: a flow map for the chatbot sink, the declared event scope for email.
        ...('flows' in merged.config
          ? { flows: Object.keys(merged.config.flows) }
          : { events: merged.config.events }),
      },
    });
    return toView(merged);
  });

const flows = (_input: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    yield* operatorActor(request);
    const kind = codeToKind(readCode(request));
    if (kind === undefined) {
      return yield* Effect.fail(new NotFound({ resource: 'sink' }));
    }
    const sql = yield* SqlClient.SqlClient;
    const found = yield* makeSinksRepo(sql).getWithSecret(kind);
    if (Option.isNone(found)) {
      return yield* Effect.fail(new NotFound({ resource: 'sink' }));
    }
    const token = found.value.auth.token;
    if (token.length === 0) {
      return yield* Effect.fail(
        new UnprocessableEntity({ reason: 'sink token not set' }),
      );
    }
    const sp = request.server.appConfig.sinks.sendpulse;
    const rateLimiter = yield* makeRateLimiter(sp.rateLimitRps);
    return yield* listFlows({
      token,
      apiUrl: sp.apiUrl,
      fetch: (url, init) => globalThis.fetch(url, init),
      rateLimiter,
    }).pipe(
      Effect.mapError(
        () =>
          new UnprocessableEntity({
            reason: 'could not list SendPulse flows (check the token)',
          }),
      ),
    );
  });

export default function sinks(fastify: FastifyInstance): void {
  route(fastify, {
    method: 'GET',
    path: '/api/sinks',
    input: Schema.Unknown,
    output: Schema.Array(SinkView),
    handler: list,
  });

  route(fastify, {
    method: 'PUT',
    path: '/api/sinks/:code',
    input: UpdateSinkRequest,
    output: SinkView,
    handler: update,
  });

  route(fastify, {
    method: 'GET',
    path: '/api/sinks/:code/flows',
    input: Schema.Unknown,
    output: SinkFlowsResponse,
    handler: flows,
  });
}
