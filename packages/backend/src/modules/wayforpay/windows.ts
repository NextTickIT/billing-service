/**
 * TRANSACTION_LIST window chunking: a range over ~31 days is rejected with
 * reasonCode 1109, so backfill walks the range in ≤30-day chunks (conservative,
 * under the cap). Chunks are contiguous and non-overlapping.
 */

/** One request interval (unix seconds, half-open [dateBegin, dateEnd]). */
export interface DateWindow {
  readonly dateBegin: number;
  readonly dateEnd: number;
}

/** Default chunk size (seconds): 30 days, with headroom under the ~31-day cap. */
export const DEFAULT_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/**
 * Split [from, to] (unix seconds) into consecutive windows of at most
 * `windowSeconds`, covering the whole range with no gaps or overlaps: each next
 * window starts one second after the previous ends, and the last ends exactly at
 * `to`. `to <= from` yields the single window [from, to].
 */
export const chunkWindows = (
  from: number,
  to: number,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
): DateWindow[] => {
  if (!(windowSeconds > 0)) {
    throw new Error(
      `chunkWindows: windowSeconds must be > 0, got ${String(windowSeconds)}`,
    );
  }
  if (to <= from) {
    return [{ dateBegin: from, dateEnd: to }];
  }
  const windows: DateWindow[] = [];
  let begin = from;
  while (begin <= to) {
    const end = Math.min(begin + windowSeconds - 1, to);
    windows.push({ dateBegin: begin, dateEnd: end });
    if (end >= to) {
      break;
    }
    begin = end + 1;
  }
  return windows;
};
