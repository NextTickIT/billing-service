import type { PaymentMethod } from '@billing-service/shared';
import type {
  CheckoutSessionPublic,
  PayInstruction,
} from '@billing-service/shared';

export type { CheckoutSessionPublic, PayInstruction };

/**
 * A failed checkout call, carrying the status so the page can say something a buyer
 * understands. `serverMessage` is kept ONLY for statuses whose body is written for a
 * human (WhitePay's below-minimum 422); every other status is translated from `status`,
 * because the generic bodies are internal strings — a buyer should never be shown
 * `Conflict: checkout session (expired) already exists`.
 */
export class CheckoutApiError extends Error {
  readonly status: number;
  readonly serverMessage: string | null;

  constructor(status: number, serverMessage: string | null) {
    super(`HTTP ${String(status)}`);
    this.name = 'CheckoutApiError';
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

export async function getCheckoutSession(
  id: string,
): Promise<CheckoutSessionPublic> {
  const res = await fetch(`/api/checkout-sessions/${id}`);
  if (!res.ok) throw new CheckoutApiError(res.status, null);
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
  if (!res.ok) {
    // 422 is the one status whose body explains something the buyer can act on (e.g.
    // WhitePay's below-minimum amount), so keep it. Everything else is translated from
    // the status — see CheckoutApiError.
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    const serverMessage =
      res.status === 422 && typeof body?.error === 'string' ? body.error : null;
    throw new CheckoutApiError(res.status, serverMessage);
  }
  return res.json() as Promise<PayInstruction>;
}
