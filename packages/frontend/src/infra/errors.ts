// A fetch() network failure surfaces as a TypeError ("Failed to fetch"); an HTTP
// error or a bug does not. Callers that legitimately tolerate offline blips (a
// poll loop) check this and rethrow everything else — never a bare catch that
// assumes the only possible error is the one it wanted to ignore.
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}
