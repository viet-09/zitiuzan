import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_MIGRATION_MARKER,
  USER_SCOPED_STORAGE_KEYS,
  clearUserScopedStorage,
  migrateLegacyStorage,
  shouldRunLegacyMigration,
} from '../js/account-storage.js';
import { createFakeStorage } from './helpers/fake-storage.mjs';

test('legacy migration runs only once globally, not once for every account', () => {
  assert.equal(shouldRunLegacyMigration(null), true);
  assert.equal(shouldRunLegacyMigration('first-user-id'), false);
  assert.equal(shouldRunLegacyMigration('1'), false);
});

test('sign-out clears user data but preserves device preferences', () => {
  const storage = createFakeStorage({
    n2_progress_v2: '{"k1d1":true}',
    n2_tutor_v2: '[{"role":"user","text":"private"}]',
    n2_profile_v2: '{"name":"User A"}',
    n2_settings_v2: '{"furigana":false}',
    n2_pet_v2: '{"petType":"cat"}',
  });

  clearUserScopedStorage(storage);
  const snapshot = storage.snapshot();

  for (const key of USER_SCOPED_STORAGE_KEYS) assert.equal(snapshot[key], undefined);
  assert.equal(snapshot.n2_settings_v2, '{"furigana":false}');
  assert.equal(snapshot.n2_pet_v2, '{"petType":"cat"}');
});

test('migration never deletes local data after a partial cloud failure', async () => {
  const storage = createFakeStorage({
    n2_progress_v2: '{"k1d1":true}',
    n2_tutor_v2: '[{"role":"user","text":"keep me"}]',
  });
  let calls = 0;

  await assert.rejects(
    migrateLegacyStorage({
      storage,
      userId: 'user-b',
      definitions: {
        n2_progress_v2: { table: 'learning_progress', map: () => [{ lesson_id: 'k1d1' }] },
        n2_tutor_v2: { table: 'tutor_messages', map: () => [{ text: 'keep me' }] },
      },
      upsert: async () => {
        calls += 1;
        return calls === 2 ? { error: new Error('network down') } : { error: null };
      },
    }),
    /network down/,
  );

  assert.equal(storage.getItem('n2_progress_v2'), '{"k1d1":true}');
  assert.equal(storage.getItem('n2_tutor_v2'), '[{"role":"user","text":"keep me"}]');
  assert.equal(storage.getItem(LEGACY_MIGRATION_MARKER), null);
});

test('successful migration marks once and removes migrated user keys', async () => {
  const storage = createFakeStorage({ n2_progress_v2: '{"k1d1":true}' });

  const result = await migrateLegacyStorage({
    storage,
    userId: 'user-a',
    definitions: {
      n2_progress_v2: { table: 'learning_progress', map: () => [{ lesson_id: 'k1d1' }] },
    },
    upsert: async () => ({ error: null }),
  });

  assert.equal(result.migrated, true);
  assert.equal(storage.getItem('n2_progress_v2'), null);
  assert.equal(storage.getItem(LEGACY_MIGRATION_MARKER), '1');
});
