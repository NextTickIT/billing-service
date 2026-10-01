import { describe, expect, test } from 'vitest';

import { redirectHostAllowed } from '@/modules/checkout/domain.js';

describe('redirectHostAllowed', () => {
  test('an empty allowlist accepts any http(s) host (dev default)', () => {
    expect(redirectHostAllowed([], 'https://anything.example/done')).toBe(true);
  });

  test('accepts a listed host, rejects an unlisted one', () => {
    const allowed = ['app.nexttick.it'];
    expect(redirectHostAllowed(allowed, 'https://app.nexttick.it/ok')).toBe(
      true,
    );
    expect(redirectHostAllowed(allowed, 'https://evil.example/ok')).toBe(false);
  });

  test('matches by hostname, ignoring port and path', () => {
    expect(
      redirectHostAllowed(
        ['app.nexttick.it'],
        'https://app.nexttick.it:8443/x',
      ),
    ).toBe(true);
  });

  test('rejects a malformed url when an allowlist is set', () => {
    expect(redirectHostAllowed(['app.nexttick.it'], 'not a url')).toBe(false);
  });
});
