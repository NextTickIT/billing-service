import { Data } from 'effect';

/**
 * Typed auth failures (no `throw`). They flow through the Effect error channel
 * and are mapped to HTTP status codes at the route boundary. Kept in their own
 * module so both `domain.ts` (raises them) and `data-access.ts` (maps a unique
 * violation to `Conflict`) can import them without a cycle.
 */

/** Missing/invalid credential (e.g. bad admin bearer token). -> HTTP 401. */
export class Unauthorized extends Data.TaggedError('Unauthorized')<{
  readonly reason: string;
}> {}

/** Authenticated but lacking the required role. -> HTTP 403. */
export class Forbidden extends Data.TaggedError('Forbidden')<{
  readonly reason: string;
}> {}

/** Wrong login/password on sign-in (never reveals which). -> HTTP 401. */
export class InvalidCredentials extends Data.TaggedError('InvalidCredentials')<{
  readonly reason: string;
}> {}

/** Uniqueness violation (duplicate login/alias). -> HTTP 409. */
export class Conflict extends Data.TaggedError('Conflict')<{
  readonly field: string;
}> {}

export type AuthError =
  Unauthorized | Forbidden | InvalidCredentials | Conflict;
