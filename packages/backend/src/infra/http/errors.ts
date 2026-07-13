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
