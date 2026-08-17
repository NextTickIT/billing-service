import { describe, expect, test } from 'vitest';

import {
  ackSignatureBase,
  callbackSignatureBase,
  purchaseSignatureBase,
  signVerify,
  verifySignatureBase,
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

describe('verifySignatureBase / signVerify', () => {
  const fields = {
    merchantAccount: 'test_merch_n1',
    merchantDomainName: 'shop.example',
    orderReference: 'chk_abc',
    amount: 0,
    currency: 'UAH',
  };

  test('joins the five verify fields in order', () => {
    expect(verifySignatureBase(fields)).toBe(
      'test_merch_n1;shop.example;chk_abc;0;UAH',
    );
  });

  test('signVerify reproduces a fixed vector (locks the algorithm)', () => {
    expect(signVerify(fields, 'flk3409refn54t54t*FNJRET')).toBe(
      '9748722f6530c42c5eaf41adef6bd2ea',
    );
  });
});
