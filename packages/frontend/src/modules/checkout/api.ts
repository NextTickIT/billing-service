export interface CheckoutSessionPublic {
  id: string;
  amount: number;
  currency: number;
  period: string;
  status: number;
  expiresAt: string;
}

export interface WayForPayForm {
  action: string;
  fields: Record<string, string>;
}

export async function getCheckoutSession(
  id: string,
): Promise<CheckoutSessionPublic> {
  const res = await fetch(`/api/checkout-sessions/${id}`);
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<CheckoutSessionPublic>;
}

export async function payByCard(id: string): Promise<WayForPayForm> {
  const res = await fetch(`/api/checkout-sessions/${id}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 0 }),
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json() as Promise<WayForPayForm>;
}
