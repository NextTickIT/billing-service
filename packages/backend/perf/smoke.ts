import autocannon from 'autocannon';

interface SmokeConfig {
  readonly url: string;
  readonly durationSeconds: number;
  readonly connections: number;
  readonly token: string | undefined;
  readonly p99BudgetMs: number;
}

interface SmokeSummary {
  readonly requestsPerSecond: number;
  readonly p50: number;
  readonly p97_5: number;
  readonly p99: number;
  readonly errors: number;
  readonly non2xx: number;
}

const readNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  }
  return value;
};

const readConfig = (): SmokeConfig => ({
  url: process.env['PERF_URL'] ?? 'http://127.0.0.1:3000/health',
  durationSeconds: readNumber('PERF_DURATION_SECONDS', 10),
  connections: readNumber('PERF_CONNECTIONS', 20),
  token: process.env['PERF_TOKEN'],
  // docs/03: the status API must answer in under 500 ms.
  p99BudgetMs: readNumber('PERF_P99_BUDGET_MS', 500),
});

const authHeaders = (token: string | undefined): Record<string, string> =>
  token === undefined || token === ''
    ? {}
    : { authorization: `Bearer ${token}` };

// autocannon may reject with a plain object; keep its shape readable.
const describe = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

const runLoad = (config: SmokeConfig): Promise<autocannon.Result> =>
  new Promise((resolve, reject) => {
    autocannon(
      {
        url: config.url,
        duration: config.durationSeconds,
        connections: config.connections,
        headers: authHeaders(config.token),
      },
      (err: unknown, result: autocannon.Result) => {
        if (err === null || err === undefined) resolve(result);
        else reject(err instanceof Error ? err : new Error(describe(err)));
      },
    );
  });

// autocannon's own histogram: no per-response sample retention needed. A run
// with no responses reports 0 ms, so the "no response" case is caught by the
// non-2xx / error counters and by requests/s being 0, not by NaN.
const summarize = (result: autocannon.Result): SmokeSummary => ({
  requestsPerSecond: result.requests.average,
  p50: result.latency.p50,
  p97_5: result.latency.p97_5,
  p99: result.latency.p99,
  errors: result.errors,
  non2xx: result.non2xx,
});

const printSummary = (config: SmokeConfig, summary: SmokeSummary): void => {
  const ms = (value: number): string => `${value.toFixed(2)} ms`;
  const rows: [string, string][] = [
    ['target', config.url],
    [
      'load',
      `${String(config.connections)} conn × ${String(config.durationSeconds)} s`,
    ],
    ['requests/s', summary.requestsPerSecond.toFixed(1)],
    ['latency p50', ms(summary.p50)],
    ['latency p97.5', ms(summary.p97_5)],
    [
      'latency p99',
      `${ms(summary.p99)} (budget ${String(config.p99BudgetMs)} ms)`,
    ],
    ['errors', String(summary.errors)],
    ['non-2xx', String(summary.non2xx)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    console.log(`${label.padEnd(width)}  ${value}`);
  }
};

const failures = (config: SmokeConfig, summary: SmokeSummary): string[] => {
  const found: string[] = [];
  if (summary.requestsPerSecond === 0) found.push('no responses at all');
  if (summary.p99 > config.p99BudgetMs) {
    found.push(
      `p99 ${summary.p99.toFixed(2)} ms exceeds ${String(config.p99BudgetMs)} ms`,
    );
  }
  if (summary.non2xx > 0)
    found.push(`${String(summary.non2xx)} non-2xx responses`);
  if (summary.errors > 0)
    found.push(`${String(summary.errors)} connection errors`);
  return found;
};

const main = async (): Promise<void> => {
  const config = readConfig();
  const summary = summarize(await runLoad(config));
  printSummary(config, summary);
  const found = failures(config, summary);
  if (found.length > 0) {
    console.error(`\nFAIL: ${found.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nPASS');
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
