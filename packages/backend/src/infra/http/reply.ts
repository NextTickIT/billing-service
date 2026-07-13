/** A transport-level HTTP reply: a status code plus an already-serializable body. */
export interface HttpReply {
  readonly status: number;
  readonly body: unknown;
}

/** An error that knows how to render itself as an HTTP reply. */
export interface HttpRenderable {
  readonly toHttp: () => HttpReply;
}

const isRenderable = (error: unknown): error is HttpRenderable =>
  typeof error === 'object' &&
  error !== null &&
  'toHttp' in error &&
  typeof (error as HttpRenderable).toHttp === 'function';

/**
 * The single, consistent error->reply transform: an error renders itself, or
 * anything unmapped (SqlError, HashError, a thrown defect) collapses to 500.
 */
export const toHttp = (error: unknown): HttpReply =>
  isRenderable(error)
    ? error.toHttp()
    : { status: 500, body: { error: 'Internal Server Error' } };
