import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import { MigrationError } from '@effect/sql/Migrator';
import { fromFileSystem } from '@effect/sql/Migrator/FileSystem';
import {
  type Payment,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Cause, Effect, Exit, Option } from 'effect';

import type { DatabaseConfig } from '@/config.js';
import { loadConfig } from '@/config.js';
import {
  migrationsDir,
  runMigrations,
  runMigrationsWith,
} from '@/infra/migrator.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { addPeriod } from '@/modules/payment/period.js';

import type { Scenario } from './http-harness.js';
import {
  cardOrderOf,
  CREATED,
  createSession,
  endDateOf,
  eventsOf,
  type Http,
  httpContext,
  insertSessions,
  type Json,
  onApp,
  onDb,
  PAST,
  pay,
  plainSession,
  rowOf,
  scalar,
  seedSubs,
  sessionIdOf,
  statusOf,
  w4pCallback,
  WHITEPAY_PAY_URL,
  whitePayCallback,
  withWhitePayApp,
} from './prolong.e2e.js';

/**
 * E2E for the migration flag (`reportAs: "renewal"` → origin `migration`, plan B1, B7,
 * B7b, B8) and migration 0026.
 *
 * R1–R10 are HTTP scenarios (spread into `edgeScenarios`): every database they run on
 * is fully migrated. R11 proves 0026's guard, so it needs a database stopped at 0025: it
 * runs in its own tier (`runMigrationScenario` in `run.ts`), which creates the database
 * and neither migrates it nor boots the app.
 */

// ---------------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------------

/** The spec's corrected worked example (the promo on every option), minus the flag. */
const workedExample = (externalUserId: string, method: PaymentMethod): Json => {
  const promo = { additionalFreePeriod: 'P7D' };
  const renewal = { amount: 5000, period: 'P1M' };
  return {
    externalUserId,
    method,
    amount: 5000,
    currency: 1,
    period: 'P1M',
    renewal,
    promo,
    options: [
      { amount: 5000, period: 'P1M', promo, renewal },
      { amount: 13500, period: 'P3M', promo, renewal },
      { amount: 24000, period: 'P6M', promo, renewal },
    ],
  };
};

const flagged = (body: Json): Json => ({ ...body, reportAs: 'renewal' });

