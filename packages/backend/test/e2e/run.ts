import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import { buildApp } from '@/app.js';
import type { DatabaseConfig } from '@/config.js';
import { runMigrations } from '@/infra/migrator.js';

import { scenarios, type Scenario } from './auth.e2e.js';

/**
 * E2E test runner. Spins up the only external dependency (Postgres) in Docker,
 * then for EACH scenario auto-generates a unique database, runs the ACTUAL
 * migrations against it, boots a real listening server pointed at it, exercises
 * it over HTTP, and finally DROPs that database — guaranteed (in `finally`), so
 * there is no cross-test data leakage. The stack is torn down at the end and a
 * sweeper + count assert prove no `test_*` databases leaked.
 *
 * The app runs as a real process against the Dockerized Postgres (the stateful
 * dependency). DB admin ops (CREATE/DROP + the at-rest check) go through `psql`
 * inside the container, so the runner needs no separate Postgres driver.
 */

const COMPOSE_FILE = fileURLToPath(
  new URL('../../../../docker-compose.e2e.yml', import.meta.url),
);
const SERVICE = 'db';
const ADMIN_TOKEN = 'e2e-admin-token';
const DB = {
  host: '127.0.0.1',
  port: 5544,
  user: 'postgres',
  password: 'postgres',
};

const compose = (...args: readonly string[]): string =>
  execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    encoding: 'utf8',
  });

/** Run a SQL statement inside the Postgres container via psql (returns stdout). */
const psql = (database: string, sql: string): string =>
  compose(
    'exec',
    '-T',
    SERVICE,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    DB.user,
    '-d',
    database,
    '-tAc',
    sql,
  );

const queryTestDb =
  (database: string) =>
  (sql: string): Promise<string> => {
    try {
      return Promise.resolve(psql(database, sql));
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

const testDbConfig = (database: string): DatabaseConfig => ({
  host: DB.host,
  port: DB.port,
  user: DB.user,
  password: DB.password,
  database,
});

const setAppEnv = (database: string): void => {
  process.env['HOST'] = DB.host;
  process.env['PORT'] = '0';
  process.env['DB_HOST'] = DB.host;
  process.env['DB_PORT'] = String(DB.port);
  process.env['DB_USER'] = DB.user;
  process.env['DB_PASSWORD'] = DB.password;
  process.env['DB_NAME'] = database;
  process.env['ADMIN_TOKEN'] = ADMIN_TOKEN;
  process.env['SESSION_TTL_SECONDS'] = '3600';
};

const dropStaleTestDbs = (): void => {
  const list = psql(
    'postgres',
    "SELECT datname FROM pg_database WHERE datname LIKE 'test\\_%'",
  ).trim();
  const names = list
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const name of names) {
    psql('postgres', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
};

const runScenario = async (
  scenario: Scenario,
  index: number,
): Promise<void> => {
  const database = `test_${index.toString()}_${randomUUID().replace(/-/g, '')}`;
  psql('postgres', `CREATE DATABASE ${database}`);
  try {
    // ACTUAL migrations, per test database (proves the migration authority).
    await Effect.runPromise(runMigrations(testDbConfig(database)));
    setAppEnv(database);
    const app = await buildApp();
    try {
      const baseUrl = await app.listen({ host: DB.host, port: 0 });
      await scenario.run({ baseUrl, query: queryTestDb(database) });
      console.log(`  ✓ ${scenario.name}`);
    } finally {
      await app.close();
    }
  } finally {
    psql('postgres', `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  }
};

const main = async (): Promise<void> => {
  console.log('e2e: starting Postgres (docker compose up --wait)...');
  compose('up', '-d', '--wait');
  try {
    dropStaleTestDbs();
    for (let index = 0; index < scenarios.length; index += 1) {
      const scenario = scenarios[index];
      if (scenario !== undefined) {
        await runScenario(scenario, index);
      }
    }
    dropStaleTestDbs();
    const remaining = psql(
      'postgres',
      "SELECT count(*) FROM pg_database WHERE datname LIKE 'test\\_%'",
    ).trim();
    if (remaining !== '0') {
      throw new Error(`leaked ${remaining} test database(s)`);
    }
    console.log(
      `e2e: ${scenarios.length.toString()} scenarios passed; 0 leaked databases`,
    );
  } finally {
    console.log('e2e: tearing down (docker compose down -v)...');
    compose('down', '-v');
  }
};

await main();
