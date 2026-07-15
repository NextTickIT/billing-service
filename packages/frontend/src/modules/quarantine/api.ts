export interface QuarantineRecord {
  id: string;
  externalRef: string | null;
  source: string;
  rawPayload: Record<string, unknown>;
  createdAt: string;
}

export async function listQuarantine(): Promise<QuarantineRecord[]> {
  const res = await fetch('/api/quarantine', { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<QuarantineRecord[]>;
}

export async function bindQuarantine(id: string, paymentId: string): Promise<void> {
  const res = await fetch(`/api/quarantine/${id}/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentId }),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
}
