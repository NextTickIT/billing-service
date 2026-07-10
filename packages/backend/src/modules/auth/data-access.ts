import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import type {
  AuthToken,
  Operator,
  Role,
  Session,
} from '@billing-service/shared';
import { Context, Effect, Layer, Option } from 'effect';

import { Conflict } from '@/modules/auth/errors.js';

/**
 * AuthRepo — the persistence seam for the auth module. The domain depends on
 * this `Context.Tag` interface; `AuthRepoLive` is the real @effect/sql-pg
 * implementation and `makeAuthRepoTest` is an in-memory Layer for hermetic unit
 * tests (no Postgres). Secret hashes live here and in SQL only — never in
 * `@billing-service/shared`.
 */

/** Backend-only row: an operator plus its secret password hash. */
export interface OperatorRow {
  readonly id: string;
  readonly login: string;
  readonly role: Role;
  readonly passwordHash: string;
  readonly createdAt: Date;
}

export interface NewAuthToken {
  readonly alias: string;
  readonly role: Role;
  readonly tokenPrefix: string;
  readonly tokenHash: string;
}

export interface NewOperator {
  readonly login: string;
  readonly role: Role;
  readonly passwordHash: string;
}

export interface NewSession {
  readonly operatorId: string;
  readonly role: Role;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface AuthRepoService {
  readonly insertAuthToken: (
    input: NewAuthToken,
  ) => Effect.Effect<AuthToken, Conflict | SqlError.SqlError>;
  readonly insertOperator: (
    input: NewOperator,
  ) => Effect.Effect<Operator, Conflict | SqlError.SqlError>;
  readonly findOperatorByLogin: (
    login: string,
  ) => Effect.Effect<Option.Option<OperatorRow>, SqlError.SqlError>;
  readonly insertSession: (
    input: NewSession,
  ) => Effect.Effect<Session, SqlError.SqlError>;
  readonly findSessionByTokenHash: (
    tokenHash: string,
  ) => Effect.Effect<Option.Option<Session>, SqlError.SqlError>;
}

export class AuthRepo extends Context.Tag('AuthRepo')<
  AuthRepo,
  AuthRepoService
>() {}

// --- Postgres error mapping -------------------------------------------------

const pgErrorCode = (error: SqlError.SqlError): string | undefined => {
  const { cause } = error;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
};

const onUniqueViolation =
  (field: string) =>
  (
    error: SqlError.SqlError,
  ): Effect.Effect<never, Conflict | SqlError.SqlError> =>
    pgErrorCode(error) === '23505'
      ? Effect.fail(new Conflict({ field }))
      : Effect.fail(error);

const requireRow = <A>(rows: readonly A[]): Effect.Effect<A> => {
  const [row] = rows;
  return row === undefined
    ? Effect.dieMessage('expected a RETURNING row')
    : Effect.succeed(row);
};

// --- real SQL implementations (column names are snake_case; PgClient's
// transformResultNames maps result keys back to camelCase) ------------------

const insertAuthToken =
  (sql: SqlClient.SqlClient) =>
  (
    input: NewAuthToken,
  ): Effect.Effect<AuthToken, Conflict | SqlError.SqlError> =>
    sql<AuthToken>`
      INSERT INTO auth_tokens (alias, role, token_prefix, token_hash)
      VALUES (${input.alias}, ${input.role}, ${input.tokenPrefix}, ${input.tokenHash})
      RETURNING id, alias, role, created_at
    `.pipe(
      Effect.flatMap(requireRow),
      Effect.catchTag('SqlError', onUniqueViolation('alias')),
    );

const insertOperator =
  (sql: SqlClient.SqlClient) =>
  (input: NewOperator): Effect.Effect<Operator, Conflict | SqlError.SqlError> =>
    sql<Operator>`
      INSERT INTO operators (login, role, password_hash)
      VALUES (${input.login}, ${input.role}, ${input.passwordHash})
      RETURNING id, login, role, created_at
    `.pipe(
      Effect.flatMap(requireRow),
      Effect.catchTag('SqlError', onUniqueViolation('login')),
    );

const findOperatorByLogin =
  (sql: SqlClient.SqlClient) =>
  (
    login: string,
  ): Effect.Effect<Option.Option<OperatorRow>, SqlError.SqlError> =>
    sql<OperatorRow>`
      SELECT id, login, role, password_hash, created_at
      FROM operators WHERE login = ${login}
    `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const insertSession =
  (sql: SqlClient.SqlClient) =>
  (input: NewSession): Effect.Effect<Session, SqlError.SqlError> =>
    sql<Session>`
      INSERT INTO sessions (operator_id, role, token_hash, expires_at)
      VALUES (${input.operatorId}, ${input.role}, ${input.tokenHash}, ${input.expiresAt})
      RETURNING id, operator_id, role, created_at, expires_at
    `.pipe(Effect.flatMap(requireRow));

const findSessionByTokenHash =
  (sql: SqlClient.SqlClient) =>
  (
    tokenHash: string,
  ): Effect.Effect<Option.Option<Session>, SqlError.SqlError> =>
    sql<Session>`
      SELECT id, operator_id, role, created_at, expires_at
      FROM sessions WHERE token_hash = ${tokenHash}
    `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

/** Real Postgres-backed repository (requires a `SqlClient`, i.e. `SqlLive`). */
export const AuthRepoLive = Layer.effect(
  AuthRepo,
  Effect.map(SqlClient.SqlClient, (sql) => ({
    insertAuthToken: insertAuthToken(sql),
    insertOperator: insertOperator(sql),
    findOperatorByLogin: findOperatorByLogin(sql),
    insertSession: insertSession(sql),
    findSessionByTokenHash: findSessionByTokenHash(sql),
  })),
);

// --- in-memory test double (no Postgres) -----------------------------------

const EPOCH = new Date(0);

/** In-memory `AuthRepo` for hermetic unit tests — mirrors the SQL semantics
 * (unique alias/login -> Conflict) without a database. */
export const makeAuthRepoTest = (): Layer.Layer<AuthRepo> => {
  const operatorsByLogin = new Map<string, OperatorRow>();
  const aliases = new Set<string>();
  const sessionsByHash = new Map<string, Session>();
  let counter = 0;
  const nextId = (): string => {
    counter += 1;
    return `id_${counter.toString()}`;
  };
  return Layer.succeed(AuthRepo, {
    insertAuthToken: (input) =>
      aliases.has(input.alias)
        ? Effect.fail(new Conflict({ field: 'alias' }))
        : Effect.sync(() => {
            aliases.add(input.alias);
            return {
              id: nextId(),
              alias: input.alias,
              role: input.role,
              createdAt: EPOCH,
            };
          }),
    insertOperator: (input) =>
      operatorsByLogin.has(input.login)
        ? Effect.fail(new Conflict({ field: 'login' }))
        : Effect.sync(() => {
            const row: OperatorRow = {
              id: nextId(),
              login: input.login,
              role: input.role,
              passwordHash: input.passwordHash,
              createdAt: EPOCH,
            };
            operatorsByLogin.set(input.login, row);
            return {
              id: row.id,
              login: row.login,
              role: row.role,
              createdAt: row.createdAt,
            };
          }),
    findOperatorByLogin: (login) =>
      Effect.sync(() => Option.fromNullable(operatorsByLogin.get(login))),
    insertSession: (input) =>
      Effect.sync(() => {
        const session: Session = {
          id: nextId(),
          operatorId: input.operatorId,
          role: input.role,
          createdAt: EPOCH,
          expiresAt: input.expiresAt,
        };
        sessionsByHash.set(input.tokenHash, session);
        return session;
      }),
    findSessionByTokenHash: (hash) =>
      Effect.sync(() => Option.fromNullable(sessionsByHash.get(hash))),
  });
};
