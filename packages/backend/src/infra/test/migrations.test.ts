import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { unmatchedApplied } from '@/infra/migrator.js';

// The same file pattern the @effect/sql FileSystem loader applies.
const FILE = /^(\d+)_([^.]+)\.(js|ts)$/;

const files = readdirSync(
  fileURLToPath(new URL('../../migrations', import.meta.url)),
)
  .sort()
  .flatMap((file) => {
    const [, id, name] = FILE.exec(file) ?? [];
    return id === undefined || name === undefined
      ? []
      : [{ id: Number(id), name }];
  });

describe('migration ids', () => {
  test('the directory holds migrations', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  // In file-name order, so a duplicate id, or a mis-padded name that sorts out of
  // numeric order, fails here in CI instead of at boot.
  test('ids are unique and strictly increasing', () => {
    const ids = files.map((f) => f.id);
    expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
  });
});

describe('unmatchedApplied (boot check)', () => {
  const shipped = [
    { id: 20, name: 'checkout_email' },
    { id: 21, name: 'checkout_renewal' },
  ];

  test('every applied row has its file: nothing to report', () => {
    expect(unmatchedApplied(shipped, shipped)).toEqual([]);
  });

  test('a fresh database (nothing applied) passes', () => {
    expect(unmatchedApplied([], shipped)).toEqual([]);
  });

  test('an applied id whose file has a different name is reported', () => {
    expect(
      unmatchedApplied([{ id: 21, name: 'metadata_passthrough' }], shipped),
    ).toEqual([{ id: 21, name: 'metadata_passthrough' }]);
  });

  test('an applied id with no file at all is reported', () => {
    expect(
      unmatchedApplied(
        [
          { id: 20, name: 'checkout_email' },
          { id: 22, name: 'crm_sink' },
        ],
        shipped,
      ),
    ).toEqual([{ id: 22, name: 'crm_sink' }]);
  });

  test('the shipped files pass against themselves', () => {
    expect(unmatchedApplied(files, files)).toEqual([]);
  });
});
