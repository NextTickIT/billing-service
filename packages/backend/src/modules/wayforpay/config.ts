import { Context, Layer, type Redacted } from 'effect';

/**
 * WayForPay credentials + endpoints, injected as an Effect dependency so the
 * client never reads `process.env` — declared next to the client that consumes it
 * (the auth module's config pattern). `merchantPassword` is for regularApi
 * (subscription STATUS) and is empty until that credential is provisioned.
 */
export interface W4pConfigService {
  readonly merchantAccount: string;
  readonly merchantSecretKey: Redacted.Redacted;
  readonly merchantPassword: Redacted.Redacted;
  /** `/api` endpoint (TRANSACTION_LIST, CHECK_STATUS, CHARGE). */
  readonly apiUrl: string;
  /** `/regularApi` endpoint (subscription STATUS). */
  readonly regularApiUrl: string;
  /** Merchant domain, part of the Purchase/CHARGE signature (M5/M6). */
  readonly merchantDomainName: string;
}

export class W4pConfig extends Context.Tag('W4pConfig')<
  W4pConfig,
  W4pConfigService
>() {}

export const makeW4pConfig = (
  config: W4pConfigService,
): Layer.Layer<W4pConfig> => Layer.succeed(W4pConfig, config);
