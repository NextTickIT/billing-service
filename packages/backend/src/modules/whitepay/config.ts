import { Context, Layer, type Redacted } from 'effect';

/**
 * WhitePay credentials + endpoints, injected as an Effect dependency so the client
 * never reads `process.env` (the auth/W4P config pattern). Three credentials (docs/25):
 * `slug` addresses the payment page in the create-order path, `apiToken` is the Bearer
 * for outbound calls, `webhookToken` keys the inbound HMAC-SHA256.
 */
export interface WhitePayConfigService {
  readonly slug: string;
  readonly apiToken: Redacted.Redacted;
  readonly webhookToken: Redacted.Redacted;
  /** API base; create-order posts to `${apiUrl}/private-api/crypto-orders/{slug}`. */
  readonly apiUrl: string;
  /** Browser redirect targets (templated on `{sessionId}`) sent with a create-order. */
  readonly successfulLink: string;
  readonly failureLink: string;
}

export class WhitePayConfig extends Context.Tag('WhitePayConfig')<
  WhitePayConfig,
  WhitePayConfigService
>() {}

export const makeWhitePayConfig = (
  config: WhitePayConfigService,
): Layer.Layer<WhitePayConfig> => Layer.succeed(WhitePayConfig, config);
