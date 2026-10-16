import { fileURLToPath } from 'node:url';

import {
  callbackSignatureBase,
  hmacMd5Hex,
} from '@/modules/wayforpay/signature.js';

/**
 * Shared HTTP e2e helpers (`edge.e2e.ts`, `prolong.e2e.ts`): the scenario shape, the
 * real Cloudflare Pages BFF handler loaded from the frontend package, and a signed
 * WayForPay callback.
 */

interface BffEnv {
  readonly BACKEND_ORIGIN: string;
  readonly BFF_SECRET: string;
}

interface BffEventContext {
  readonly request: Request;
  readonly env: BffEnv;
  readonly params: Record<string, string | string[]>;
  readonly data: Record<string, unknown>;
  readonly next: (input?: Request | string) => Promise<Response>;
}

export type BffHandler = (ctx: BffEventContext) => Promise<Response>;

export interface E2eContext {
  readonly baseUrl: string;
  readonly query: (sql: string) => Promise<string>;
}

export interface Scenario {
  readonly name: string;
  readonly run: (ctx: E2eContext) => Promise<void>;
}

export const ADMIN_TOKEN = 'e2e-admin-token';
export const BFF_SECRET = 'e2e-bff-secret';
// The e2e runner sets a non-empty W4P_SECRET_KEY (run.ts setAppEnv); the hardened
// callback fail-closes on an empty key, so we sign with the same shared secret.
// merchantAccount stays empty on both sides (only the secret gates verification).
export const MERCHANT_ACCOUNT = '';
export const MERCHANT_SECRET = 'e2e-w4p-secret';

export async function loadBffHandler(): Promise<BffHandler> {
  const bffPath = fileURLToPath(
    new URL('../../../frontend/functions/api/[[path]].ts', import.meta.url),
  );
  const mod = (await import(bffPath)) as { onRequest: BffHandler };
  return mod.onRequest;
}

export function makeBff(
  handler: BffHandler,
  backendOrigin: string,
): (request: Request) => Promise<Response> {
  return (request: Request) =>
    handler({
      request,
      env: { BACKEND_ORIGIN: backendOrigin, BFF_SECRET },
      params: {},
      data: {},
      next: () => Promise.resolve(new Response(null, { status: 404 })),
    });
}

export const postJson = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

export function signCallback(
  payload: Record<string, string>,
): Record<string, string> {
  const signature = hmacMd5Hex(
    callbackSignatureBase({
      merchantAccount: payload['merchantAccount'] ?? '',
      orderReference: payload['orderReference'] ?? '',
      amount: payload['amount'] ?? '',
      currency: payload['currency'] ?? '',
      authCode: payload['authCode'] ?? '',
      cardPan: payload['cardPan'] ?? '',
      transactionStatus: payload['transactionStatus'] ?? '',
      reasonCode: payload['reasonCode'] ?? '',
    }),
    MERCHANT_SECRET,
  );
  return { ...payload, merchantSignature: signature };
}
