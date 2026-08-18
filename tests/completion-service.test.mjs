import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompletionService } from '../js/completion-service.js';

test('lesson completion uses one authoritative server mutation', async () => {
  const calls = [];
  let writtenStreak = null;
  const service = createCompletionService({
    toggleLocal: () => true,
    getCurrentUser: async () => ({ id: 'user-1' }),
    syncRemote: async (payload) => {
      calls.push(payload);
      return { streak: 4, lastDate: '2026-08-18' };
    },
    queueMutation: () => assert.fail('must not queue a successful mutation'),
    writeStreak: (value) => { writtenStreak = value; },
  });

  const result = await service.toggle({ lessonId: 'k1d1', categoryId: 'kanji' });

  assert.deepEqual(calls, [{ lessonId: 'k1d1', categoryId: 'kanji', done: true }]);
  assert.deepEqual(writtenStreak, { streak: 4, lastDate: '2026-08-18' });
  assert.deepEqual(result, { done: true, synced: true });
});

test('failed server mutations are retained for retry without losing local progress', async () => {
  const queued = [];
  const service = createCompletionService({
    toggleLocal: () => false,
    getCurrentUser: async () => ({ id: 'user-1' }),
    syncRemote: async () => { throw new Error('offline'); },
    queueMutation: (mutation) => queued.push(mutation),
    writeStreak: () => {},
  });

  const result = await service.toggle({ lessonId: 'g2d3', categoryId: 'grammar' });

  assert.equal(result.done, false);
  assert.equal(result.synced, false);
  assert.deepEqual(queued, [{ lessonId: 'g2d3', categoryId: 'grammar', done: false }]);
});

test('guest completion remains local and does not create a cross-account queue', async () => {
  const queued = [];
  const service = createCompletionService({
    toggleLocal: () => true,
    getCurrentUser: async () => null,
    syncRemote: async () => assert.fail('guest must not call remote'),
    queueMutation: (mutation) => queued.push(mutation),
    writeStreak: () => {},
  });

  const result = await service.toggle({ lessonId: 'v1d1', categoryId: 'vocabulary' });

  assert.deepEqual(result, { done: true, synced: false });
  assert.deepEqual(queued, []);
});
