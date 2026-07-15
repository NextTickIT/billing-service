import { apiFetch } from '../../infra/apiFetch.js';

export interface QuarantineRecord {
  id: string;
  externalRef: string | null;
  amount: number | null;
  currency: number | null;
  source: string;
  rawPayload: Record<string, unknown>;
  occurredAt: string | null;
  createdAt: string;
}

export async function listQuarantine(): Promise<QuarantineRecord[]> {
  const res = await apiFetch('/api/quarantine');
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<QuarantineRecord[]>;
}

export async function bindQuarantine(id: string, paymentId: string): Promise<void> {
  const res = await apiFetch(`/api/quarantine/${id}/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentId }),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
}
