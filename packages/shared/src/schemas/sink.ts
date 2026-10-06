import { Schema } from 'effect';

import { EventName } from '@/schemas/event.js';

/**
 * Sinks (docs/21). A sink is a downstream connector for outgoing domain events.
 * The persisted, operator-editable record is a discriminated union on a NUMERIC
 * `kind` (stored as a number, §5), carrying a pluggable `auth` strategy (its own
 * union on `AuthKind`) and a `config` whose shape is fixed per `kind`. A new sink
 * is a new `kind` + a new `config`/`auth` variant — no core change (AC8).
 */
export enum SinkKind {
  SendPulse = 0,
  /** 1 is RESERVED for the CRM sink written on `feat/one-time-payments-and-redirects`;
   * email takes 2 so the two lines do not collide on a stored numeric value. */
  Email = 2,
}

export const SinkKindSchema = Schema.Enums(SinkKind);

/**
 * Stable string code per kind — what `event_deliveries.sink` stores and what a
 * `SinkConnector` reports, so the outbox/delivery contract never learns the numeric
 * enum (mirrors `CurrencyCode`). Route paths use the code too.
 */
export const SinkKindCode: Readonly<Record<SinkKind, string>> = {
  [SinkKind.SendPulse]: 'sendpulse',
  [SinkKind.Email]: 'email',
};

const CodeToKind: Readonly<Record<string, SinkKind>> = {
  sendpulse: SinkKind.SendPulse,
  email: SinkKind.Email,
};

/** Resolve a route/delivery code back to its numeric kind; undefined if unknown. */
export const codeToKind = (code: string): SinkKind | undefined =>
  CodeToKind[code];

/** Auth strategy discriminant (numeric, stored). Extensible: OAuth, Basic, … later. */
export enum AuthKind {
  Bearer = 0,
}

export const AuthKindSchema = Schema.Enums(AuthKind);

/**
 * Bearer auth: a single token sent as `Authorization: Bearer <token>`. The token is
 * a secret — write-only via the API and never returned in a read shape. Stored as
 * plain text inside the `auth` jsonb (so it serializes), redacted at every log site.
 */
export const BearerAuth = Schema.Struct({
  kind: Schema.Literal(AuthKind.Bearer),
  token: Schema.String,
});

export type BearerAuth = Schema.Schema.Type<typeof BearerAuth>;

/** Sink auth, a discriminated union on `kind` (one strategy today). */
export const SinkAuth = Schema.Union(BearerAuth);

export type SinkAuth = Schema.Schema.Type<typeof SinkAuth>;

/** Public projection of auth — the strategy + whether a secret is set, never the secret. */
export const SinkAuthView = Schema.Struct({
  kind: AuthKindSchema,
  hasToken: Schema.Boolean,
});

export type SinkAuthView = Schema.Schema.Type<typeof SinkAuthView>;

/**
 * SendPulse config: a partial map of event name → SendPulse flow id. Only mapped
 * events run a flow; keys are the external event names (the wire vocabulary).
 */
export const SinkFlowMap = Schema.partial(
  Schema.Record({ key: EventName, value: Schema.String }),
);

export type SinkFlowMap = Schema.Schema.Type<typeof SinkFlowMap>;

export const SendPulseConfig = Schema.Struct({
  flows: SinkFlowMap,
});

/**
 * Email sink config. The SendPulse REST API authenticates with an OAuth
 * client-credentials PAIR, but only the secret is a secret — so `clientId` lives here
 * in plain config while the client secret reuses the existing `auth.token` slot. That
 * keeps the write-only-secret handling (`toView`, `mergeAuth`) working unchanged
 * instead of widening the auth union for one sink.
 *
 * `events` is the declared scope of the channel: an event outside it is not a message
 * this sink sends, which is a decision rather than a silent drop. `from.email` must be
 * on a domain whose DKIM is verified in SendPulse, or mail is signed by nothing.
 */
export const EmailConfig = Schema.Struct({
  clientId: Schema.String,
  from: Schema.Struct({ name: Schema.String, email: Schema.String }),
  replyTo: Schema.optionalWith(Schema.String, { default: () => '' }),
  events: Schema.Array(EventName),
});

export type EmailConfig = Schema.Schema.Type<typeof EmailConfig>;

export type SendPulseConfig = Schema.Schema.Type<typeof SendPulseConfig>;

/** The persisted sink entity (DU on `kind`). `auth`/`config` are jsonb at rest. */
export const SendPulseSink = Schema.Struct({
  kind: Schema.Literal(SinkKind.SendPulse),
  enabled: Schema.Boolean,
  auth: SinkAuth,
  config: SendPulseConfig,
  updatedAt: Schema.Date,
});

export type SendPulseSink = Schema.Schema.Type<typeof SendPulseSink>;

export const EmailSink = Schema.Struct({
  kind: Schema.Literal(SinkKind.Email),
  enabled: Schema.Boolean,
  auth: SinkAuth,
  config: EmailConfig,
  updatedAt: Schema.Date,
});

export type EmailSink = Schema.Schema.Type<typeof EmailSink>;

export const Sink = Schema.Union(SendPulseSink, EmailSink);

export type Sink = Schema.Schema.Type<typeof Sink>;

/** Public read shape (DU on `kind`): the entity with `auth` projected (token stripped). */
export const SendPulseSinkView = Schema.Struct({
  kind: Schema.Literal(SinkKind.SendPulse),
  enabled: Schema.Boolean,
  auth: SinkAuthView,
  config: SendPulseConfig,
  updatedAt: Schema.Date,
});

export const EmailSinkView = Schema.Struct({
  kind: Schema.Literal(SinkKind.Email),
  enabled: Schema.Boolean,
  auth: SinkAuthView,
  config: EmailConfig,
  updatedAt: Schema.Date,
});

export type SendPulseSinkView = Schema.Schema.Type<typeof SendPulseSinkView>;

export const SinkView = Schema.Union(SendPulseSinkView, EmailSinkView);

export type SinkView = Schema.Schema.Type<typeof SinkView>;

/**
 * Operator update (write). `auth.token` is optional — absent/empty keeps the stored
 * token (write-only). One kind today, so a flat struct; widen to a DU per new kind.
 */
export const UpdateSinkRequest = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  auth: Schema.optional(
    Schema.Struct({
      kind: AuthKindSchema,
      token: Schema.optional(Schema.String),
    }),
  ),
  config: Schema.optional(Schema.Union(SendPulseConfig, EmailConfig)),
});

export type UpdateSinkRequest = Schema.Schema.Type<typeof UpdateSinkRequest>;

/** One selectable flow for the operator picker (from SendPulse `GET /flows`). */
export const SinkFlow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  botName: Schema.String,
});

export type SinkFlow = Schema.Schema.Type<typeof SinkFlow>;

export const SinkFlowsResponse = Schema.Array(SinkFlow);

export type SinkFlowsResponse = Schema.Schema.Type<typeof SinkFlowsResponse>;