const originOf = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT coalesce(origin, '<null>') FROM checkout_sessions WHERE id = '${id}'`,
  );

/** The contact's only payments row; fails when there is not exactly one. */
const onlyRowOf = async (http: Http, contact: string): Promise<string> => {
  const ids = await scalar(
    http,
    `SELECT coalesce(string_agg(id::text, ','), '') FROM payments WHERE "externalUserId" = '${contact}'`,
  );
  assert.ok(ids !== '' && !ids.includes(','), `${contact}: one row (${ids})`);
  return ids;
};

const paymentsOf = (http: Http, contact: string) =>
  scalar(
    http,
    `SELECT count(*) FROM payments WHERE "externalUserId" = '${contact}'`,
  );

// ---------------------------------------------------------------------------------
// R1, R2, R9 — the flag on create, the CHECK, the claimedAt column, equal rows.
// ---------------------------------------------------------------------------------

const r1Stored = async (http: Http) => {
  const id = await sessionIdOf(
    await createSession(http, flagged(workedExample('sp:r1', 1))),
    'flagged create',
  );
  assert.equal(await originOf(http, id), 'migration', 'R1: origin migration');
  await assert.rejects(
    http.query(
      `UPDATE checkout_sessions SET origin = 'bogus' WHERE id = '${id}'`,
    ),
    /checkout_sessions_origin_check/,
    'R1: origin bogus violates the CHECK (update)',
  );
  await assert.rejects(
    http.query(
      `INSERT INTO checkout_sessions (id, "externalUserId", amount, currency, period, method, "expiresAt", origin)
       VALUES ('chk_r1_bogus', 'sp:r1', 5000, 1, 'P1M', 1, now() + interval '1 day', 'bogus')`,
    ),
    /checkout_sessions_origin_check/,
    'R1: origin bogus violates the CHECK (insert)',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT data_type || '|' || is_nullable FROM information_schema.columns WHERE table_name = 'checkout_sessions' AND column_name = 'claimedAt'`,
    ),
    'timestamp with time zone|YES',
    'R1: claimedAt exists and is nullable',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT "claimedAt" IS NULL FROM checkout_sessions WHERE id = '${id}'`,
    ),
    't',
    'R1: NULL on a fresh row',
  );
};

const r2Validation = async (http: Http) => {
  const body = workedExample('sp:r2', 1);
  await sessionIdOf(await createSession(http, flagged(body)), 'R2: flag → 201');
  const initial = await sessionIdOf(
    await createSession(http, { ...body, reportAs: 'initial' }),
    'R2: reportAs initial → 201',
  );
  assert.equal(
    await originOf(http, initial),
    '<null>',
    'R2: initial → no origin',
  );
  const unknown = await createSession(http, { ...body, reportAs: 'first' });
  assert.equal(unknown.status, 400, 'R2: reportAs first → 400');
  const oneTime = await createSession(http, {
    externalUserId: 'sp:r2',
    amount: 5000,
    currency: 1,
    recurring: false,
    reportAs: 'renewal',
  });
  assert.equal(oneTime.status, 400, 'R2: flag with recurring:false → 400');
  // The API answers every schema refusal with a generic body; the unflagged twin below
  // returning 201 is what pins this 400 on the flag.
  const plainOneTime = await createSession(http, {
    externalUserId: 'sp:r2',
    amount: 5000,
    currency: 1,
    recurring: false,
  });
  assert.equal(
    plainOneTime.status,
    201,
    'R2: the same one-time body without the flag → 201',
  );
};

/** Every stored column but the four that must differ, as jsonb text. */
const sameColumnsOf = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT (to_jsonb(cs) - 'id' - 'origin' - 'createdAt' - 'expiresAt')::text FROM checkout_sessions cs WHERE id = '${id}'`,
  );

const r9SameRow = async (http: Http) => {
  const body = workedExample('sp:r9', 1);
  const withFlag = await sessionIdOf(
    await createSession(http, flagged(body)),
    'R9 flagged',
  );
  const without = await sessionIdOf(
    await createSession(http, body),
    'R9 plain',
  );
  assert.equal(await originOf(http, withFlag), 'migration');
  assert.equal(await originOf(http, without), '<null>');
  assert.equal(
    await sameColumnsOf(http, withFlag),
    await sameColumnsOf(http, without),
    'R9: equal on every column except id, origin, createdAt, expiresAt',
  );
  const ttl = loadConfig().wayforpay.sessionTtlSeconds;
  for (const id of [withFlag, without]) {
    assert.equal(
      await scalar(
        http,
        `SELECT abs(extract(epoch FROM "expiresAt" - "createdAt") - ${String(ttl)}) <= 1 FROM checkout_sessions WHERE id = '${id}'`,
      ),
      't',
      `R9: ${id} expiresAt - createdAt = TTL (${String(ttl)} s) ± 1 s`,
    );
  }
};

const r1r2r9Scenario: Scenario = {
  name: 'migration (R1, R2, R9): a flagged create stores origin migration; origin bogus violates the CHECK; claimedAt nullable and NULL; 201/400/400; flagged = unflagged but id/origin/createdAt/expiresAt, TTL ± 1 s',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'r1-svc');
    await r1Stored(http);
    await r2Validation(http);
    await r9SameRow(http);
  },
};

// ---------------------------------------------------------------------------------
// R3 — the worked example paid, crypto by WhitePay and card by WayForPay.
// ---------------------------------------------------------------------------------

const PAID_AT = new Date('2026-11-02T10:00:00Z');

