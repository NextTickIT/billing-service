// Clears the client-side auth flag and redirects to login on 401 so that the
// guard (which reads localStorage, not the HttpOnly cookie) picks it up.
function handleUnauthorized(): void {
  localStorage.removeItem('operator_authed');
  window.location.href = '/operator/login';
}

export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, { credentials: 'include', ...init });
  if (res.status === 401) {
    handleUnauthorized();
    // Return the response so callers can still inspect it, but the redirect
    // will fire before any meaningful UI update runs.
    return res;
  }
  return res;
}
