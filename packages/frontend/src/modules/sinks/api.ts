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

/** `code` is the sink's stable path segment: 'sendpulse' or 'crm'. */
export async function updateSink(
  code: string,
  body: UpdateSinkRequest,
): Promise<SinkView> {
  const res = await apiFetch(`/api/sinks/${code}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<SinkView>;
}

/** Flows are a SendPulse concept; the CRM has none, so this stays hard-coded. */
export async function getSinkFlows(): Promise<SinkFlow[]> {
  const res = await apiFetch('/api/sinks/sendpulse/flows');
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<SinkFlow[]>;
}
