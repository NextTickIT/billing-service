import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import type {
  AuthToken,
  CreateAuthToken,
  CreateOperator,
  CreateSession,
  Operator,
  Session,
} from '@billing-service/shared';
import { Context, Effect, Layer, Option } from 'effect';

import { onUniqueViolation } from '@/infra/db/pg-errors.js';
import { requireRow } from '@/infra/db/rows.js';
import { Conflict } from '@/infra/http/errors.js';

/** An operator plus its secret password hash — the hash lives here and in SQL
 * only, never in the public `@billing-service/shared` shape. */
export type OperatorRow = Operator & { readonly passwordHash: string };

export type NewAuthToken = CreateAuthToken & {
  readonly tokenPrefix: string;
  readonly tokenHash: string;
};

export type NewOperator = CreateOperator & { readonly passwordHash: string };

export type NewSession = CreateSession & {
  readonly tokenHash: string;
  readonly expiresAt: Date;
};

export interface AuthRepoService {
  readonly insertAuthToken: (
    input: NewAuthToken,
  ) => Effect.Effect<AuthToken, Conflict | SqlError.SqlError>;
  readonly insertOperator: (
    input: NewOperator,
  ) => Effect.Effect<Operator, Conflict | SqlError.SqlError>;
  readonly findAuthTokenByHash: (
    tokenHash: string,
  ) => Effect.Effect<Option.Option<AuthToken>, SqlError.SqlError>;
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

const insertAuthToken = (sql: SqlClient.SqlClient) => (input: NewAuthToken) =>
  sql<AuthToken>`
    INSERT INTO auth_tokens (alias, role, "tokenPrefix", "tokenHash")
    VALUES (${input.alias}, ${input.role}, ${input.tokenPrefix}, ${input.tokenHash})
    RETURNING id, alias, role, "createdAt"
  `.pipe(
    Effect.flatMap(requireRow),
    Effect.catchTag('SqlError', onUniqueViolation('alias')),
  );

const insertOperator = (sql: SqlClient.SqlClient) => (input: NewOperator) =>
  sql<Operator>`
    INSERT INTO operators (login, role, "passwordHash")
    VALUES (${input.login}, ${input.role}, ${input.passwordHash})
    RETURNING id, login, role, "createdAt"
  `.pipe(
    Effect.flatMap(requireRow),
    Effect.catchTag('SqlError', onUniqueViolation('login')),
  );

const findAuthTokenByHash = (sql: SqlClient.SqlClient) => (tokenHash: string) =>
  sql<AuthToken>`
      SELECT id, alias, role, "createdAt"
      FROM auth_tokens WHERE "tokenHash" = ${tokenHash}
    `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const findOperatorByLogin = (sql: SqlClient.SqlClient) => (login: string) =>
  sql<OperatorRow>`
    SELECT id, login, role, "passwordHash", "createdAt"
    FROM operators WHERE login = ${login}
  `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const insertSession = (sql: SqlClient.SqlClient) => (input: NewSession) =>
  sql<Session>`
    INSERT INTO sessions ("operatorId", role, "tokenHash", "expiresAt")
    VALUES (${input.operatorId}, ${input.role}, ${input.tokenHash}, ${input.expiresAt})
    RETURNING id, "operatorId", role, "createdAt", "expiresAt"
  `.pipe(Effect.flatMap(requireRow));

const findSessionByTokenHash =
  (sql: SqlClient.SqlClient) => (tokenHash: string) =>
    sql<Session>`
      SELECT id, "operatorId", role, "createdAt", "expiresAt"
      FROM sessions WHERE "tokenHash" = ${tokenHash}
    `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

/** Real Postgres-backed repository (requires a `SqlClient`, i.e. `SqlLive`). */
export const AuthRepoLive = Layer.effect(
  AuthRepo,
  Effect.map(SqlClient.SqlClient, (sql) => ({
    insertAuthToken: insertAuthToken(sql),
    insertOperator: insertOperator(sql),
    findAuthTokenByHash: findAuthTokenByHash(sql),
    findOperatorByLogin: findOperatorByLogin(sql),
    insertSession: insertSession(sql),
    findSessionByTokenHash: findSessionByTokenHash(sql),
  })),
);
