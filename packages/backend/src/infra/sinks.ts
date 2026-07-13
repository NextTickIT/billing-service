import type { DomainEvent } from '@billing-service/shared';
import { Context, Data, Effect, Layer } from 'effect';

/**
 * Sink — a downstream consumer of outgoing events (docs/03: "sync connector").
 * The outbox owns durability and retries; a sink only has to attempt one delivery
 * and be idempotent on its side. A new sink (SendPulse, …) is a new `Sink` in the
 * `Sinks` set — no core change (AC8).
 */
export class SinkError extends Data.TaggedError('SinkError')<{
  readonly sink: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export interface Sink {
  readonly name: string;
  readonly deliver: (event: DomainEvent) => Effect.Effect<void, SinkError>;
}

/** The connected sinks. The outbox fans an event out to one delivery per sink. */
export interface SinksService {
  readonly all: () => Effect.Effect<readonly Sink[]>;
}

export class Sinks extends Context.Tag('Sinks')<Sinks, SinksService>() {}

/**
 * The MVP sink: log-and-succeed. Proves the whole outbox path end to end without
 * the SendPulse dependency (interview decision: stub sink now, SendPulse later).
 * Named `sendpulse` so the delivery records already carry the eventual target and
 * swapping in the real connector needs no data migration.
 */
export const loggingSink: Sink = {
  name: 'sendpulse',
  deliver: (event) =>
    Effect.logInfo('sink delivery (logging)').pipe(
      Effect.annotateLogs({
        sink: 'sendpulse',
        event: event.name,
        eventId: event.id,
      }),
    ),
};

export const LoggingSinkLive = Layer.succeed(Sinks, {
  all: () => Effect.succeed([loggingSink]),
});
