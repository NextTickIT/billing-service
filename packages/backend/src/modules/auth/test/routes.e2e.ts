import assert from 'node:assert/strict';

/**
 * Auth route e2e scenarios — black-box HTTP against a REAL, freshly-migrated
 * Postgres. Co-located with the auth module; run only by the e2e runner
 * (`test/e2e/run.ts`), never by the `npm test` unit gate (`*.e2e.ts`, not
 * `*.test.ts`).
 * Each scenario is handed a `baseUrl` (a real listening server) and a `query`
 * helper that runs SQL against that scenario's own throwaway database, so it can
 * assert on data at rest. The runner (run.ts) gives every scenario an isolated,
 * auto-generated database that is created, migrated, and dropped around it.
 */

const ADMIN_TOKEN = 'e2e-admin-token';
const adminHeader = { authorization: `Bearer ${ADMIN_TOKEN}` };

export interface E2eContext {
  readonly baseUrl: string;
  /** Run read-only SQL against the current test database (via psql). */
  readonly query: (sql: string) => Promise<string>;
}

export interface Scenario {
  readonly name: string;
  readonly run: (ctx: E2eContext) => Promise<void>;
}

interface CreateTokenResponse {
  readonly authToken: { readonly alias: string; readonly role: number };
  readonly secret: string;
}

interface CreateSessionResponse {
  readonly session: { readonly id: string; readonly operatorId: string };
  readonly token: string;
}

const postJson = (
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

export const scenarios: readonly Scenario[] = [
  {
    name: 'admin creates a token (alias + role) with a one-time secret',
    run: async ({ baseUrl }) => {
      const res = await postJson(
        baseUrl,
        '/auth/tokens',
        { alias: 'ci-bot', role: 2 },
        adminHeader,
      );
      assert.equal(res.status, 201);
      const body = (await res.json()) as CreateTokenResponse;
      assert.equal(body.authToken.alias, 'ci-bot');
      assert.equal(body.authToken.role, 2);
      assert.ok(
        body.secret.startsWith('bst_'),
        'secret is prefixed, returned once',
      );
    },
  },
  {
    name: 'a missing or invalid admin credential is rejected (401)',
    run: async ({ baseUrl }) => {
      const noAuth = await postJson(baseUrl, '/auth/tokens', {
        alias: 'x',
        role: 2,
      });
      assert.equal(noAuth.status, 401);
      const badAuth = await postJson(
        baseUrl,
        '/auth/operators',
        { login: 'x', password: 'y', role: 1 },
        { authorization: 'Bearer not-the-admin-token' },
      );
      assert.equal(badAuth.status, 401);
    },
  },
  {
    name: 'admin creates an operator who can then sign in',
    run: async ({ baseUrl }) => {
      const created = await postJson(
        baseUrl,
        '/auth/operators',
        { login: 'alice', password: 'correct horse battery', role: 1 },
        adminHeader,
      );
      assert.equal(created.status, 201);
      const signedIn = await postJson(baseUrl, '/auth/sessions', {
        login: 'alice',
        password: 'correct horse battery',
      });
      assert.equal(signedIn.status, 201);
      const body = (await signedIn.json()) as CreateSessionResponse;
      assert.ok(body.session.id.length > 0);
      assert.ok(body.token.length > 0);
    },
  },
  {
    name: 'sign-in with a wrong password is 401',
    run: async ({ baseUrl }) => {
      await postJson(
        baseUrl,
        '/auth/operators',
        { login: 'bob', password: 'right-pass', role: 1 },
        adminHeader,
      );
      const res = await postJson(baseUrl, '/auth/sessions', {
        login: 'bob',
        password: 'wrong-pass',
      });
      assert.equal(res.status, 401);
    },
  },
  {
    name: 'a duplicate operator login is 409',
    run: async ({ baseUrl }) => {
      const first = await postJson(
        baseUrl,
        '/auth/operators',
        { login: 'carol', password: 'pw', role: 1 },
        adminHeader,
      );
      assert.equal(first.status, 201);
      const second = await postJson(
        baseUrl,
        '/auth/operators',
        { login: 'carol', password: 'pw', role: 1 },
        adminHeader,
      );
      assert.equal(second.status, 409);
    },
  },
  {
    name: 'passwords are stored as argon2id, not plaintext (checked at rest)',
    run: async ({ baseUrl, query }) => {
      await postJson(
        baseUrl,
        '/auth/operators',
        { login: 'erin', password: 'super-secret-pw', role: 1 },
        adminHeader,
      );
      const hash = (
        await query(`SELECT "passwordHash" FROM operators WHERE login = 'erin'`)
      ).trim();
      assert.ok(
        hash.startsWith('$argon2id$'),
        `expected argon2id, got: ${hash}`,
      );
      assert.ok(
        !hash.includes('super-secret-pw'),
        'plaintext must not be stored',
      );
    },
  },
  {
    name: 'an admin auth-token minted via the env token can then create operators',
    run: async ({ baseUrl }) => {
      // Bootstrap: use the env admin token once to mint an Admin auth-token.
      const minted = await postJson(
        baseUrl,
        '/auth/tokens',
        { alias: 'root-admin', role: 0 },
        adminHeader,
      );
      assert.equal(minted.status, 201);
      const { secret } = (await minted.json()) as CreateTokenResponse;
      // From now on the minted admin token authenticates admin ops — so the env
      // ADMIN_TOKEN can be removed. Same code path with or without the env var.
      const created = await postJson(
        baseUrl,
        '/auth/operators',
        { login: 'via-token', password: 'pw', role: 1 },
        { authorization: `Bearer ${secret}` },
      );
      assert.equal(created.status, 201);
    },
  },
  {
    name: 'a non-admin (Service) auth-token cannot create operators (403)',
    run: async ({ baseUrl }) => {
      const minted = await postJson(
        baseUrl,
        '/auth/tokens',
        { alias: 'svc', role: 2 },
        adminHeader,
      );
      assert.equal(minted.status, 201);
      const { secret } = (await minted.json()) as CreateTokenResponse;
      const forbidden = await postJson(
        baseUrl,
        '/auth/operators',
        { login: 'nope', password: 'pw', role: 1 },
        { authorization: `Bearer ${secret}` },
      );
      assert.equal(forbidden.status, 403);
    },
  },
  {
    name: 'an unknown bearer token is rejected (401)',
    run: async ({ baseUrl }) => {
      const res = await postJson(
        baseUrl,
        '/auth/operators',
        { login: 'x', password: 'y', role: 1 },
        { authorization: 'Bearer bst_does-not-exist' },
      );
      assert.equal(res.status, 401);
    },
  },
  {
    name: 'GET /health is 200 against a real database (readiness)',
    run: async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { readonly status: string };
      assert.equal(body.status, 'ok');
    },
  },
];
