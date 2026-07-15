import type {
  Payment,
  PaymentDetail,
  CreatePaymentRequest,
  CancelPaymentRequest,
  CreateAccepted,
} from '@billing-service/shared';

import { apiFetch } from '../../infra/apiFetch.js';

export async function listPayments(externalUserId?: string): Promise<Payment[]> {
  const url = externalUserId
    ? `/api/payment?externalUserId=${encodeURIComponent(externalUserId)}`
    : '/api/payment';
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
