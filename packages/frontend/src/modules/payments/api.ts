import type {
  Payment,
  PaymentDetail,
  CreatePaymentRequest,
  CancelPaymentRequest,
  CreateAccepted,
  DeferPaymentRequest,
} from '@billing-service/shared';

import { apiFetch } from '@/infra/apiFetch.js';

export interface ListPaymentsFilter {
  externalUserId?: string;
  statuses?: number[];
  cancelling?: boolean;
}

export async function listPayments(
  filter?: ListPaymentsFilter,
): Promise<Payment[]> {
  const params = new URLSearchParams();
  if (filter?.externalUserId) {
    params.set('externalUserId', filter.externalUserId);
  }
  for (const s of filter?.statuses ?? []) {
    params.append('status', String(s));
  }
  if (filter?.cancelling === true) {
    params.set('cancelling', 'true');
  }
  const qs = params.toString();
  const url = qs ? `/api/payment?${qs}` : '/api/payment';
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<Payment[]>;
}

export async function getPayment(id: string): Promise<PaymentDetail> {
  const res = await apiFetch(`/api/payment/${id}`);
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<PaymentDetail>;
}

export async function cancelPayment(id: string, reason: string): Promise<void> {
  const body: CancelPaymentRequest = { reason };
  const res = await apiFetch(`/api/payment/${id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
}

export async function createPayment(
  body: CreatePaymentRequest,
): Promise<CreateAccepted> {
  const res = await apiFetch('/api/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<CreateAccepted>;
}

export async function reactivatePayment(id: string): Promise<void> {
  const res = await apiFetch(`/api/payment/${id}/reactivate`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
}

export async function deferPayment(id: string, days: number): Promise<void> {
  const body: DeferPaymentRequest = { days };
  const res = await apiFetch(`/api/payment/${id}/defer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
}