/** The fresh row and its two events after option 1 (3 months, $135) settled. */
const assertMigratedIn = async (
  http: Http,
  contact: string,
  method: PaymentMethod,
) => {
  const row = await onlyRowOf(http, contact);
  const end = addPeriod(addPeriod(PAID_AT, 'P3M'), 'P7D');
  assert.equal(
    await scalar(
      http,
      `SELECT amount || '|' || period || '|' || currency || '|' || method || '|' || status || '|' || (extract(epoch FROM "currentPeriodStart") * 1000)::bigint || '|' || (extract(epoch FROM "currentPeriodEnd") * 1000)::bigint FROM payments WHERE id = '${row}'`,
    ),
    `5000|P1M|1|${String(method)}|${String(PaymentStatus.Active)}|${String(PAID_AT.getTime())}|${String(end.getTime())}`,
    `${contact}: renews at 5000/P1M, paid until paidAt + P3M + P7D`,
  );
  assert.equal(
    await eventsOf(http, contact),
    `payment_created:${row},recurring_payment_succeeded:${row}`,
    `${contact}: payment_created then recurring_payment_succeeded`,
  );
  assert.equal(
    await scalar(
      http,
      `SELECT (payload->>'period') || '|' || (payload->>'amount') FROM domain_events WHERE name = 'recurring_payment_succeeded' AND "externalUserId" = '${contact}'`,
    ),
    'P3M|13500',
    `${contact}: the success reports the bought period and total`,
  );
};

const r3Crypto = async (http: Http) => {
  const contact = 'sp:r3-crypto';
  const id = await sessionIdOf(
    await createSession(
      http,
      flagged(workedExample(contact, PaymentMethod.Crypto)),
    ),
    'R3 crypto',
  );
  const res = await pay(http, id, PaymentMethod.Crypto, 1);
  assert.deepEqual(res, {
    status: 200,
    body: { kind: 'redirect', url: `${WHITEPAY_PAY_URL}/${id}_o1` },
  });
  await whitePayCallback(http, 'COMPLETE', {
    ref: `${id}_o1`,
    amount: 135,
    currency: 'USD',
    at: PAID_AT,
  });
  await assertMigratedIn(http, contact, PaymentMethod.Crypto);
};

const r3Card = async (http: Http) => {
  const contact = 'sp:r3-card';
  const id = await sessionIdOf(
    await createSession(
      http,
      flagged(workedExample(contact, PaymentMethod.Card)),
    ),
    'R3 card',
  );
  const order = cardOrderOf(
    await pay(http, id, PaymentMethod.Card, 1),
    'R3 card',
  );
  assert.deepEqual(order, { ref: `${id}_o1`, amount: 135 });
  await w4pCallback(http, 'Approved', {
    ...order,
    currency: 'USD',
    at: PAID_AT,
  });
  await assertMigratedIn(http, contact, PaymentMethod.Card);
};

const r3Scenario: Scenario = {
  name: 'migration (R3): the worked example, option 1 paid by WhitePay and by card for a contact with no row → 5000/P1M until paidAt+P3M+P7D; payment_created then recurring_payment_succeeded (P3M)',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'r3-svc');
    await withWhitePayApp(async (url) => {
      const wp = await onApp(http, url);
      await r3Crypto(wp);
      await r3Card(wp);
    });
  },
};

// ---------------------------------------------------------------------------------
// R4, R10 — a declined flagged payment; an intro option on a live sub.
// ---------------------------------------------------------------------------------

const r4Declined = async (http: Http) => {
  const contact = 'sp:r4';
  const id = await sessionIdOf(
    await createSession(
      http,
      flagged(workedExample(contact, PaymentMethod.Card)),
    ),
    'R4',
  );
  const order = cardOrderOf(await pay(http, id, PaymentMethod.Card, 1), 'R4');
  await w4pCallback(http, 'Declined', { ...order, currency: 'USD' });
  assert.equal(await paymentsOf(http, contact), '0', 'R4: nothing written');
  assert.equal(
    await scalar(
      http,
      `SELECT string_agg(name, ',') FROM domain_events WHERE "externalUserId" = '${contact}'`,
    ),
    'recurring_payment_failed',
    'R4: recurring_payment_failed, no initial_payment_failed',
  );
};

