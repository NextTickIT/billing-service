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
  /** The CRM's own event feed — one source of truth for what billing did (docs/21). */
  Crm = 1,
}

export const SinkKindSchema = Schema.Enums(SinkKind);

/**
 * Stable string code per kind — what `event_deliveries.sink` stores and what a
 * `SinkConnector` reports, so the outbox/delivery contract never learns the numeric
 * enum (mirrors `CurrencyCode`). Route paths use the code too.
 */
export const SinkKindCode: Readonly<Record<SinkKind, string>> = {
  [SinkKind.SendPulse]: 'sendpulse',
  [SinkKind.Crm]: 'crm',
};

const CodeToKind: Readonly<Record<string, SinkKind>> = {
  sendpulse: SinkKind.SendPulse,
  crm: SinkKind.Crm,
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

export type SendPulseConfig = Schema.Schema.Type<typeof SendPulseConfig>;

/**
 * CRM config: just where to POST. No flow map — unlike SendPulse, which runs a chosen
 * automation per event and so needs an explicit opt-in per name, the CRM is the system of
 * record and wants EVERY event. Making it opt-in per event would mean an event we add
 * later silently never reaches the one consumer whose job is to have all of them.
 *
 * `url` is the full ingest endpoint. Empty disables delivery even if the row is enabled —
 * the seeded row has no URL, so turning the sink on before pointing it somewhere cannot
 * start dead-lettering every event.
 */
export const CrmConfig = Schema.Struct({
  url: Schema.String,
});

export type CrmConfig = Schema.Schema.Type<typeof CrmConfig>;

/** Either sink's config, for the one update body the `:code` route accepts. */
export const SinkConfig = Schema.Union(SendPulseConfig, CrmConfig);

export type SinkConfig = Schema.Schema.Type<typeof SinkConfig>;

/** The persisted sink entity (DU on `kind`). `auth`/`config` are jsonb at rest. */
export const SendPulseSink = Schema.Struct({
  kind: Schema.Literal(SinkKind.SendPulse),
  enabled: Schema.Boolean,
  auth: SinkAuth,
  config: SendPulseConfig,
  updatedAt: Schema.Date,
});

export type SendPulseSink = Schema.Schema.Type<typeof SendPulseSink>;

export const CrmSink = Schema.Struct({
  kind: Schema.Literal(SinkKind.Crm),
  enabled: Schema.Boolean,
  auth: SinkAuth,
  config: CrmConfig,
  updatedAt: Schema.Date,
});

export type CrmSink = Schema.Schema.Type<typeof CrmSink>;

export const Sink = Schema.Union(SendPulseSink, CrmSink);

export type Sink = Schema.Schema.Type<typeof Sink>;

/** Public read shape (DU on `kind`): the entity with `auth` projected (token stripped). */
export const SendPulseSinkView = Schema.Struct({
  kind: Schema.Literal(SinkKind.SendPulse),
  enabled: Schema.Boolean,
  auth: SinkAuthView,
  config: SendPulseConfig,
  updatedAt: Schema.Date,
});

export type SendPulseSinkView = Schema.Schema.Type<typeof SendPulseSinkView>;

export const CrmSinkView = Schema.Struct({
  kind: Schema.Literal(SinkKind.Crm),
  enabled: Schema.Boolean,
  auth: SinkAuthView,
  config: CrmConfig,
  updatedAt: Schema.Date,
});

export type CrmSinkView = Schema.Schema.Type<typeof CrmSinkView>;

export const SinkView = Schema.Union(SendPulseSinkView, CrmSinkView);

export type SinkView = Schema.Schema.Type<typeof SinkView>;

/**
 * Operator update (write). `auth.token` is optional — absent/empty keeps the stored
 * token (write-only).
 *
 * `config` is the UNION of the per-kind shapes rather than a discriminated union: the
 * kind comes from the `:code` path segment, not the body, so there is no discriminant
 * here to narrow on. The domain therefore checks the supplied config against the stored
 * sink's kind and rejects a mismatch — a `flows` map must not land on the CRM row, where
 * nothing would read it and the operator would believe they had configured something.
 */
export const UpdateSinkRequest = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  auth: Schema.optional(
    Schema.Struct({
      kind: AuthKindSchema,
      token: Schema.optional(Schema.String),
    }),
  ),
  config: Schema.optional(SinkConfig),
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
