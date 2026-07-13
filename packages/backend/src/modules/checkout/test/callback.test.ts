import { Redacted } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  ackResponse,
  normalizeCallback,
  verifyCallback,
} from '@/modules/checkout/callback.js';
import type { W4pConfigService } from '@/modules/wayforpay/config.js';
import {
  callbackSignatureBase,
  hmacMd5Hex,
} from '@/modules/wayforpay/signature.js';

const config: W4pConfigService = {
  merchantAccount: 'm',
  merchantSecretKey: Redacted.make('sk'),
  merchantPassword: Redacted.make(''),
  apiUrl: '',
  regularApiUrl: '',
  merchantDomainName: 'd',
  checkoutUrl: '',
  serviceUrl: '',
  returnUrl: '',
};

const base = {
  merchantAccount: 'm',
  orderReference: 'chk_1',
  amount: '300',
  currency: 'UAH',
  authCode: 'a',
  cardPan: '44',
  transactionStatus: 'Approved',
  reasonCode: '1100',
};

const signed = {
  ...base,
  merchantSignature: hmacMd5Hex(callbackSignatureBase(base), 'sk'),
  recToken: 'tok',
  createdDate: '1700000000',
};

describe('verifyCallback', () => {
  test('accepts a correctly signed callback', () => {
    expect(verifyCallback(config, signed)).toBe(true);
  });

  test('rejects a tampered signature', () => {
    expect(
      verifyCallback(config, { ...signed, merchantSignature: 'bad' }),
    ).toBe(false);
  });
});

describe('normalizeCallback', () => {
  test('maps a callback into a standard incoming event', () => {
    const event = normalizeCallback(signed);
    expect(event.source).toBe('wayforpay_callback');
    expect(event.externalRef).toBe('chk_1');
    expect(event.idemKey).toBe('w4pcb:chk_1|Approved');
    expect(event.amount).toBe(30000);
    expect(event.currency).toBe(0); // UAH
    expect(event.status).toBe('succeeded');
    expect(event.payload['recToken']).toBe('tok');
  });
});

describe('ackResponse', () => {
  test('is a signed accept over orderReference;status;time', () => {
    const ack = ackResponse(config, 'chk_1', 100);
    expect(ack.status).toBe('accept');
    expect(ack.signature).toBe(hmacMd5Hex('chk_1;accept;100', 'sk'));
  });
});