const r10IntroOnLive = async (http: Http) => {
  const contact = 'sp:r10';
  const renewal = { amount: 30000, period: 'P1M' };
  const flat = { amount: 30000, period: 'P1M', renewal };
  const intro = { amount: 100, period: 'P1W', renewal };
  const id = await sessionIdOf(
    await createSession(
      http,
      flagged({
        externalUserId: contact,
        currency: 0,
        ...flat,
        options: [flat, intro],
      }),
    ),
    'R10',
  );
  const res = await pay(http, id, PaymentMethod.Card, 1);
  assert.equal(res.status, 409, 'R10: intro option with a live sub → 409');
  assert.deepEqual(res.body, {
    error: 'already subscribed',
    code: 'already_subscribed',
  });
  assert.equal(await statusOf(http, id), CREATED, 'R10: session unchanged');
};

const r4r10Scenario: Scenario = {
  name: 'migration (R4, R10): a declined flagged payment writes nothing and reports recurring_payment_failed; an intro option of a flagged link with a live sub → 409 already_subscribed',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'r4-svc');
    await seedSubs([
      { externalUserId: 'sp:r10', end: new Date('2030-01-01T00:00:00Z') },
    ]);
    await r4Declined(http);
    await r10IntroOnLive(http);
  },
};

// ---------------------------------------------------------------------------------
// R5–R8 — a lapsed flagged link of a PastDue contact (B7b). The links carry no options:
// a lapsed caller link with options cannot be re-paid by a PastDue contact today.
// ---------------------------------------------------------------------------------

/** A lapsed caller link at the PastDue sub's own terms (30000 / P1M, card). */
const lapsedLink = (id: string, contact: string, origin: 'migration' | null) =>
  plainSession(id, contact, { origin, expiresAt: PAST });

const pastDue = (externalUserId: string) => ({
  externalUserId,
  end: PAST,
  status: PaymentStatus.PastDue,
  period: 'P1M',
});

/** `/pay` by card on a lapsed link; the id of the replacement it was re-minted to. */
const replacementOf = async (http: Http, id: string): Promise<string> => {
  const order = cardOrderOf(
    await pay(http, id, PaymentMethod.Card),
    `pay ${id}`,
  );
  assert.notEqual(order.ref, id, `${id}: re-minted under a fresh id`);
  return order.ref;
};

const r5ReuseIsolation = async (http: Http) => {
  const contact = 'sp:r5';
  await insertSessions([
    lapsedLink('chk_r5_flag', contact, 'migration'),
    lapsedLink('chk_r5_plain', contact, null),
  ]);
  const flagRepl = await replacementOf(http, 'chk_r5_flag');
  const plainRepl = await replacementOf(http, 'chk_r5_plain');
  assert.notEqual(flagRepl, plainRepl, 'R5: two different replacements');
  assert.equal(await originOf(http, flagRepl), 'migration', 'R5: flag kept');
  assert.equal(
    await originOf(http, plainRepl),
    '<null>',
    'R5: plain stays plain',
  );
  assert.equal(
    await replacementOf(http, 'chk_r5_flag'),
    flagRepl,
    'R5: flagged reuses its own',
  );
  assert.equal(
    await replacementOf(http, 'chk_r5_plain'),
    plainRepl,
    'R5: plain reuses its own',
  );
};

const r6SettlesOnPastDue = async (http: Http, sub: Payment) => {
  await insertSessions([lapsedLink('chk_r6', sub.externalUserId, 'migration')]);
  const repl = await replacementOf(http, 'chk_r6');
  await w4pCallback(http, 'Approved', { ref: repl, amount: 300 });
  assert.equal(
    await endDateOf(http, sub.id),
    '2026-02-01',
    'R6: P1M stacked on the old end',
  );
  assert.equal(
    await eventsOf(http, sub.externalUserId),
    `recurring_payment_succeeded:${sub.id}`,
    'R6: a stack and recurring_payment_succeeded, no payment_created',
  );
};

