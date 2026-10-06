import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0020 — the payer's email, on the purchase.
 *
 * A receipt cannot be addressed through SendPulse. A first-time buyer has no chatbot
 * contact (SendPulse creates one only on first interaction, and no API can create one),
 * so the id billing holds is unreachable for exactly the people who have just paid.
 * Email is the only channel that needs no pre-existing contact, so the address lives on
 * the purchase intent: captured at checkout, then copied onto the payment so a renewal
 * receipt still has somewhere to go a month later.
 *
 * NOT on `contacts`: that table calls itself "purely a cache — safe to drop and
 * re-sync", and its sync upserts the whole SendPulse profile on success, which would
 * wipe an address SendPulse does not know about.
 *
 * Both columns are `NOT NULL DEFAULT ''`, so the previous image can keep writing rows
 * while this is applied — safe under a rolling deploy.
 *
 * ── MIGRATION ID, READ BEFORE MERGING ────────────────────────────────────────────
 * 0020 is the next free id on the `hotfix` line (production is at 19).
 * `feat/one-time-payments-and-redirects` ALSO carries 0020/0021/0022. Merging the two
 * lines MUST renumber one side, and this file is numbered deliberately so the failure
 * is loud: two files sharing id 20 make the migrator abort with "duplicates". Numbering
 * this ABOVE theirs instead would make the migrator silently skip theirs
 * (`if (currentId <= latestMigrationId) continue;` — no name check) and leave
 * `domain_events."idempotencyKey"` missing, which breaks every event publish.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT ''`,
      sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT ''`,
      // Seed the email sink DISABLED, exactly as 0011 seeds the chatbot one: the
      // operator route merges onto an existing row and 404s without one, so a sink
      // that is never seeded can never be configured. Credentials are left blank on
      // purpose — they are entered through `PUT /api/sinks/email`, not committed here.
      //
      // `events` is pre-filled with the three success receipts so that enabling the
      // row actually sends something; an empty list would be a silently inert sink.
      // The failure-side templates (initial_payment_failed, renewal_failed,
      // payment_manual_required) exist but are a product decision — add them when you
      // want them.
      sql`
        INSERT INTO sinks (kind, enabled, auth, config, "updatedAt")
        VALUES (2, false,
                ${JSON.stringify({ kind: 0, token: '' })}::jsonb,
                ${JSON.stringify({
                  clientId: '',
                  from: { name: 'NextTick', email: '' },
                  replyTo: '',
                  events: [
                    'initial_payment_succeeded',
                    'recurring_payment_succeeded',
                    'one_time_purchase_succeeded',
                  ],
                })}::jsonb,
                now())
        ON CONFLICT (kind) DO NOTHING
      `,
    ],
    { discard: true },
  ).pipe(Effect.asVoid),
);
