import { describe, expect, test } from 'vitest';

import {
  buildSignatureBase,
  hmacMd5Hex,
  signRequest,
} from '@/modules/wayforpay/signature.js';

describe('buildSignatureBase', () => {
  test('TRANSACTION_LIST joins fields in the documented order', () => {
    expect(
      buildSignatureBase('TRANSACTION_LIST', {
        merchantAccount: 'm',
        dateBegin: 1,
        dateEnd: 2,
      }),
    ).toBe('m;1;2');
  });

  test('CHECK_STATUS joins fields in the documented order', () => {
    expect(
      buildSignatureBase('CHECK_STATUS', {
        merchantAccount: 'm',
        orderReference: 'o1',
      }),
    ).toBe('m;o1');
  });

  test('throws on a missing field (the order bug surfaces loudly)', () => {
    expect(() =>
      buildSignatureBase('CHECK_STATUS', { merchantAccount: 'm' }),
    ).toThrow(/orderReference/);
  });
});

describe('hmacMd5Hex', () => {
  test('reproduces a fixed vector (locks the algorithm)', () => {
    expect(
      hmacMd5Hex(
        'test_merch_n1;1735689600;1738368000',
        'flk3409refn54t54t*FNJRET',
      ),
    ).toBe('d208acef3e606c951023ee5cc02e672f');
  });
});

describe('signRequest', () => {
  test('signs a TRANSACTION_LIST request end to end', () => {
    expect(
      signRequest(
        'TRANSACTION_LIST',
        {
          merchantAccount: 'test_merch_n1',
          dateBegin: 1735689600,
          dateEnd: 1738368000,
        },
        'flk3409refn54t54t*FNJRET',
      ),
    ).toBe('d208acef3e606c951023ee5cc02e672f');
  });
});
