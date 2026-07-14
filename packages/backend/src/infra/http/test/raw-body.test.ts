import { describe, expect, test } from 'vitest';

import { parseRawBody } from '@/infra/http/raw-body.js';

describe('parseRawBody', () => {
  test('parses a raw JSON body (WayForPay callback, non-JSON content-type)', () => {
    const body = '{"transactionStatus":"Approved","amount":300}';
    expect(parseRawBody(body)).toEqual({
      transactionStatus: 'Approved',
      amount: 300,
    });
  });

  test('parses the form-encoded "the whole JSON is the first key" shape', () => {
    const json = '{"orderReference":"chk_1","transactionStatus":"Declined"}';
    const body = `${encodeURIComponent(json)}=`;
    expect(parseRawBody(body)).toEqual({
      orderReference: 'chk_1',
      transactionStatus: 'Declined',
    });
  });

  test('an unparseable or empty body yields {}, never a throw', () => {
    expect(parseRawBody('not json at all')).toEqual({});
    expect(parseRawBody('')).toEqual({});
  });
});
