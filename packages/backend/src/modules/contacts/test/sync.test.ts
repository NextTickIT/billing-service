import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { SinkError } from '@/infra/sinks.js';
import type { ContactsRepo } from '@/modules/contacts/data-access.js';
import { contactsSyncTick } from '@/modules/contacts/sync.js';
import type { ContactProfile } from '@/modules/sinks/sendpulse.js';

const config = { intervalSeconds: 60, ttlSeconds: 3600, batchSize: 100 };

const profile = (name: string): ContactProfile => ({
  name,
  username: '',
  email: '',
  phone: '',
});

it.effect('a sync tick fetches + upserts every stale contact', () => {
  const upserted: { id: string; name: string }[] = [];
  const contacts: ContactsRepo = {
    staleContactIds: () => Effect.succeed(['c1', 'c2']),
    upsert: (id, p) =>
      Effect.sync(() => {
        upserted.push({ id, name: p.name });
      }),
  };
  return contactsSyncTick(
    { contacts, fetchProfile: (id) => Effect.succeed(profile(`name-${id}`)) },
    config,
  ).pipe(
    Effect.map((count) => {
      expect(count).toBe(2);
      expect(upserted.map((u) => u.id).sort()).toEqual(['c1', 'c2']);
      expect(upserted.find((u) => u.id === 'c1')?.name).toBe('name-c1');
    }),
  );
});

it.effect(
  'a failed fetch is isolated — the rest of the batch still upserts',
  () => {
    const upserted: string[] = [];
    const contacts: ContactsRepo = {
      staleContactIds: () => Effect.succeed(['ok', 'bad']),
      upsert: (id) =>
        Effect.sync(() => {
          upserted.push(id);
        }),
    };
    const fetchProfile = (id: string) =>
      id === 'bad'
        ? Effect.fail(new SinkError({ sink: 'sendpulse', reason: 'boom' }))
        : Effect.succeed(profile('ok'));
    return contactsSyncTick({ contacts, fetchProfile }, config).pipe(
      Effect.map(() => {
        expect(upserted).toEqual(['ok']); // 'bad' failed → skipped, no crash
      }),
    );
  },
);
