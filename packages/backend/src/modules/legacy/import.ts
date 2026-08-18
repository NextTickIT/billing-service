import type { SqlError } from '@effect/sql';
import { Cause, Clock, Duration, Effect, Option } from 'effect';

import type { Charge } from '@/modules/charge/contracts.js';
import type { ChargeRepo } from '@/modules/charge/data-access.js';
import type { SendPulseClient } from '@/modules/legacy/client.js';
import {
  externalUserIdOf,
  LEGACY_SOURCE,
  type SpError,
  type SpPayment,
} from '@/modules/legacy/contracts.js';
import {
  deriveExternalPayment,
  type DerivedExternal,
  resolveExternalStatus,
} from '@/modules/legacy/derive.js';
import { deriveMethod, mapPayment } from '@/modules/legacy/mapping.js';
import type { LegacySyncStateRepo } from '@/modules/legacy/sync-state.js';
import { PaymentOrigin } from '@billing-service/shared';
import type { PaymentRepo } from '@/modules/payment/data-access.js';

/**
 * Legacy import (docs/25 §4). Reads SendPulse CRM payments, groups them by contact,
 * and writes one read-only `external` Payment per contact plus its charge history —
 * **emitting no domain events** (§4.5). Idempotent: `upsertExternal` dedups the
 * Payment and `idemKey`/`incomingEventId` dedup the charges, so a re-run updates
 * rather than duplicates. It is the whole-system caller of the module's pure parts
 * (client / mapping / derive), so none of them is dead test-only code (docs/16 §4).
 */
export interface ImportDeps {
  readonly client: Pick<SendPulseClient, 'listPayments'>;
  readonly payments: Pick<
    PaymentRepo,
    'findActiveByExternalUser' | 'upsertExternal'
  >;
  readonly charges: Pick<
    ChargeRepo,
    'transaction' | 'upsertIncomingCharge' | 'setMatchResult' | 'insertPayment'
  >;
  readonly state: LegacySyncStateRepo;
}

export interface ImportConfig {
  readonly pollIntervalSeconds: number;
}

export interface ImportResult {
  readonly contacts: number;
  readonly imported: number;
  readonly skipped: number;
}

/** Epoch ms of a payment's `createdAt`; an absent/unparseable value sorts as 0. */
const createdAtMs = (payment: SpPayment): number => {
  const ms =
    payment.createdAt === undefined ? 0 : Date.parse(payment.createdAt);
  return Number.isNaN(ms) ? 0 : ms;
};

/** Bucket SendPulse payments by contact; rows without a contact can't be attributed. */
const groupByContact = (
  payments: readonly SpPayment[],
): Map<string, SpPayment[]> => {
  const groups = new Map<string, SpPayment[]>();
  for (const payment of payments) {
    if (payment.contactId === undefined) {
      continue;
    }
    const key = String(payment.contactId);
    const list = groups.get(key) ?? [];
    list.push(payment);
    groups.set(key, list);
  }
  return groups;
};

const maxCreatedAt = (group: readonly SpPayment[]): number =>
  group.reduce((max, payment) => Math.max(max, createdAtMs(payment)), 0);

/** The payment method of the most recent payment in the group (drives the Payment). */
const latestMethod = (group: readonly SpPayment[]): string | undefined => {
  let latest: SpPayment | undefined;
  let latestMs = -Infinity;
  for (const payment of group) {
    const ms = createdAtMs(payment);
    if (ms >= latestMs) {
      latestMs = ms;
      latest = payment;
    }
  }
  return latest?.paymentMethod;
};

/** The new watermark: the newest `createdAt` seen, never past `now` nor regressing. */
const advanceWatermark = (
  payments: readonly SpPayment[],
  watermark: Option.Option<Date>,
  now: Date,
): Date => {
  const maxMs = payments.reduce((m, p) => Math.max(m, createdAtMs(p)), 0);
  const existing = Option.isSome(watermark) ? watermark.value.getTime() : 0;
  const base = Math.max(maxMs, existing);
  return new Date(base === 0 ? now.getTime() : Math.min(base, now.getTime()));
};

/** Record one mapped charge raw and fix it to the Payment (idempotent, matched). */
const fixCharge =
  (deps: ImportDeps, paymentId: string, externalUserId: string) =>
  (charge: Charge): Effect.Effect<void, SqlError.SqlError> =>
    Effect.gen(function* () {
      const id = yield* deps.charges.upsertIncomingCharge(charge);
      yield* deps.charges.setMatchResult(id, 'matched');
      yield* deps.charges.insertPayment({
        incomingEventId: id,
        paymentId,
        externalUserId,
        amount: charge.amount,
        currency: charge.currency,
        source: charge.source,
        occurredAt: charge.occurredAt,
      });
    });

interface ContactWrite {
  readonly externalUserId: string;
  readonly method: number;
  readonly derived: DerivedExternal;
  readonly charges: readonly Charge[];
}

