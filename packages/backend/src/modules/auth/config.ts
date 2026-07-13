import { Context, Layer } from 'effect';
import type { Redacted } from 'effect';

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
