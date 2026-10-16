import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0021 — checkout renewal terms, session origin, renewal attribution.
 *
 * `checkout_sessions` gains three nullable columns:
 * - `renewal` (jsonb, same serialization as `promo`): `{"amount":5000,"period":"P4W"}`,
 *   the terms the subscription renews at when they differ from the first charge.
 * - `origin` (text): who minted the session — `prolong`, `manual_renewal`,
 *   `card_change`, `card_change_arrears`; NULL for a caller-created checkout and for
 *   every row minted before this migration.
 * - `"renewalOf"` (text): the subscription a `prolong`/`manual_renewal` session renews.
 *   A label only, so no FK.
 *
 * Backfill: a pre-deploy manual-renewal session is recognisable only by its idempotency
 * key, `manual:{subId}:{anchorMs}` (worker-boot.ts). The minter keeps reusing that same
 * session for the rest of the cycle after deploy, so it is labelled here; otherwise a
 * payment on it after the sub died would report `initial_*` instead of `recurring_*`.
 * `"idempotencyKey"` is shared with caller-supplied `Idempotency-Key` headers, so a key
 * that merely LOOKS like `manual:…` is not trusted: the row must be shaped like a minter
 * session (recurring Checkout, no paymentId) and the embedded id must be an existing
 * payment of the SAME contact. `p.id::text` compares as text, so a malformed segment
 * never reaches a uuid cast and cannot fail the migration. `origin IS NULL` makes a
 * re-run a no-op. A reissued clone of such a session has no key and stays unlabelled —
 * the documented legacy gap.
 *
 * The email sink's declared scope gains `recurring_payment_failed` (a failed prolong
 * mails the payer), appended once.
 *
 * Writes only `checkout_sessions` and `sinks`; reads `payments` (ACCESS SHARE, which
 * never conflicts with the running image's reads and row writes). `lock_timeout` is
 * first so a blocked ALTER fails the boot fast instead of stalling it — the migrator
 * runs every pending migration in one transaction, which `SET LOCAL` is scoped to.
 *
 * Additive and nullable — the previous image keeps reading and writing rows while this
 * is applied.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`SET LOCAL lock_timeout = '5s'`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS renewal jsonb`,
      sql`
        ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS origin text
          CHECK (origin IN ('prolong', 'manual_renewal', 'card_change', 'card_change_arrears'))
      `,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "renewalOf" text`,
      // kind = 0 is CheckoutSessionKind.Checkout.
      sql`
        UPDATE checkout_sessions cs
        SET origin = 'manual_renewal',
            "renewalOf" = split_part(cs."idempotencyKey", ':', 2)
        WHERE cs.origin IS NULL
          AND cs."idempotencyKey" LIKE 'manual:%'
          AND cs.recurring
          AND cs.kind = 0
          AND cs."paymentId" IS NULL
          AND EXISTS (
            SELECT 1 FROM payments p
            WHERE p.id::text = split_part(cs."idempotencyKey", ':', 2)
              AND p."externalUserId" = cs."externalUserId"
          )
      `,
      // kind = 2 is the email sink (seeded by 0020).
      sql`
        UPDATE sinks
        SET config = jsonb_set(config, '{events}', (config->'events') || '"recurring_payment_failed"'::jsonb)
        WHERE kind = 2 AND NOT (config->'events' ? 'recurring_payment_failed')
      `,
    ],
    { discard: true },
  ).pipe(Effect.asVoid),
);
