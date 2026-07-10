import { Context, Layer } from 'effect';
import type { Redacted } from 'effect';

/**
 * AuthConfig — the auth module's slice of application config, injected as an
 * Effect dependency (not read from `process.env` inside the domain). This keeps
 * `domain.ts` pure of config plumbing and trivially testable with a fake layer.
 */
export interface AuthConfigService {
  /** Bootstrap admin credential (from env `ADMIN_TOKEN`); never stored in the DB. */
  readonly adminToken: Redacted.Redacted;
  /** Session lifetime in seconds. */
  readonly sessionTtlSeconds: number;
}

export class AuthConfig extends Context.Tag('AuthConfig')<
  AuthConfig,
  AuthConfigService
>() {}

export const makeAuthConfig = (
  config: AuthConfigService,
): Layer.Layer<AuthConfig> => Layer.succeed(AuthConfig, config);
