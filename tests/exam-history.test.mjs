import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeStorage } from './helpers/fake-storage.mjs';
import { createExamHistoryStore, EXAM_HISTORY_STORAGE_KEY } from '../js/exam-history.js';

test('exam evidence cache is bounded, deduplicated and survives reloads', () => {
  const storage = createFakeStorage();
  const first = createExamHistoryStore(storage);
  first.replace([
    { id: 'a', score: { percentage: 70 }, created_at: '2026-08-17T00:00:00Z' },
    { id: 'b', score: { percentage: 80 }, created_at: '2026-08-18T00:00:00Z' },
  ]);
  first.add({ id: 'b', score: { percentage: 85 }, created_at: '2026-08-18T00:00:00Z' });

  const second = createExamHistoryStore(storage);
  assert.equal(second.get().length, 2);
  assert.equal(second.get()[0].score.percentage, 85);
  assert.match(storage.getItem(EXAM_HISTORY_STORAGE_KEY), /"percentage":85/);
});

test('malformed exam cache safely falls back to an empty list', () => {
  const storage = createFakeStorage({ [EXAM_HISTORY_STORAGE_KEY]: '{broken' });
  assert.deepEqual(createExamHistoryStore(storage).get(), []);
});
