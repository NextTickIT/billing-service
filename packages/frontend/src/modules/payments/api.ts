import { apiFetch } from '../../infra/apiFetch.js';

export interface ChargeRecord {
  id: string;
  amount: number;
  currency: number;
  chargeDate: string;
  providerStatus: string;
  matchResult: string | null;
}

export interface PaymentRecord {
  id: string;
  externalUserId: string;
  amount: number;
  currency: number;
  period: string;
  status: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  nextPaymentDate: string;
  charges?: ChargeRecord[];
}

export interface CreatePaymentBody {
  externalUserId: string;
  amount: number;
  currency: number;
  period: string;
  method: number;
}

export async function listPayments(
  externalUserId?: string,
): Promise<PaymentRecord[]> {
  const url = externalUserId
    ? `/api/payment?externalUserId=${encodeURIComponent(externalUserId)}`
    : '/api/payment';
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<PaymentRecord[]>;
}

export async function getPayment(id: string): Promise<PaymentRecord> {
  const res = await apiFetch(`/api/payment/${id}`);
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<PaymentRecord>;
}

export async function cancelPayment(
  id: string,
  reason: string,
): Promise<void> {
  const res = await apiFetch(`/api/payment/${id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
}

export async function createPayment(
  body: CreatePaymentBody,
): Promise<PaymentRecord> {
  const res = await apiFetch('/api/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<PaymentRecord>;
}
