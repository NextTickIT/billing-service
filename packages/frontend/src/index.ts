import type { Subscription } from '@billing-service/shared';

/**
 * Placeholder package. It exists only to prove the shared TS / lint / config
 * resolves across all three packages and that the `shared` contract types are
 * importable here without transformation. No framework, no app.
 */
export const describeSubscription = (subscription: Subscription): string =>
  subscription.externalUserId;