/** Upsert the external Payment (status guarded), then fix each charge to it. */
const writeContact = (
  deps: ImportDeps,
  input: ContactWrite,
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function* () {
    const active = yield* deps.payments.findActiveByExternalUser(
      input.externalUserId,
    );
    const conflicting =
      Option.isSome(active) && active.value.origin !== PaymentOrigin.External;
    const payment = yield* deps.payments.upsertExternal({
      externalUserId: input.externalUserId,
      amount: input.derived.amount,
      currency: input.derived.currency,
      method: input.method,
      period: input.derived.period,
      status: resolveExternalStatus(input.derived.status, conflicting),
      currentPeriodStart: input.derived.currentPeriodStart,
      currentPeriodEnd: input.derived.currentPeriodEnd,
      nextPaymentDate: input.derived.nextPaymentDate,
    });
    yield* Effect.forEach(
      input.charges,
      fixCharge(deps, payment.id, input.externalUserId),
      { discard: true },
    );
  });

/** Import one contact's payments in a single transaction (all-or-nothing per user). */
const importContact = (
  deps: ImportDeps,
  contactId: string,
  group: readonly SpPayment[],
  now: Date,
): Effect.Effect<void, SqlError.SqlError> => {
  const charges = group.map(mapPayment).filter((c): c is Charge => c !== null);
  if (charges.length === 0) {
    return Effect.void;
  }
  return deps.charges.transaction(
    writeContact(deps, {
      externalUserId: externalUserIdOf(contactId),
      method: deriveMethod(latestMethod(group)),
      derived: deriveExternalPayment(charges, now),
      charges,
    }),
  );
};

interface GroupOutcome {
  readonly imported: number;
  readonly skipped: number;
}

/**
 * Import a contact group, unless the watermark already covers its newest payment
 * (incremental skip). A failing contact is logged and skipped, never aborting the
 * whole run — one bad row must not strand the rest (docs/16 §14, mirroring the poller).
 */
const importGroup =
  (deps: ImportDeps, watermark: Option.Option<Date>, now: Date) =>
  ([contactId, group]: readonly [string, readonly SpPayment[]]): Effect.Effect<
    GroupOutcome,
    SqlError.SqlError
  > => {
    if (
      Option.isSome(watermark) &&
      maxCreatedAt(group) <= watermark.value.getTime()
    ) {
      return Effect.succeed({ imported: 0, skipped: 1 });
    }
    return importContact(deps, contactId, group, now).pipe(
      Effect.as({ imported: 1, skipped: 0 }),
      Effect.catchAllCause((cause) =>
        Effect.logError('legacy import: contact failed')
          .pipe(Effect.annotateLogs({ contactId, cause: Cause.pretty(cause) }))
          .pipe(Effect.as({ imported: 0, skipped: 1 })),
      ),
    );
  };

/** One full pass: fetch, group, import (incremental by watermark), advance watermark. */
export const importTick = (
  deps: ImportDeps,
  now: Date,
): Effect.Effect<ImportResult, SpError | SqlError.SqlError> =>
  Effect.gen(function* () {
    const payments = yield* deps.client.listPayments();
    const watermark = yield* deps.state.getWatermark(LEGACY_SOURCE);
    const entries = [...groupByContact(payments)];
    const outcomes = yield* Effect.forEach(
      entries,
      importGroup(deps, watermark, now),
    );
    yield* deps.state.upsertWatermark(
      LEGACY_SOURCE,
      advanceWatermark(payments, watermark, now),
    );
    return {
      contacts: entries.length,
      imported: outcomes.reduce((n, o) => n + o.imported, 0),
      skipped: outcomes.reduce((n, o) => n + o.skipped, 0),
    };
  });

const tickNow = (
  deps: ImportDeps,
): Effect.Effect<ImportResult, SpError | SqlError.SqlError> =>
  Effect.flatMap(Clock.currentTimeMillis, (ms) =>
    importTick(deps, new Date(ms)),
  );

/**
 * The steady-state loop: tick, log, sleep, repeat forever — resilient to faults (a
 * failed tick is logged and the next tick retries). First run is the full backfill;
 * later ticks are incremental by the watermark. Gated off by default (worker boot).
 */
export const runLegacyImport = (
  deps: ImportDeps,
  config: ImportConfig,
): Effect.Effect<never> =>
  tickNow(deps)
    .pipe(
      Effect.tap((result) =>
        Effect.logInfo('legacy import tick').pipe(
          Effect.annotateLogs({
            contacts: result.contacts,
            imported: result.imported,
            skipped: result.skipped,
          }),
        ),
      ),
      Effect.catchAllCause((cause) =>
        Effect.logError('legacy import tick failed').pipe(
          Effect.annotateLogs('cause', Cause.pretty(cause)),
        ),
      ),
    )
    .pipe(
      Effect.andThen(
        Effect.sleep(Duration.seconds(config.pollIntervalSeconds)),
      ),
      Effect.forever,
    );
