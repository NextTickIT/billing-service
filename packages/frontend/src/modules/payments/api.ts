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
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PaymentRecord[]>;
}

export async function getPayment(id: string): Promise<PaymentRecord> {
  const res = await fetch(`/api/payment/${id}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PaymentRecord>;
}

export async function cancelPayment(
  id: string,
  reason: string,
): Promise<void> {
  const res = await fetch(`/api/payment/${id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function createPayment(
  body: CreatePaymentBody,
): Promise<PaymentRecord> {
  const res = await fetch('/api/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PaymentRecord>;
}
