import { PaymentMethod } from '@billing-service/shared';
import type { CheckoutSessionPublic, PurchaseForm } from '@billing-service/shared';

export type { CheckoutSessionPublic, PurchaseForm };

export async function getCheckoutSession(
  id: string,
): Promise<CheckoutSessionPublic> {
  const res = await fetch(`/api/checkout-sessions/${id}`);
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<CheckoutSessionPublic>;
}

export async function payByCard(id: string): Promise<PurchaseForm> {
  const res = await fetch(`/api/checkout-sessions/${id}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: PaymentMethod.Card }),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<PurchaseForm>;
}
