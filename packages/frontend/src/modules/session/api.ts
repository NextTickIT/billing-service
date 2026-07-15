export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
}
