import type {
  SinkView,
  UpdateSinkRequest,
  SinkFlow,
} from '@billing-service/shared';

import { apiFetch } from '@/infra/apiFetch.js';

export async function getSinks(): Promise<SinkView[]> {
  const res = await apiFetch('/api/sinks');
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<SinkView[]>;
}

export async function updateSink(body: UpdateSinkRequest): Promise<SinkView> {
  const res = await apiFetch('/api/sinks/sendpulse', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<SinkView>;
}

export async function getSinkFlows(): Promise<SinkFlow[]> {
  const res = await apiFetch('/api/sinks/sendpulse/flows');
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<SinkFlow[]>;
}