/** The flagged replacement, minted while PastDue; then the sub dies before it settles. */
const replacementThenDeath = async (http: Http, sub: Payment, link: string) => {
  await insertSessions([lapsedLink(link, sub.externalUserId, 'migration')]);
  const repl = await replacementOf(http, link);
  await onDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makePaymentRepo(sql).markRenewalFailed(sub.id),
    ),
  );
  return { repl, dead: await rowOf(http, sub.id) };
};

const r7SettlesAfterDeath = async (http: Http, sub: Payment) => {
  const contact = sub.externalUserId;
  const { repl, dead } = await replacementThenDeath(http, sub, 'chk_r7');
  await w4pCallback(http, 'Approved', { ref: repl, amount: 300 });
  assert.equal(
    await rowOf(http, sub.id),
    dead,
    'R7: the dead row is untouched',
  );
  const fresh = await scalar(
    http,
    `SELECT id FROM payments WHERE "externalUserId" = '${contact}' AND id <> '${sub.id}'`,
  );
  assert.ok(fresh !== '', 'R7: a fresh row');
  assert.equal(
    await scalar(
      http,
      `SELECT status || '|' || amount || '|' || period FROM payments WHERE id = '${fresh}'`,
    ),
    `${String(PaymentStatus.Active)}|30000|P1M`,
  );
  assert.equal(
    await eventsOf(http, contact),
    `payment_created:${fresh},recurring_payment_succeeded:${fresh}`,
    'R7: payment_created then recurring_payment_succeeded',
  );
};

