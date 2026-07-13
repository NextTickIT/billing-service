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
