import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  transactionExternalId,
  W4pTransactionListResponseSchema,
} from '@/modules/wayforpay/contracts.js';

describe('transactionExternalId', () => {
  test('is ref|type|createdDate so a REFUND never overwrites the PURCHASE', () => {
    const purchase = transactionExternalId({
      orderReference: 'o1',
      transactionType: 'PURCHASE',
      createdDate: '100',
    });
    const refund = transactionExternalId({
      orderReference: 'o1',
      transactionType: 'REFUND',
      createdDate: '200',
    });
    expect(purchase).toBe('o1|PURCHASE|100');
    expect(refund).toBe('o1|REFUND|200');
    expect(purchase).not.toBe(refund);
  });
});

describe('permissive decode', () => {
  test('tolerates unknown fields and numeric money/date values', () => {
    const decoded = Schema.decodeUnknownSync(W4pTransactionListResponseSchema, {
      onExcessProperty: 'preserve',
    })({
      reasonCode: 1100,
      transactionList: [
        {
          orderReference: 'o1',
          amount: 10.1,
          createdDate: 100,
          surpriseField: 'x',
        },
      ],
    });
    expect(decoded.transactionList?.[0]?.orderReference).toBe('o1');
    expect(decoded.transactionList?.[0]?.amount).toBe(10.1);
  });
});