const r8DeclinedAfterDeath = async (http: Http, sub: Payment) => {
  const contact = sub.externalUserId;
  const { repl, dead } = await replacementThenDeath(http, sub, 'chk_r8');
  await w4pCallback(http, 'Declined', { ref: repl, amount: 300 });
  assert.equal(await paymentsOf(http, contact), '1', 'R8: no row written');
  assert.equal(
    await rowOf(http, sub.id),
    dead,
    'R8: the dead row is untouched',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT string_agg(name, ',') FROM domain_events WHERE "externalUserId" = '${contact}'`,
    ),
    'recurring_payment_failed',
    'R8: recurring_payment_failed',
  );
};

const r5r8Scenario: Scenario = {
  name: 'migration (R5–R8): flagged and unflagged lapsed links of a PastDue contact re-mint apart and reuse their own; a flagged replacement stacks while PastDue, makes a fresh row after death, and a decline after death writes nothing (all recurring_*)',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'r5-svc');
    const subOf = await seedSubs([
      pastDue('sp:r5'),
      pastDue('sp:r6'),
      pastDue('sp:r7'),
      pastDue('sp:r8'),
    ]);
    await r5ReuseIsolation(http);
    await r6SettlesOnPastDue(http, subOf('sp:r6'));
    await r7SettlesAfterDeath(http, subOf('sp:r7'));
    await r8DeclinedAfterDeath(http, subOf('sp:r8'));
  },
};

export const migrationScenarios: readonly Scenario[] = [
  r1r2r9Scenario,
  r3Scenario,
  r4r10Scenario,
  r5r8Scenario,
];

// ---------------------------------------------------------------------------------
// R11 — 0026's guard on an unexpected CHECK layout (migration tier).
// ---------------------------------------------------------------------------------

/** What the migration tier hands a scenario: an unmigrated database, no app. */
export interface MigrationContext {
  readonly dbConfig: DatabaseConfig;
  /** psql inside the container; throws on a SQL error. */
  readonly psql: (sql: string) => string;
  readonly query: (sql: string) => Promise<string>;
}

export interface MigrationScenario {
  readonly name: string;
  readonly run: (ctx: MigrationContext) => Promise<void>;
}

const LEGACY_DEF = `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'legacy_origin_check' AND conrelid = 'checkout_sessions'::regclass`;
const SEEDED_ROW = `SELECT cs::text FROM checkout_sessions cs WHERE id = 'chk_r11'`;
const LEDGER = `SELECT string_agg(migration_id::text, ',' ORDER BY migration_id) FROM effect_sql_migrations`;
const THROUGH_25 = Array.from({ length: 25 }, (_, i) => String(i + 1)).join(
  ',',
);

/** Migrate to 0025 from the shipped files, seed a row, rename the origin CHECK. */
const stopAt25WithRenamedCheck = async ({
  dbConfig,
  psql,
}: MigrationContext) => {
  await Effect.runPromise(
    runMigrationsWith(
      dbConfig,
      Effect.map(fromFileSystem(migrationsDir), (ms) =>
        ms.filter(([id]) => id <= 25),
      ),
    ),
  );
  assert.equal(psql(LEDGER).trim(), THROUGH_25, 'migrated through 0025');
  psql(
    `INSERT INTO checkout_sessions (id, "externalUserId", amount, currency, period, method, "expiresAt", origin, "renewalOf")
     VALUES ('chk_r11', 'sp:r11', 30000, 0, 'P1M', 0, '2030-01-01T00:00:00Z', 'prolong', 'sub_r11')`,
  );
  psql(
    'ALTER TABLE checkout_sessions RENAME CONSTRAINT checkout_sessions_origin_check TO legacy_origin_check',
  );
};

/** The failed run is a defect: MigrationError → SqlError → the pg error. */
const assertGuardDefect = (exit: Exit.Exit<unknown, unknown>) => {
  assert.ok(Exit.isFailure(exit), 'R11: runMigrations fails');
  const die = Cause.dieOption(exit.cause);
  assert.ok(Option.isSome(die), 'R11: a defect, not a typed failure');
  const error = die.value;
  assert.ok(error instanceof MigrationError, 'R11: a MigrationError');
  assert.match(
    error.message,
    /^Migration "26_checkout_origin_migration" failed$/,
    'R11: the migrator names the failed migration; the guard text is deeper',
  );
  const sqlError = error.cause as { _tag?: unknown; cause?: unknown };
  assert.equal(sqlError._tag, 'SqlError', 'R11: caused by a SqlError');
  const pgError = sqlError.cause;
  assert.ok(pgError instanceof Error, 'R11: caused by the pg error');
  assert.match(
    pgError.message,
    /^unexpected origin CHECK on checkout_sessions: 1 constraint\(s\), first legacy_origin_check$/,
    'R11: the pg error carries the guard text, naming the renamed CHECK',
  );
};

const r11Guard: MigrationScenario = {
  name: 'migration (R11): 0026 refuses an unexpected origin CHECK layout; the CHECK, the data and the ledger (1–25, no 26) are unchanged',
  run: async (ctx) => {
    await stopAt25WithRenamedCheck(ctx);
    const def = ctx.psql(LEGACY_DEF).trim();
    const row = ctx.psql(SEEDED_ROW).trim();
    assert.match(
      def,
      /'prolong'.*'manual_renewal'.*'card_change'.*'card_change_arrears'/s,
    );
    assert.doesNotMatch(def, /migration/, 'the legacy CHECK has 4 values');
    assertGuardDefect(await Effect.runPromiseExit(runMigrations(ctx.dbConfig)));
    assert.equal(
      ctx.psql(LEGACY_DEF).trim(),
      def,
      'R11: legacy_origin_check unchanged',
    );
    assert.equal(
      ctx
        .psql(
          `SELECT count(*) FROM pg_constraint WHERE conname = 'checkout_sessions_origin_check'`,
        )
        .trim(),
      '0',
      'R11: no new CHECK added',
    );
    assert.equal(
      ctx.psql(SEEDED_ROW).trim(),
      row,
      'R11: the seeded row is byte-identical',
    );
    assert.equal(
      ctx.psql(LEDGER).trim(),
      THROUGH_25,
      'R11: ledger rows 1–25, no 26',
    );
    assert.equal(
      ctx
        .psql(
          `SELECT count(*) FROM information_schema.columns WHERE table_name = 'checkout_sessions' AND column_name = 'claimedAt'`,
        )
        .trim(),
      '0',
      'R11: claimedAt not added',
    );
  },
};

export const migrationGuardScenarios: readonly MigrationScenario[] = [r11Guard];
