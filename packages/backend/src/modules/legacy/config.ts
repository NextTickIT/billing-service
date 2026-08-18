import { Context, Layer, type Redacted } from 'effect';

/**
 * SendPulse CRM credentials + endpoint for the legacy import, injected as an Effect
 * dependency so the client never reads `process.env` (the `wayforpay` config pattern).
 * Auth is a static Bearer token (`SENDPULSE_API_TOKEN`) — SendPulse issues no refresh
 * flow — so the client carries no token cache.
 */
export interface SpConfigService {
  readonly apiToken: Redacted.Redacted;
  /** CRM base URL (default `https://api.sendpulse.com`). */
  readonly apiUrl: string;
  /** Client-side request rate (req/s); its own limiter, not WayForPay's. */
  readonly rateLimitRps: number;
}

export class SpConfig extends Context.Tag('SpConfig')<
  SpConfig,
  SpConfigService
>() {}

export const makeSpConfig = (config: SpConfigService): Layer.Layer<SpConfig> =>
  Layer.succeed(SpConfig, config);
