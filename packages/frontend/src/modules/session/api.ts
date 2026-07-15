export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Backend `SignInRequest` uses the field name `login`.
    body: JSON.stringify({ login: username, password }),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
}
