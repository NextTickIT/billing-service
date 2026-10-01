import { Data } from 'effect';

import type { HttpReply } from '@/infra/http/reply.js';

export class Unauthorized extends Data.TaggedError('Unauthorized')<{
  readonly reason: string;
}> {
  toHttp(): HttpReply {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
}

export class Forbidden extends Data.TaggedError('Forbidden')<{
  readonly reason: string;
}> {
  toHttp(): HttpReply {
    return { status: 403, body: { error: 'Forbidden' } };
  }
}

export class InvalidCredentials extends Data.TaggedError('InvalidCredentials')<{
  readonly reason: string;
}> {
  toHttp(): HttpReply {
    return { status: 401, body: { error: 'Invalid credentials' } };
  }
}

export class Conflict extends Data.TaggedError('Conflict')<{
  readonly field: string;
}> {
  toHttp(): HttpReply {
    return {
      status: 409,
      body: { error: `Conflict: ${this.field} already exists` },
    };
  }
}

/**
 * The buyer already has a live subscription, so this checkout must not be paid again.
 * Distinct from {@link Conflict} because the page has to say something different: a
 * paying customer told "this link is no longer valid" reads it as us being broken.
 * `code` is what the frontend branches on — never the prose.
 */
export class AlreadySubscribed extends Data.TaggedError('AlreadySubscribed')<{
  readonly externalUserId: string;
}> {
  toHttp(): HttpReply {
    return {
      status: 409,
      body: {
        error: 'already subscribed',
        code: 'already_subscribed',
      },
    };
  }
}

export class NotFound extends Data.TaggedError('NotFound')<{
  readonly resource: string;
}> {
  toHttp(): HttpReply {
    return { status: 404, body: { error: `${this.resource} not found` } };
  }
}

export class UnprocessableEntity extends Data.TaggedError(
  'UnprocessableEntity',
)<{
  readonly reason: string;
}> {
  toHttp(): HttpReply {
    return { status: 422, body: { error: this.reason } };
  }
}

/**
 * A card- or method-change was requested for a payment that cannot be changed (docs/23,
 * docs/32): a cancelled payment, no payment at all, or a proactive verify while the
 * standalone Card Verify method is not enabled. 409 → the caller starts a fresh checkout.
 */
export class ChangeUnavailable extends Data.TaggedError('ChangeUnavailable')<{
  readonly reason: string;
}> {
  toHttp(): HttpReply {
    return { status: 409, body: { error: this.reason } };
  }
}
