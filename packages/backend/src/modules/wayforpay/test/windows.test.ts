import { describe, expect, test } from 'vitest';

import {
  chunkWindows,
  DEFAULT_WINDOW_SECONDS,
} from '@/modules/wayforpay/windows.js';

describe('chunkWindows', () => {
  test('a range within the size is a single window', () => {
    expect(chunkWindows(0, 100, 1000)).toEqual([
      { dateBegin: 0, dateEnd: 100 },
    ]);
  });

  test('to <= from yields one degenerate window', () => {
    expect(chunkWindows(50, 50, 1000)).toEqual([
      { dateBegin: 50, dateEnd: 50 },
    ]);
  });

  test('splits into contiguous, non-overlapping windows ending exactly at to', () => {
    expect(chunkWindows(0, 25, 10)).toEqual([
      { dateBegin: 0, dateEnd: 9 },
      { dateBegin: 10, dateEnd: 19 },
      { dateBegin: 20, dateEnd: 25 },
    ]);
  });

  test('default window is 30 days (under the ~31-day cap)', () => {
    expect(DEFAULT_WINDOW_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});
