import { it } from '@effect/vitest';
import { Role } from '@billing-service/shared';
import { Effect, Layer, Redacted } from 'effect';
import { expect } from 'vitest';

import { HasherLive } from '@/infra/hasher.js';
import { makeAuthConfig } from '@/modules/auth/config.js';
import { isExpired, requireAdmin, requireRole } from '@/modules/auth/domain.js';

/**
 * Unit tests cover only the pure / non-DB guards — real `Hasher` (pure crypto)
 * and config, no repository. Everything that touches Postgres (create/sign-in/
 * authenticate) is exercised by the e2e tier against a real database, so no
 * test-only repository double exists.
 */
const ADMIN = 'admin-secret';

const authLayer = (adminToken = ADMIN) =>
  Layer.mergeAll(
    HasherLive,
    makeAuthConfig({
      adminToken: Redacted.make(adminToken),
      sessionTtlSeconds: 3600,
    }),
  );

it.effect('requireAdmin yields an Admin actor for the configured token', () =>
  requireAdmin(Redacted.make(ADMIN)).pipe(
    Effect.map((actor) => {
      expect(actor.role).toBe(Role.Admin);
    }),
    Effect.provide(authLayer()),
  ),
);

it.effect('requireAdmin rejects a wrong token as Unauthorized', () =>
  requireAdmin(Redacted.make('wrong')).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('Unauthorized');
    }),
    Effect.provide(authLayer()),
  ),
);

it.effect('requireAdmin fails closed when ADMIN_TOKEN is empty', () =>
  requireAdmin(Redacted.make('anything')).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('Unauthorized');
    }),
    Effect.provide(authLayer('')),
  ),
);

it.effect('requireRole passes when the actor holds the required role', () =>
  requireRole({ role: Role.Admin }, Role.Admin),
);

it.effect('requireRole rejects a mismatched role as Forbidden', () =>
  requireRole({ role: Role.Operator }, Role.Admin).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('Forbidden');
    }),
  ),
);

it('isExpired compares a session expiry to a wall-clock time', () => {
  const base = {
    id: 's_1',
    operatorId: 'op_1',
    role: Role.Operator,
    createdAt: new Date(0),
  };
  expect(isExpired({ ...base, expiresAt: new Date(10_000) }, 5_000)).toBe(
    false,
  );
  expect(isExpired({ ...base, expiresAt: new Date(5_000) }, 10_000)).toBe(true);
});
