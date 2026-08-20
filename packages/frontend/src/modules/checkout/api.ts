import type { PaymentMethod } from '@billing-service/shared';
import type {
  CheckoutSessionPublic,
  PayInstruction,
} from '@billing-service/shared';

export type { CheckoutSessionPublic, PayInstruction };

export async function getCheckoutSession(
  id: string,
): Promise<CheckoutSessionPublic> {
  const res = await fetch(`/api/checkout-sessions/${id}`);
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<CheckoutSessionPublic>;
}

/**
 * Select a method and get the handoff: a card method returns a `form` to POST to
 * WayForPay; a crypto method returns a `redirect` to the WhitePay hosted page (the
 * page branches on `kind`).
 */
export async function pay(
  id: string,
  method: PaymentMethod,
): Promise<PayInstruction> {
  const res = await fetch(`/api/checkout-sessions/${id}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method }),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<PayInstruction>;
}
