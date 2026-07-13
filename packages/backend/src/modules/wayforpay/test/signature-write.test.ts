import { describe, expect, test } from 'vitest';

import {
  ackSignatureBase,
  callbackSignatureBase,
  purchaseSignatureBase,
} from '@/modules/wayforpay/signature.js';

describe('purchaseSignatureBase', () => {
  test('head fields, then all names, then all counts, then all prices', () => {
    expect(
      purchaseSignatureBase({
        merchantAccount: 'm',
        merchantDomainName: 'd',
        orderReference: 'o',
        orderDate: 100,
        amount: 300,
        currency: 'UAH',
        products: [
          { name: 'A', count: 1, price: 200 },
          { name: 'B', count: 2, price: 100 },
        ],
      }),
    ).toBe('m;d;o;100;300;UAH;A;B;1;2;200;100');
  });
});

describe('callbackSignatureBase', () => {
  test('the eight callback fields in the documented order', () => {
    expect(
      callbackSignatureBase({
        merchantAccount: 'm',
        orderReference: 'o',
        amount: '300',
        currency: 'UAH',
        authCode: 'a',
        cardPan: '44',
        transactionStatus: 'Approved',
        reasonCode: '1100',
      }),
    ).toBe('m;o;300;UAH;a;44;Approved;1100');
  });
});

describe('ackSignatureBase', () => {
  test('orderReference;status;time', () => {
    expect(ackSignatureBase('o', 'accept', 100)).toBe('o;accept;100');
  });
});
