import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import * as argon2 from 'argon2';
import { Context, Data, Effect, Layer, Redacted } from 'effect';

/** Failure hashing/verifying a password (argon2 backend error). */
export class HashError extends Data.TaggedError('HashError')<{
  readonly cause: unknown;
}> {}

/**
 * A freshly minted secret: `plaintext` is returned to the caller exactly once;
 * `hash` (SHA-256) is what gets stored.
 */
export interface GeneratedToken {
  readonly plaintext: string;
  readonly hash: string;
}

/**
 * Hasher — the cryptographic dependency the auth domain relies on. It is
 * injected via Effect DI and is the ONLY place `argon2`/`node:crypto` are
 * imported; `domain.ts` never touches them directly. Passwords use argon2id;
 * opaque API/session tokens use SHA-256 compared with `timingSafeEqual`.
 */
export interface HasherService {
  readonly hashPassword: (
    password: Redacted.Redacted,
  ) => Effect.Effect<string, HashError>;
  readonly verifyPassword: (
    hash: string,
    password: Redacted.Redacted,
  ) => Effect.Effect<boolean, HashError>;
  /** Constant-time decoy verify for unknown logins (anti-enumeration). */
  readonly dummyVerifyPassword: (
    password: Redacted.Redacted,
  ) => Effect.Effect<void, HashError>;
  /** Generate an opaque token `${prefix}${random}` plus its SHA-256 hash. */
  readonly generateToken: (prefix: string) => Effect.Effect<GeneratedToken>;
  /** SHA-256 hex of a token plaintext (deterministic). */
  readonly hashToken: (plaintext: string) => string;
  /** Constant-time compare of a plaintext against a stored SHA-256 hex. */
  readonly verifyToken: (hash: string, plaintext: string) => boolean;
}

export class Hasher extends Context.Tag('Hasher')<Hasher, HasherService>() {}

// A constant, valid argon2id digest used only to spend ~one verify's worth of
// time on unknown logins, so response timing never reveals whether a login
// exists. Not a secret (it hashes a throwaway constant).
const DUMMY_DIGEST =
  '$argon2id$v=19$m=65536,t=3,p=4$0ov/BADGzpWRvyxtgY7SVw$87kjzlclyU+DcZa4DOwOuyQeAV2jLQ6Cof5B4RQnnhQ';

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const hashPassword = (
  password: Redacted.Redacted,
): Effect.Effect<string, HashError> =>
  Effect.tryPromise({
    try: () => argon2.hash(Redacted.value(password), { type: argon2.argon2id }),
    catch: (cause) => new HashError({ cause }),
  });

const verifyPassword = (
  hash: string,
  password: Redacted.Redacted,
): Effect.Effect<boolean, HashError> =>
  Effect.tryPromise({
    try: () => argon2.verify(hash, Redacted.value(password)),
    catch: (cause) => new HashError({ cause }),
  });

const dummyVerifyPassword = (
  password: Redacted.Redacted,
): Effect.Effect<void, HashError> =>
  verifyPassword(DUMMY_DIGEST, password).pipe(Effect.asVoid);

const generateToken = (prefix: string): Effect.Effect<GeneratedToken> =>
  Effect.sync(() => {
    const plaintext = `${prefix}${randomBytes(32).toString('base64url')}`;
    return { plaintext, hash: sha256Hex(plaintext) };
  });

const verifyToken = (hash: string, plaintext: string): boolean => {
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(sha256Hex(plaintext), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export const HasherLive = Layer.succeed(Hasher, {
  hashPassword,
  verifyPassword,
  dummyVerifyPassword,
  generateToken,
  hashToken: sha256Hex,
  verifyToken,
});
