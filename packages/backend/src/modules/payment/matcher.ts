import { Effect, Option } from 'effect';

import type { ChargeMatcher } from '@/modules/charge/contracts.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';

/**
 * Prefix used when minting orderReferences for our recurring charges and when
 * parsing them back in the recurring matcher. A single constant prevents the
 * scheduler and the matcher from drifting apart (F-F).
 */
export const PAYMENT_ORDER_PREFIX = 'sub_';

/** Our recurring-charge orderReference format: `sub_<subscriptionId>_<...>`. */
const OUR_REF = new RegExp(`^${PAYMENT_ORDER_PREFIX}([0-9a-fA-F-]+)_`);

/**
 * Recurring matcher: a succeeded charge whose orderReference is one WE minted
 * (`sub_<id>_…`) resolves to that payment. Legacy `_WFPREG-` charges are not
 * ours — they carry no gateway payment yet and fall through to quarantine
 * (the migration tail; docs/15).
 */
export const makeRecurringMatcher =
  (repo: PaymentRepo): ChargeMatcher =>
  (event) =>
    Effect.gen(function* () {
      if (event.status !== 'succeeded') {
        return { matched: false };
      }
      const id = OUR_REF.exec(event.externalRef)?.[1];
      if (id === undefined) {
        return { matched: false };
      }
      const found = yield* repo.findById(id);
      if (Option.isNone(found)) {
        return { matched: false };
      }
      const sub = found.value;
      // The terms the charge was made on: the scheduler's snapshot when it sent one, so a
      // plan or method changed while the message waited cannot rewrite what was charged.
      const charged = event.settlement ?? sub;
      return {
        matched: true,
        kind: 'recurring',
        subscriptionId: sub.id,
        externalUserId: sub.externalUserId,
        period: charged.period,
        method: charged.method,
        // The last declaration made for this payment, so a renewal event carries intent.
        metadata: sub.metadata,
      };
    });
