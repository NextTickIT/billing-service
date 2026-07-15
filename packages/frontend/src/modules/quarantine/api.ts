import type { QuarantineView } from '@billing-service/shared';

import { apiFetch } from '../../infra/apiFetch.js';

export type { QuarantineView };

export async function listQuarantine(): Promise<QuarantineView[]> {
  const res = await apiFetch('/api/quarantine');
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<QuarantineView[]>;
}

export async function bindQuarantine(id: string, paymentId: string): Promise<void> {
  const res = await apiFetch(`/api/quarantine/${id}/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ externalUserId: paymentId }),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
}
